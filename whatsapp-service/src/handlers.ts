import { parseMessage, ParsedMessage } from "./parser";
import { DjangoApiClient, isUnknownWhatsAppPhoneResponse } from "./api";
import { loadServiceConfig } from "./config";
import { GeminiError, Interpretation, interpretMessage } from "./gemini";

const { backendBaseUrl: BASE_URL, serviceKey: SERVICE_KEY } = loadServiceConfig();

const onboardingState = new Set<string>();
const processedMessages = new Set<string>();
const registeredPhones = new Set<string>();
const api = new DjangoApiClient(BASE_URL, SERVICE_KEY);

function formatAmount(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatCurrency(amount: number, currency: string): string {
  if (currency === "UGX") return `UGX ${formatAmount(amount)}`;
  return `${formatAmount(amount)} ${currency}`;
}

function correlationId(messageId: string): string {
  return messageId.slice(-8) || "unknown";
}

function trace(messageId: string, stage: string, detail = ""): void {
  console.info(`[FD][${correlationId(messageId)}] ${stage}${detail ? `: ${detail}` : ""}`);
}

function isAcknowledgement(text: string): boolean {
  return /^(ok(?:ay)?|alright|thanks|thank you|got it|understood|cool)[!. ]*$/i.test(text.trim());
}

function getBareNameResponse(text: string): string | null {
  const value = text.trim().replace(/[.,!?]+$/, "").trim();
  if (value.length < 1 || value.length > 100 || value.split(/\s+/).length > 3) return null;
  if (!/^[\p{L}][\p{L}\p{M}' -]*$/u.test(value)) return null;
  if (/^(?:ok(?:ay)?|alright|thanks|thank you|got it|understood|cool|i|how|what|why|when|where|can|could|would|please|help|show|tell|record|spent|paid|received|income|expense)\b/i.test(value)) return null;
  return value;
}

function apiStatus(error: any): number | undefined {
  return Number.isInteger(error?.response?.status) ? error.response.status : undefined;
}

function isUnknownPhone(error: any): boolean {
  return isUnknownWhatsAppPhoneResponse(apiStatus(error), error?.response?.data?.detail);
}

export { onboardingState, processedMessages, registeredPhones, api, formatCurrency };

export async function normalizePhone(from: string): Promise<string> {
  const phone = from.endsWith("@s.whatsapp.net") ? from.slice(0, -"@s.whatsapp.net".length) : from;
  if (!/^\+?\d{7,20}$/.test(phone)) {
    throw new Error("Sender does not have a supported phone-number JID.");
  }
  return phone.replace(/^\+/, "");
}

export async function handleOnboarding(
  phoneNumber: string,
  sendMessage: (to: string, text: string) => Promise<void>
): Promise<void> {
  try {
    console.info("[FD] Onboarding profile lookup started.");
    const registered = await api.resolvePhone(phoneNumber);
    if (registered) {
      registeredPhones.add(phoneNumber);
      console.info("[FD] Onboarding profile found; welcome branch selected.");
      await sendMessage(phoneNumber, "Welcome back! How can I help you today?");
      return;
    }

    onboardingState.add(phoneNumber);
    console.info("[FD] No profile found; awaiting preferred name.");
    await sendMessage(
      phoneNumber,
      "Hello! I'm FD, your personal financial assistant built by Kamate Group Ltd. " +
      'Always know where your money goes.\n\n' +
      "What's your name, or what should I call you?"
    );
  } catch (error: any) {
    console.error(`[FD] Onboarding lookup failed (HTTP ${apiStatus(error) || "network"}); details omitted.`);
    await sendMessage(phoneNumber, "Sorry, I'm having trouble connecting. Please try again later.");
  }
}

export async function handleNameUpdate(
  phoneNumber: string,
  name: string,
  sendMessage: (to: string, text: string) => Promise<void>
): Promise<void> {
  try {
    await api.saveWhatsAppProfile(phoneNumber, name);
    console.info("[FD] Onboarding profile saved successfully.");
    onboardingState.delete(phoneNumber);
    registeredPhones.add(phoneNumber);
    await sendMessage(
      phoneNumber,
      `Nice to meet you, ${name}! You're all set. You can now send me your transactions.`
    );
  } catch (error: any) {
    console.error(`[FD] Profile onboarding failed (HTTP ${apiStatus(error) || "network"}); details omitted.`);
    await sendMessage(phoneNumber, "Sorry, I couldn't finish setting up your profile. Please try again later.");
  }
}

export async function handleTransaction(
  phoneNumber: string,
  parsed: Extract<ParsedMessage, { activity_type: string }>,
  messageId: string,
  sendMessage: (to: string, text: string) => Promise<void>
): Promise<void> {
  try {
    trace(messageId, "Django transaction request started");
    await api.recordTransaction(phoneNumber, {
      description: parsed.description,
      activity_type: parsed.activity_type as "INCOME" | "EXPENSE" | "TRANSFER",
      amount: String(parsed.amount),
      currency: parsed.currency,
      activity_date: parsed.activity_date,
    }, messageId);
    trace(messageId, "Transaction persistence confirmed");
  } catch (error: any) {
    trace(messageId, "Django transaction request failed", `HTTP ${apiStatus(error) || "network"}`);
    if (isUnknownPhone(error)) {
      registeredPhones.delete(phoneNumber);
      onboardingState.add(phoneNumber);
      await sendMessage(phoneNumber, "Your phone number is not registered. Please send 'Hello' to start onboarding.");
    } else if (apiStatus(error) === 401 || apiStatus(error) === 403) {
      await sendMessage(phoneNumber, "FD couldn't authenticate this request. Please try again later.");
    } else if (error.response?.status === 400) {
      await sendMessage(phoneNumber, "I couldn't record that transaction. Please check the details and try again.");
    } else {
      await sendMessage(phoneNumber, "Sorry, I couldn't record that transaction. Please try again later.");
    }
    return;
  }

  try {
    await sendMessage(
      phoneNumber,
      `Recorded: ${formatCurrency(parsed.amount, parsed.currency)} for ${parsed.description}.`
    );
    if (parsed.activity_type === "TRANSFER") {
      await sendMessage(phoneNumber, "Transfers are recorded separately from income and expenses.");
    }
  } catch (error) {
    trace(messageId, "Outbound reply failed after transaction persistence");
    throw error;
  }
}

export async function handleSummary(
  phoneNumber: string,
  parsed: Extract<ParsedMessage, { type: "SUMMARY" }>,
  sendMessage: (to: string, text: string) => Promise<void>
): Promise<void> {
  const today = new Date();
  const startDate = parsed.start_date ||
    new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split("T")[0];
  const endDate = parsed.end_date ||
    new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split("T")[0];

  try {
    const summaries = await api.getSummary(phoneNumber, startDate, endDate);

    if (summaries.length === 0) {
      await sendMessage(phoneNumber, `No transactions recorded between ${startDate} and ${endDate}.`);
      return;
    }

    let message = `Summary for ${startDate} to ${endDate}:\n\n`;
    for (const s of summaries) {
      message += `${s.currency}:\n`;
      message += `  Income: ${formatCurrency(parseFloat(s.income_total), s.currency)} (${s.income_count})\n`;
      message += `  Expenses: ${formatCurrency(parseFloat(s.expense_total), s.currency)} (${s.expense_count})\n`;
      message += `  Net: ${formatCurrency(parseFloat(s.net_cash_flow), s.currency)}\n`;
      if (s.transfer_count > 0) {
        message += `  Transfers: ${s.transfer_count}\n`;
      }
      message += "\n";
    }
    message += "This summary reflects recorded transactions only.";

    await sendMessage(phoneNumber, message);
  } catch (error: any) {
    console.error(`[FD] Summary request failed (HTTP ${apiStatus(error) || "network"}).`);
    if (isUnknownPhone(error)) {
      registeredPhones.delete(phoneNumber);
      onboardingState.add(phoneNumber);
      await sendMessage(phoneNumber, "Your phone number is not registered. Please send 'Hello' to start onboarding.");
    } else if (apiStatus(error) === 401 || apiStatus(error) === 403) {
      await sendMessage(phoneNumber, "FD couldn't authenticate this request. Please try again later.");
    } else {
      await sendMessage(phoneNumber, "Sorry, I couldn't fetch your summary. Please try again later.");
    }
  }
}

export async function dispatchMessage(
  from: string,
  text: string,
  messageId: string,
  sendMessage: (to: string, text: string) => Promise<void>
): Promise<void> {
  if (processedMessages.has(messageId)) {
    trace(messageId, "Duplicate delivery ignored");
    return;
  }
  processedMessages.add(messageId);
  trace(messageId, "Message decrypted and dispatch started");

  const phoneNumber = await normalizePhone(from);
  const lower = text.trim().toLowerCase();
  trace(messageId, "Sender identity normalized");
  const deterministic: ParsedMessage = parseMessage(text);

  if (/^(hello|hi|hey)(\s+fd)?[!. ]*$/.test(lower)) {
    trace(messageId, "Greeting branch selected");
    await handleOnboarding(phoneNumber, sendMessage);
    return;
  }
  if (/^(help|what can you do( for me)?\??|what do you do\??)$/.test(lower)) {
    trace(messageId, "Help branch selected");
    await sendMessage(phoneNumber, "I can record your income and expenses, then show summaries of the transactions you have recorded. Try: 'I spent 15000 UGX on lunch today' or 'How much did I spend this month?' I can't yet assess affordability or give financial advice.");
    return;
  }

  if (onboardingState.has(phoneNumber)) {
    if (deterministic.type === "NAME_UPDATE") {
      trace(messageId, "Onboarding name branch selected");
      await handleNameUpdate(phoneNumber, deterministic.name, sendMessage);
      return;
    }
    if (isAcknowledgement(text)) {
      trace(messageId, "Acknowledgement received while awaiting name");
      await sendMessage(phoneNumber, "No problem. I still need your name before I can finish setting up your profile.");
      return;
    }
    const bareName = getBareNameResponse(text);
    if (bareName && deterministic.type === "AMBIGUOUS") {
      trace(messageId, "Onboarding name branch selected");
      await handleNameUpdate(phoneNumber, bareName, sendMessage);
      return;
    }
    trace(messageId, "Onboarding still awaiting preferred name");
    await sendMessage(phoneNumber, "Before I can help with that, please tell me your name or what I should call you.");
    return;
  }

  if (
    deterministic.type !== "NAME_UPDATE" &&
    !registeredPhones.has(phoneNumber)
  ) {
    try {
      trace(messageId, "Django profile lookup started");
      if (await api.resolvePhone(phoneNumber)) {
        registeredPhones.add(phoneNumber);
        trace(messageId, "Django profile found");
      } else {
        onboardingState.add(phoneNumber);
        trace(messageId, "Django profile not found; onboarding selected");
        await sendMessage(phoneNumber, "Hello! I'm FD, your personal financial assistant built by Kamate Group Ltd. Always know where your money goes.\n\nWhat's your name, or what should I call you?");
        return;
      }
    } catch (error: any) {
      trace(messageId, "Django profile lookup failed", `HTTP ${apiStatus(error) || "network"}`);
      await sendMessage(phoneNumber, "Sorry, I'm having trouble connecting. Please try again later.");
      return;
    }
  }
  if (isAcknowledgement(text)) {
    trace(messageId, "Acknowledgement branch selected");
    await sendMessage(phoneNumber, "You're welcome. Let me know if you'd like to record a transaction or see a summary.");
    return;
  }
  if (deterministic.type !== "AMBIGUOUS") {
    trace(messageId, "Deterministic parser branch selected", deterministic.type);
    await handleParsedMessage(phoneNumber, deterministic, messageId, sendMessage);
    return;
  }

  let interpretation: Interpretation;
  try {
    trace(messageId, "Gemini request started");
    interpretation = await interpretMessage(text, { onboardingNameExpected: onboardingState.has(phoneNumber) });
    trace(messageId, "Gemini interpretation validated", interpretation.intent);
  } catch (error) {
    const kind = error instanceof GeminiError ? error.kind : "unexpected";
    const status = error instanceof GeminiError ? error.status : undefined;
    trace(messageId, "Gemini interpretation failed", `${kind}${status ? ` HTTP ${status}` : ""}`);
    await sendMessage(phoneNumber, "I couldn't interpret that message just now. Try a direct command such as 'I spent 50000 UGX on lunch' or 'show my summary'. If the problem continues, the FD administrator needs to check the language-service setup.");
    return;
  }

  switch (interpretation.intent) {
    case "GREETING":
      await handleOnboarding(phoneNumber, sendMessage);
      break;
    case "HELP":
      await sendMessage(phoneNumber, "I can record your income and expenses, then show summaries of the transactions you have recorded. I can't yet assess affordability or give financial advice.");
      break;
    case "RECORD_EXPENSE":
    case "RECORD_INCOME":
    case "RECORD_TRANSFER": {
      if (!interpretation.amount) {
        await sendMessage(phoneNumber, "How much was the amount?");
        break;
      }
      if (!interpretation.description) {
        await sendMessage(phoneNumber, "What was the payment for?");
        break;
      }
      if (!interpretation.transactionDate) {
        await sendMessage(phoneNumber, "What date should I use for this transaction?");
        break;
      }
      const parsed: ParsedMessage = {
        type: "TRANSACTION",
        activity_type: interpretation.intent === "RECORD_EXPENSE" ? "EXPENSE" :
          interpretation.intent === "RECORD_INCOME" ? "INCOME" : "TRANSFER",
        amount: Number(interpretation.amount),
        currency: interpretation.currency || "UGX",
        description: interpretation.description,
        activity_date: interpretation.transactionDate,
      };
      await handleParsedMessage(phoneNumber, parsed, messageId, sendMessage);
      break;
    }
    case "SUMMARY": {
      if (interpretation.period === "CUSTOM" && (!interpretation.startDate || !interpretation.endDate)) {
        await sendMessage(phoneNumber, "Which start and end dates should I use for the summary?");
        break;
      }
      const parsed: ParsedMessage = {
        type: "SUMMARY",
        period: interpretation.period === "CUSTOM" ? "custom" : "this_month",
        ...(interpretation.period === "CUSTOM" ? { start_date: interpretation.startDate, end_date: interpretation.endDate } : {}),
      };
      trace(messageId, "Django summary branch selected");
      await handleParsedMessage(phoneNumber, parsed, messageId, sendMessage);
      break;
    }
    case "NAME_UPDATE":
      if (!interpretation.name) {
        await sendMessage(phoneNumber, "What's your name, or what should I call you?");
      } else {
        await handleNameUpdate(phoneNumber, interpretation.name, sendMessage);
      }
      break;
    case "AFFORDABILITY":
      await sendMessage(phoneNumber, "I can't assess affordability yet because FD has no budget or affordability feature. I can show summaries of transactions you've recorded.");
      break;
    case "CLARIFICATION":
      await sendMessage(phoneNumber, clarificationPrompt(interpretation.missingInformation));
      break;
    case "UNSUPPORTED":
      await sendMessage(phoneNumber, "I can record income and expenses and show summaries. That request isn't supported yet.");
      break;
  }
}

function clarificationPrompt(missing: Interpretation["missingInformation"]): string {
  switch (missing) {
    case "AMOUNT": return "How much was the amount?";
    case "DESCRIPTION": return "What was the payment for?";
    case "DATE": return "What date should I use?";
    case "NAME": return "What's your name, or what should I call you?";
    default: return "Was this money received or spent? Please include the amount and what it was for.";
  }
}

async function handleParsedMessage(
  phoneNumber: string,
  parsed: ParsedMessage,
  messageId: string,
  sendMessage: (to: string, text: string) => Promise<void>,
): Promise<void> {
  switch (parsed.type) {
    case "ONBOARDING_REQUEST":
      await handleOnboarding(phoneNumber, sendMessage);
      break;
    case "NAME_UPDATE":
      await handleNameUpdate(phoneNumber, parsed.name, sendMessage);
      break;
    case "SUMMARY":
      await handleSummary(phoneNumber, parsed, sendMessage);
      break;
    case "AMBIGUOUS":
      await sendMessage(phoneNumber, parsed.question);
      break;
    case "UNSUPPORTED":
      await sendMessage(phoneNumber, parsed.reason);
      break;
    case "TRANSACTION":
      await handleTransaction(phoneNumber, parsed, messageId, sendMessage);
      break;
  }
}
