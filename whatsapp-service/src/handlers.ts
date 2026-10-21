import { parseMessage, ParsedMessage } from "./parser";
import { DjangoApiClient } from "./api";
import { loadServiceConfig } from "./config";

const { backendBaseUrl: BASE_URL, serviceKey: SERVICE_KEY } = loadServiceConfig();

const onboardingState = new Set<string>();
const processedMessages = new Set<string>();
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

export { onboardingState, processedMessages, api, formatCurrency };

export async function normalizePhone(from: string): Promise<string> {
  return from.replace("@s.whatsapp.net", "");
}

export async function handleOnboarding(
  phoneNumber: string,
  sendMessage: (to: string, text: string) => Promise<void>
): Promise<void> {
  try {
    const registered = await api.resolvePhone(phoneNumber);
    if (registered) {
      await sendMessage(phoneNumber, "Welcome back! How can I help you today?");
      return;
    }

    onboardingState.add(phoneNumber);
    await sendMessage(
      phoneNumber,
      "Hello! I'm FD, your personal financial assistant built by Kamate Group Ltd. " +
      'Always know where your money goes.\n\n' +
      "What's your name, or what should I call you?"
    );
  } catch (error: any) {
    console.error("Onboarding check failed:", error.message);
    await sendMessage(phoneNumber, "Sorry, I'm having trouble connecting. Please try again later.");
  }
}

export async function handleNameUpdate(
  phoneNumber: string,
  name: string,
  sendMessage: (to: string, text: string) => Promise<void>
): Promise<void> {
  onboardingState.delete(phoneNumber);
  await sendMessage(
    phoneNumber,
    `Nice to meet you, ${name}! You're all set. You can now send me your transactions.`
  );
}

export async function handleTransaction(
  phoneNumber: string,
  parsed: Extract<ParsedMessage, { activity_type: string }>,
  sendMessage: (to: string, text: string) => Promise<void>
): Promise<void> {
  try {
    await api.recordTransaction(phoneNumber, {
      description: parsed.description,
      activity_type: parsed.activity_type as "INCOME" | "EXPENSE" | "TRANSFER",
      amount: String(parsed.amount),
      currency: parsed.currency,
      activity_date: parsed.activity_date,
    });

    await sendMessage(
      phoneNumber,
      `Recorded: ${formatCurrency(parsed.amount, parsed.currency)} for ${parsed.description}.`
    );

    if (parsed.activity_type === "TRANSFER") {
      await sendMessage(
        phoneNumber,
        "Transfers are recorded separately from income and expenses."
      );
    }
  } catch (error: any) {
    console.error("Transaction recording failed:", error.message);
    if (error.response?.status === 401 || error.response?.status === 403) {
      await sendMessage(phoneNumber, "Your phone number is not registered. Please send 'Hello' to start onboarding.");
    } else if (error.response?.status === 400) {
      await sendMessage(phoneNumber, "I couldn't record that transaction. Please check the details and try again.");
    } else {
      await sendMessage(phoneNumber, "Sorry, I couldn't record that transaction. Please try again later.");
    }
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
    console.error("Summary fetch failed:", error.message);
    if (error.response?.status === 401 || error.response?.status === 403) {
      await sendMessage(phoneNumber, "Your phone number is not registered. Please send 'Hello' to start onboarding.");
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
  if (processedMessages.has(messageId)) return;
  processedMessages.add(messageId);

  const phoneNumber = await normalizePhone(from);
  const parsed: ParsedMessage = parseMessage(text);

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
      await handleTransaction(phoneNumber, parsed, sendMessage);
      break;
  }
}