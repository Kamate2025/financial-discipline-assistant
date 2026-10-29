import { parseMessage, ParsedMessage } from "./parser";
import { DjangoApiClient, isUnknownWhatsAppPhoneResponse, OnboardingStatus } from "./api";
import { loadServiceConfig } from "./config";
import { LanguageModelError, Interpretation, interpretMessage } from "./groq";

const { backendBaseUrl: BASE_URL, serviceKey: SERVICE_KEY } = loadServiceConfig();

const onboardingState = new Set<string>();
const processedMessages = new Set<string>();
const registeredPhones = new Set<string>();
const profileStatusCache = new Map<string, { expiresAt: number; profile: OnboardingStatus }>();
const PROFILE_STATUS_CACHE_MS = 60_000;
const api = new DjangoApiClient(BASE_URL, SERVICE_KEY);

async function getOnboardingStatus(phoneNumber: string): Promise<OnboardingStatus> {
  const cached = profileStatusCache.get(phoneNumber);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;
  profileStatusCache.delete(phoneNumber);
  const profile = await api.getOnboardingStatus(phoneNumber);
  profileStatusCache.set(phoneNumber, { profile, expiresAt: Date.now() + PROFILE_STATUS_CACHE_MS });
  return profile;
}

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
  console.info(`[FinTrack][${correlationId(messageId)}] ${stage}${detail ? `: ${detail}` : ""}`);
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

export { onboardingState, processedMessages, registeredPhones, profileStatusCache, api, formatCurrency };

async function sendMenu(phone: string, send: (to: string, text: string) => Promise<void>): Promise<void> {
  await send(phone, "FinTrack menu (text options):\n1. Today's summary — ‘summary today’\n2. This month's summary — ‘summary this month’\n3. Record a transaction — ‘I spent 15k on lunch’\n4. Spending insights — ‘where does most of my money go?’\n5. Help — ‘help me use FinTrack’\n\nYou can also ask in your own words. Reply with a request; these are not clickable buttons.");
}

function privacyMessage(): string {
  return "FinTrack stores the transaction details you choose to send (such as descriptions, amounts, currencies, and dates) so it can show your own summaries and insights. FinTrack does not read bank or mobile money accounts. Ask ‘show my menu’ or ‘show my summary’ to review your records. To permanently delete your FinTrack account and saved records, say ‘delete my FinTrack account’; FinTrack will ask you to confirm. You can ask for human help at https://wa.me/256787360381.";
}

function supportMessage(): string {
  return "For human support or troubleshooting, contact Kamate Group Ltd on WhatsApp: https://wa.me/256787360381";
}

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
    console.info("[FinTrack] Onboarding profile lookup started.");
    const profile = await getOnboardingStatus(phoneNumber);
    if (profile.registered && profile.needs_name) {
      registeredPhones.add(phoneNumber);
      onboardingState.add(phoneNumber);
      await sendMessage(phoneNumber, "Welcome back! What name should I use for you?");
      return;
    }
    if (profile.registered && profile.needs_country) {
      registeredPhones.add(phoneNumber);
      await promptCountry(phoneNumber, sendMessage);
      return;
    }
    if (profile.registered) {
      registeredPhones.add(phoneNumber);
      console.info("[FinTrack] Onboarding profile found; welcome branch selected.");
      await sendMessage(phoneNumber, `Welcome back${profile.preferred_name ? `, ${profile.preferred_name}` : ""}! How can I help you today?`);
      return;
    }

    onboardingState.add(phoneNumber);
    console.info("[FinTrack] No profile found; awaiting preferred name.");
    await sendMessage(
      phoneNumber,
      "Welcome to FinTrack, your personal finance assistant by Kamate Group Ltd. I help you record personal income and expenses, track what your money was for, and view summaries through WhatsApp.\n\n" +
      "For example: ‘I spent 15,000 UGX on lunch today’ or ‘Show my summary for this month.’\n\n" +
      "Say ‘show my menu’ any time to see your options. What's your name, or what should I call you?"
    );
  } catch (error: any) {
    console.error(`[FinTrack] Onboarding lookup failed (HTTP ${apiStatus(error) || "network"}); details omitted.`);
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
    profileStatusCache.delete(phoneNumber);
    console.info("[FinTrack] Onboarding profile saved successfully.");
    onboardingState.delete(phoneNumber);
    registeredPhones.add(phoneNumber);
    const profile = await getOnboardingStatus(phoneNumber);
    if (profile.needs_country) {
      await sendMessage(phoneNumber, `Nice to meet you, ${name}!`);
      await promptCountry(phoneNumber, sendMessage);
    } else {
      await sendMessage(phoneNumber, `Nice to meet you, ${name}! You're all set. Record your first transaction, for example: ‘I spent 15,000 UGX on lunch today.’ Say ‘show my menu’ to see your options.`);
    }
  } catch (error: any) {
    console.error(`[FinTrack] Profile onboarding failed (HTTP ${apiStatus(error) || "network"}); details omitted.`);
    await sendMessage(phoneNumber, "Sorry, I couldn't finish setting up your profile. Please try again later.");
  }
}

async function promptCountry(
  phoneNumber: string,
  sendMessage: (to: string, text: string) => Promise<void>,
): Promise<void> {
  const countries = await api.getActiveCountries();
  if (countries.length === 0) {
    await sendMessage(phoneNumber, "Country selection is temporarily unavailable. Your name is saved; please try again later.");
    return;
  }
  const choices = countries.map((country, index) =>
    `${index + 1}. ${country.name} (${country.currency_code} — ${country.currency_name})`
  ).join("\n");
  await sendMessage(phoneNumber, `Which country should I use for your FinTrack account? Reply with its number or name.\n\n${choices}`);
}

async function handleCountrySelection(
  phoneNumber: string,
  text: string,
  sendMessage: (to: string, text: string) => Promise<void>,
): Promise<void> {
  try {
    const countries = await api.getActiveCountries();
    const answer = text.trim().toLocaleLowerCase();
    const numbered = /^\d+$/.test(answer) ? countries[Number(answer) - 1] : undefined;
    const selected = numbered || countries.find((country) =>
      country.name.toLocaleLowerCase() === answer || country.country_code.toLocaleLowerCase() === answer
    );
    if (!selected) {
      await promptCountry(phoneNumber, sendMessage);
      return;
    }
    await api.saveWhatsAppCountry(phoneNumber, selected.country_code);
    profileStatusCache.delete(phoneNumber);
    registeredPhones.add(phoneNumber);
    await sendMessage(phoneNumber, `You're all set with ${selected.currency_code}! Record your first transaction, for example: ‘I spent 15,000 ${selected.currency_code} on lunch today.’ Say ‘show my menu’ to see your options.`);
  } catch (error: any) {
    console.error(`[FinTrack] Country selection failed (HTTP ${apiStatus(error) || "network"}); details omitted.`);
    await sendMessage(phoneNumber, "Sorry, I couldn't save your country just now. Your name is safe. Please try selecting your country again.");
  }
}

export async function handleTransaction(
  phoneNumber: string,
  parsed: Extract<ParsedMessage, { activity_type: string }>,
  messageId: string,
  sendMessage: (to: string, text: string) => Promise<void>
): Promise<boolean> {
  try {
    trace(messageId, "Django transaction request started");
    await api.recordTransaction(phoneNumber, {
      description: parsed.description,
      activity_type: parsed.activity_type as "INCOME" | "EXPENSE" | "TRANSFER",
      category: parsed.category || "",
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
      await sendMessage(phoneNumber, "FinTrack couldn't authenticate this request. Please try again later.");
    } else if (error.response?.status === 400) {
      await sendMessage(phoneNumber, "I couldn't record that transaction. Please check the details and try again.");
    } else {
      await sendMessage(phoneNumber, "Sorry, I couldn't record that transaction. Please try again later.");
    }
    return false;
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
  return true;
}

export async function handleSummary(
  phoneNumber: string,
  parsed: Extract<ParsedMessage, { type: "SUMMARY" }>,
  sendMessage: (to: string, text: string) => Promise<void>,
  timeZone = "Africa/Kampala",
): Promise<void> {
  const today = zonedDate(new Date(), timeZone);
  const [year, month] = today.split("-").map(Number);
  const startDate = parsed.start_date || `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = parsed.end_date || `${year}-${String(month).padStart(2, "0")}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  await handleFinancialQuestion(phoneNumber, {
    intent: "SUMMARY", statementStatus: "QUESTION", confidence: "HIGH", transactionType: "", amount: "", previousAmount: "",
    currency: "", description: "", category: "", transactionDate: "", period: "CUSTOM", startDate, endDate,
    compareStartDate: "", compareEndDate: "", name: "", searchQuery: "", fieldsToChange: [], missingInformation: "NONE",
    transactions: [],
  }, sendMessage, timeZone);
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
  let preferredCurrency = "UGX";
  let timeZone = "Africa/Kampala";
  let preferredName = "";
  let deterministic: ParsedMessage = parseMessage(text, preferredCurrency, timeZone);

  if (/^(hello|hi|hey)(\s+fd|\s+fintrack)?[!. ]*$/.test(lower) && !registeredPhones.has(phoneNumber)) {
    trace(messageId, "Greeting branch selected");
    await handleOnboarding(phoneNumber, sendMessage);
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

  if (deterministic.type !== "NAME_UPDATE" && !registeredPhones.has(phoneNumber)) {
    try {
      trace(messageId, "Django profile lookup started");
      if (await api.resolvePhone(phoneNumber)) {
        registeredPhones.add(phoneNumber);
        trace(messageId, "Django profile found");
      } else {
        onboardingState.add(phoneNumber);
        trace(messageId, "Django profile not found; onboarding selected");
        await handleOnboarding(phoneNumber, sendMessage);
        return;
      }
    } catch (error: any) {
      trace(messageId, "Django profile lookup failed", `HTTP ${apiStatus(error) || "network"}`);
      await sendMessage(phoneNumber, "Sorry, I'm having trouble connecting. Please try again later.");
      return;
    }
  }
  if (registeredPhones.has(phoneNumber)) {
    try {
      const profile = await getOnboardingStatus(phoneNumber);
      if (profile.registered && profile.needs_name) {
        onboardingState.add(phoneNumber);
        await sendMessage(phoneNumber, "What name should I use for you?");
        return;
      }
      if (profile.registered && profile.needs_country) {
        const asksBeforeCountry = /\b(?:summary|spending|income|expense|help|menu|options|privacy|who am i|my name|what can you do|support|delete my account|hello|hi|hey)\b/.test(lower);
        if (!asksBeforeCountry) {
          await handleCountrySelection(phoneNumber, text, sendMessage);
          return;
        }
      }
      if (!profile.registered) {
        registeredPhones.delete(phoneNumber);
        onboardingState.add(phoneNumber);
        await handleOnboarding(phoneNumber, sendMessage);
        return;
      }
      if (/\b(?:what(?:'s| is) my name|remind me (?:of )?my name|what name do you have for me)\b/.test(lower)) {
        await sendMessage(phoneNumber, profile.preferred_name ? `Your saved name is ${profile.preferred_name}.` : "I don't have your name yet. What should I call you?");
        return;
      }
      preferredCurrency = profile.currency_code || "UGX";
      timeZone = profile.time_zone || "Africa/Kampala";
      preferredName = profile.preferred_name || "";
      deterministic = parseMessage(text, preferredCurrency, timeZone);
    } catch (error: any) {
      trace(messageId, "Onboarding status lookup failed", `HTTP ${apiStatus(error) || "network"}`);
      await sendMessage(phoneNumber, "Sorry, I'm having trouble connecting. Please try again later.");
      return;
    }
  }
  if (/^(hello|hi|hey)(\s+fd|\s+fintrack)?[!. ]*$/.test(lower)) {
    await handleOnboarding(phoneNumber, sendMessage);
    return;
  }
  if (deterministic.type === "NAME_UPDATE") {
    await handleNameUpdate(phoneNumber, deterministic.name, sendMessage);
    return;
  }
  if (/\b(?:my )?(?:earning|earnings|income)(?: only)?\b/.test(lower)
    && /\b(?:this month|for this month|month)\b/.test(lower)) {
    await handleFinancialQuestion(phoneNumber, financialQuestion("INCOME_BREAKDOWN", "THIS_MONTH"), sendMessage, timeZone);
    return;
  }
  if (/\b(?:who (?:built|made|created) you|who is fintrack|what is fintrack|what does fintrack do|who is fd|what is fd|what does fd do)\b/.test(lower)) {
    await sendMessage(phoneNumber, "FinTrack is a personal finance assistant built by Kamate Group Ltd. It helps you record financial activity and review summaries from your saved records.");
    return;
  }
  if (/^(?:delete|erase|remove) my (?:fd )?(?:account|data)$/.test(lower)) {
    let priorPending: any = null;
    try {
      priorPending = await api.getPendingAction(phoneNumber);
    } catch (error: any) {
      trace(messageId, "Pending action lookup failed", `HTTP ${apiStatus(error) || "network"}`);
      await sendMessage(phoneNumber, "Sorry, I couldn't continue safely just now. Please try again shortly.");
      return;
    }
    if (priorPending?.action_type === "ACCOUNT_DELETE_CONFIRM") {
      await handlePendingAction(phoneNumber, priorPending, text, messageId, sendMessage, preferredCurrency, timeZone);
    } else {
      await saveAndAsk(phoneNumber, "ACCOUNT_DELETE_CONFIRM", {}, messageId, "This permanently deletes your FinTrack account, profile, and saved financial records. Reply ‘delete my account’ to confirm, or ‘cancel’ to keep your data.", sendMessage);
    }
    return;
  }
  if (/^(show( me)? (my )?(menu|options)|menu|options|what can you do( for me)?\??|what do you do\??)$/.test(lower)) {
    await sendMenu(phoneNumber, sendMessage);
    return;
  }
  if (/^(privacy|privacy policy|what data do you store|what do you know about me|do you read my bank|do you access my (bank|mobile money).*)\??$/.test(lower)) {
    await sendMessage(phoneNumber, privacyMessage());
    return;
  }
  if (/^(?:support|help from a person)$/.test(lower) || /\b(?:human support|contact support|talk to (?:a )?human|customer support|troubleshoot(?:ing)?|technical help|not (?:picking|answering) my calls)\b/.test(lower)) {
    await sendMessage(phoneNumber, supportMessage());
    return;
  }
  if (/\b(?:delete|erase|remove) (?:my )?(?:fd )?(?:account|data|records)\b/.test(lower)) {
    await saveAndAsk(phoneNumber, "ACCOUNT_DELETE_CONFIRM", {}, messageId, "This permanently deletes your FinTrack account, profile, and saved financial records. Reply ‘delete my account’ to confirm, or ‘cancel’ to keep your data.", sendMessage);
    return;
  }
  if (/^(help|help me(?: use (?:fd|fintrack))?|support|instructions|how do i use (?:fd|fintrack)|how to use (?:fd|fintrack))\??$/.test(lower)) {
    trace(messageId, "Help branch selected");
    await sendMessage(phoneNumber, "To record something that happened, say ‘I spent 15k on lunch’ or ‘I received 500k salary’. Ask ‘summary today’, ‘show my spending this month’, ‘what did I buy on 15 October?’, or ‘where does most of my money go?’ You can correct or delete a record too; FinTrack asks before changing or deleting it. Say ‘show my menu’ for options. For a person, say ‘human support’." );
    return;
  }
  const menuOption = lower.match(/^(?:option\s*)?([1-5])(?:\s+(?:in|from)\s+(?:the\s+)?menu)?[!. ]*$/);
  if (menuOption) {
    const option = Number(menuOption[1]);
    if (option === 1) { await handleFinancialQuestion(phoneNumber, financialQuestion("SUMMARY", "TODAY"), sendMessage, timeZone); return; }
    if (option === 2) { await handleFinancialQuestion(phoneNumber, financialQuestion("SUMMARY", "THIS_MONTH"), sendMessage, timeZone); return; }
    if (option === 3) { await sendMessage(phoneNumber, "Tell me what happened, the amount, and what it was for—for example, ‘I spent 15k on lunch today.’"); return; }
    if (option === 4) { await handleFinancialQuestion(phoneNumber, financialQuestion("FINANCIAL_INSIGHTS", "THIS_MONTH"), sendMessage, timeZone); return; }
    await sendMessage(phoneNumber, "Tell me what you need help with, or say ‘human support’ to contact Kamate Group Ltd."); return;
  }
  if (isAcknowledgement(text)) {
    trace(messageId, "Acknowledgement branch selected");
    await sendMessage(phoneNumber, "You're welcome. Let me know if you'd like to record a transaction or see a summary.");
    return;
  }
  if (deterministic.type === "SUMMARY") {
    trace(messageId, "Deterministic parser branch selected", deterministic.type);
    await handleSummary(phoneNumber, deterministic, sendMessage, timeZone);
    return;
  }
  if (deterministic.type === "UNSUPPORTED") {
    await sendMessage(phoneNumber, deterministic.reason);
    return;
  }
  const hasClearTransactionCommand = /^(?:(?:\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|\d{4}-\d{2}-\d{2})\s+)?(?:i\s+)?(?:spent|paid|bought|received|earned|record)\b/i.test(text.trim());
  if (deterministic.type === "TRANSACTION" && hasClearTransactionCommand) {
    trace(messageId, "Deterministic transaction branch selected", deterministic.activity_type);
    await handleTransaction(phoneNumber, deterministic, messageId, sendMessage);
    return;
  }

  let pending: any = null;
  try {
    pending = await api.getPendingAction(phoneNumber);
  } catch (error: any) {
    trace(messageId, "Pending action lookup failed", `HTTP ${apiStatus(error) || "network"}`);
    await sendMessage(phoneNumber, "Sorry, I couldn't continue safely just now. Please try again shortly.");
    return;
  }

  if (pending?.action_type === "ACCOUNT_DELETE_CONFIRM" && /^(?:delete|erase|remove) my (?:fd )?(?:account|data)$/.test(lower)) {
    await handlePendingAction(phoneNumber, pending, text, messageId, sendMessage, preferredCurrency, timeZone);
    return;
  }
  if (pending?.action_type === "TRANSACTION" && Array.isArray(pending.payload?.multiEvents) && /^(?:retry|try again|finish)$/.test(lower)) {
    await recordMultipleTransactions(phoneNumber, pending.payload.multiEvents, pending.payload.sourceMessageId || pending.original_message_id || messageId, sendMessage, preferredCurrency, timeZone, pending, messageId);
    return;
  }
  if (pending?.action_type === "CORRECTION_SELECT" && /^\d+$/.test(lower)) {
    await handlePendingAction(phoneNumber, pending, text, messageId, sendMessage, preferredCurrency, timeZone);
    return;
  }
  if (pending && ["cancel", "never mind", "nevermind", "nope", "ignore it", "ignore that", "stop", "not now"].includes(lower)) {
    await api.clearPendingAction(phoneNumber);
    await sendMessage(phoneNumber, "Cancelled. Nothing was changed.");
    return;
  }
  if (pending && /^(?:yes|confirm|confirmed|yep|no)$/.test(lower)
    && ["DELETE_CONFIRM", "UNDO_CONFIRM", "ACCOUNT_DELETE_CONFIRM", "CORRECTION"].includes(pending.action_type)) {
    await handlePendingAction(phoneNumber, pending, text, messageId, sendMessage, preferredCurrency, timeZone);
    return;
  }

  let interpretation: Interpretation;
  try {
    trace(messageId, "Language model request started");
    const recentTransactions = /\b(?:she|he|they|that|it|loan|lent|borrow|paid back|repay|correct|change it)\b/i.test(text)
      ? (await api.getTransactions(phoneNumber, "", true)).slice(0, 5).map(({ activity_type, amount, currency, description, activity_date }) => ({ activity_type, amount, currency, description, activity_date }))
      : [];
    interpretation = await interpretMessage(text, {
      preferredCurrency,
      timeZone,
      profileName: preferredName,
      pendingContext: pending ? { action_type: pending.action_type, payload: pending.payload } : undefined,
      recentTransactions,
    });
    trace(messageId, "Language model interpretation validated", interpretation.intent);
  } catch (error) {
    const kind = error instanceof LanguageModelError ? error.kind : "unexpected";
    const status = error instanceof LanguageModelError ? error.status : undefined;
    trace(messageId, "Language model interpretation failed", `${kind}${status ? ` HTTP ${status}` : ""}`);
    if (deterministic.type === "AMBIGUOUS" && deterministic.pendingTransaction) {
      try {
        await api.savePendingAction(phoneNumber, "TRANSACTION", deterministic.pendingTransaction, messageId);
        await sendMessage(phoneNumber, deterministic.question);
      } catch (pendingError: any) {
        trace(messageId, "Could not persist safe clarification", `HTTP ${apiStatus(pendingError) || "network"}`);
        await sendMessage(phoneNumber, "I couldn't safely save the details for clarification. Please try again shortly.");
      }
      return;
    }
    if (deterministic.type === "AMBIGUOUS" && deterministic.question) {
      await sendMessage(phoneNumber, deterministic.question);
      return;
    }
    if (kind === "configuration" || kind === "authentication" || kind === "model") {
      await sendMessage(phoneNumber, "I can't interpret messages right now because the language service is unavailable. Please try again later; FinTrack's administrator may need to check its configuration.");
    } else if (kind === "response") {
      await sendMessage(phoneNumber, "I couldn't safely understand that message. Please rephrase it with what happened, the amount, and what it was for.");
    } else {
      await sendMessage(phoneNumber, "I couldn't reach the language service just now. Nothing was recorded; please try again shortly.");
    }
    return;
  }
  if (pending && pending.action_type === "TRANSACTION"
    && ["RECORD_EXPENSE", "RECORD_INCOME", "RECORD_REFUND", "RECORD_LOAN_RECEIVED", "RECORD_LOAN_REPAYMENT", "RECORD_LOAN_GIVEN", "RECORD_LOAN_REPAYMENT_RECEIVED", "RECORD_GIFT_RECEIVED", "RECORD_ASSET_SALE", "MULTI_TRANSACTION", "CLARIFICATION"].includes(interpretation.intent)) {
    await continuePendingTransaction(phoneNumber, pending, interpretation, messageId, sendMessage, preferredCurrency, timeZone);
    return;
  }
  if (pending && ["CORRECTION", "CORRECTION_SELECT"].includes(pending.action_type)
    && ["CLARIFICATION", "CORRECT_TRANSACTION", "DELETE_TRANSACTION"].includes(interpretation.intent)) {
    await handlePendingAction(phoneNumber, pending, text, messageId, sendMessage, preferredCurrency, timeZone);
    return;
  }
  await routeInterpretation(phoneNumber, interpretation, text, messageId, sendMessage, preferredCurrency, timeZone);
}

async function continuePendingTransaction(phone: string, pending: any, item: Interpretation, messageId: string, send: (to: string, text: string) => Promise<void>, currency: string, timeZone: string): Promise<void> {
  if (Array.isArray(pending.payload?.multiEvents)) {
    await recordMultipleTransactions(phone, pending.payload.multiEvents, pending.payload.sourceMessageId || pending.original_message_id || messageId, send, currency, timeZone, pending, messageId);
    return;
  }
  const merged = { ...pending.payload };
  if (item.amount) merged.amount = item.amount;
  if (item.description) merged.description = item.description;
  if (item.currency) merged.currency = item.currency;
  if (item.transactionType) merged.activity_type = item.transactionType;
  if (item.transactionDate) merged.activity_date = item.transactionDate;
  if (merged.amount && merged.description && merged.activity_type) {
    merged.currency ||= currency;
    merged.activity_date ||= zonedDate(new Date(), timeZone);
    const saved = await handleTransaction(phone, { type: "TRANSACTION", ...merged } as any, messageId, send);
    if (saved) await api.clearPendingAction(phone);
  } else {
    await api.savePendingAction(phone, "TRANSACTION", merged, pending.original_message_id || messageId);
    await send(phone, clarificationPrompt(!merged.amount ? "AMOUNT" : !merged.description ? "DESCRIPTION" : "TRANSACTION_TYPE"));
  }
}

async function recordMultipleTransactions(phone: string, events: any[], sourceMessageId: string, send: (to: string, text: string) => Promise<void>, currency: string, timeZone: string, pending?: any, replyMessageId = sourceMessageId): Promise<void> {
  let saved = 0;
  for (let i = 0; i < events.length; i += 1) {
    const tx = events[i];
    const ok = await handleTransaction(phone, { type: "TRANSACTION", description: tx.description, activity_type: tx.transactionType, category: tx.category, amount: Number(tx.amount), currency: tx.currency || currency, activity_date: tx.transactionDate || zonedDate(new Date(), timeZone) } as any, `${sourceMessageId}:${i + 1}`, async () => {});
    if (!ok) break;
    saved += 1;
  }
  if (saved === events.length) {
    if (pending) await api.clearPendingAction(phone);
    await send(phone, `Recorded ${saved} transactions from your message.`);
  } else {
    await api.savePendingAction(phone, "TRANSACTION", { multiEvents: events, sourceMessageId }, pending?.original_message_id || replyMessageId);
    await send(phone, `I saved ${saved} of ${events.length} transactions. Some records may already be saved safely. Reply retry to finish or cancel.`);
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

function zonedDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDateDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function financialQuestion(intent: Interpretation["intent"], period: Interpretation["period"] = "UNSPECIFIED"): Interpretation {
  return { intent, statementStatus: "QUESTION", confidence: "HIGH", transactionType: "", amount: "", previousAmount: "", currency: "", description: "", category: "", transactionDate: "", period, startDate: "", endDate: "", compareStartDate: "", compareEndDate: "", name: "", searchQuery: "", fieldsToChange: [], missingInformation: "NONE", transactions: [] };
}

function monthBounds(year: number, monthIndex: number): [string, string] {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)];
}

function previousEquivalentRange(start: string, end: string): [string, string] {
  const startDay = new Date(`${start}T00:00:00Z`);
  const endDay = new Date(`${end}T00:00:00Z`);
  const length = Math.round((endDay.valueOf() - startDay.valueOf()) / 86400000) + 1;
  return [addDateDays(start, -length), addDateDays(start, -1)];
}

async function handleFinancialQuestion(phone: string, item: Interpretation, send: (to: string, text: string) => Promise<void>, timeZone: string): Promise<void> {
  const today = zonedDate(new Date(), timeZone);
  const [year, month] = today.split("-").map(Number);
  if (Boolean(item.startDate) !== Boolean(item.endDate)) {
    await send(phone, "Which start and end dates should I use? Please provide both dates."); return;
  }
  let [start, end] = item.startDate && item.endDate ? [item.startDate, item.endDate] : monthBounds(year, month - 1);
  if (item.period === "TODAY") start = end = today;
  else if (item.period === "YESTERDAY") start = end = addDateDays(today, -1);
  else if (item.period === "LAST_WEEK") {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const monday = addDateDays(today, weekday === 0 ? -6 : 1 - weekday);
    start = addDateDays(monday, -7); end = addDateDays(monday, -1);
  } else if (item.period === "LAST_MONTH") {
    const bounds = monthBounds(year, month - 2); start = bounds[0]; end = bounds[1];
  } else if (item.transactionDate && !item.startDate && !item.endDate) start = end = item.transactionDate;
  if (start > end) { await send(phone, "That date range ends before it starts. Please provide the dates again in chronological order."); return; }

  let compareStart = item.compareStartDate;
  let compareEnd = item.compareEndDate;
  if (item.intent === "COMPARE_PERIODS" && (!compareStart || !compareEnd)) [compareStart, compareEnd] = previousEquivalentRange(start, end);
  const insights = ["SUMMARY", "SPENDING_BREAKDOWN", "LARGEST_EXPENSES", "INCOME_VS_EXPENSES", "INCOME_BREAKDOWN", "COMPARE_PERIODS", "SPENDING_TREND", "CATEGORY_TRENDS", "FINANCIAL_INSIGHTS", "TRANSACTION_LOOKUP"].includes(item.intent);
  if (!insights) { await send(phone, "I couldn't identify the financial question. Try asking for a date, period, category, or description."); return; }
  try {
    const data = await api.getFinancialInsights(phone, {
      start_date: start, end_date: end,
      ...(compareStart && compareEnd ? { compare_start_date: compareStart, compare_end_date: compareEnd } : {}),
      ...(item.searchQuery ? { search: item.searchQuery } : {}),
      ...(item.category ? { category: item.category } : {}),
    });
    const intentTitles: Record<string, string> = {
      SUMMARY: "Summary", SPENDING_BREAKDOWN: "Spending by Category", LARGEST_EXPENSES: "Largest Expenses",
      INCOME_VS_EXPENSES: "Income and Expenses", COMPARE_PERIODS: "Period Comparison", SPENDING_TREND: "Spending Trend",
      INCOME_BREAKDOWN: "Income This Month",
      CATEGORY_TRENDS: "Category Trends", FINANCIAL_INSIGHTS: "Spending Insights", TRANSACTION_LOOKUP: "Matching Transactions",
    };
    const periodLabel = (value: string): string => new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    const rangeLabel = start === end ? periodLabel(start) : `${periodLabel(start)} – ${periodLabel(end)}`;
    const lines = [`*FinTrack | ${intentTitles[item.intent] || "Finance"}*`, `_${rangeLabel}_`, "━━━━━━━━━━━━━━"];
    if (data.transaction_count === 0 && item.intent !== "INCOME_BREAKDOWN") lines.push(`No matching transactions were recorded for ${rangeLabel}.`);
    if (item.intent === "INCOME_BREAKDOWN" && !(data.currencies || []).length) lines.push("No earned income was recorded for this period.");
    for (const row of data.currencies || []) {
      lines.push(`*${row.currency}*`);
      if (item.intent === "INCOME_BREAKDOWN") {
        lines.push(Number(row.income_total)
          ? `Earned income recorded: ${formatCurrency(Number(row.income_total), row.currency)}`
          : "No earned income was recorded for this period.");
        continue;
      }
      if (Number(row.income_total)) lines.push(`💰 Income: ${formatCurrency(Number(row.income_total), row.currency)}`);
      if (Number(row.expense_total)) lines.push(`💸 Expenses: ${formatCurrency(Number(row.expense_total), row.currency)}`);
      if (Number(row.refund_total)) lines.push(`↩️ Refunds: ${formatCurrency(Number(row.refund_total), row.currency)}`);
      if (Number(row.loan_received_total)) lines.push(`🤝 Loans received: ${formatCurrency(Number(row.loan_received_total), row.currency)}`);
      if (Number(row.loan_repayment_total)) lines.push(`📤 Loan repayments: ${formatCurrency(Number(row.loan_repayment_total), row.currency)}`);
      if (Number(row.transfer_count)) lines.push(`Transfers recorded: ${row.transfer_count}`);
      if (["SUMMARY", "INCOME_VS_EXPENSES", "FINANCIAL_INSIGHTS"].includes(item.intent) && (Number(row.net_cash_flow) !== 0 || Number(row.income_total) || Number(row.expense_total) || Number(row.refund_total) || Number(row.loan_received_total) || Number(row.loan_repayment_total))) {
        lines.push(`📊 Net cash flow: ${formatCurrency(Number(row.net_cash_flow), row.currency)}`);
      }
      if (["SPENDING_BREAKDOWN", "FINANCIAL_INSIGHTS", "CATEGORY_TRENDS"].includes(item.intent) && row.category_breakdown?.length) {
        lines.push("*Spending by category*");
        for (const category of row.category_breakdown) if (Number(category.expense_total)) lines.push(`• ${category.category}: ${formatCurrency(Number(category.expense_total), row.currency)}`);
        if (["SPENDING_BREAKDOWN", "FINANCIAL_INSIGHTS"].includes(item.intent)) lines.push(`Your highest recorded expense category is ${row.category_breakdown[0].category} at ${formatCurrency(Number(row.category_breakdown[0].expense_total), row.currency)}. Reviewing those recorded expenses may help you decide where to adjust; FinTrack cannot guarantee savings.`);
      }
      if (item.intent === "INCOME_VS_EXPENSES") {
        const difference = Number(row.expense_total) - Number(row.income_total);
        lines.push(difference > 0
          ? `Recorded expenses exceeded recorded earned income by ${formatCurrency(difference, row.currency)} in this period; loans received and refunds are not counted as earned income.`
          : `Recorded earned income covered recorded expenses by ${formatCurrency(Math.abs(difference), row.currency)} in this period; loans received and refunds are shown separately.`);
      }
      if (["SPENDING_TREND", "FINANCIAL_INSIGHTS"].includes(item.intent) && row.daily_expenses?.length) {
        const days = row.daily_expenses.slice(-10).map((d: any) => `${d.date} ${formatCurrency(Number(d.expense_total), row.currency)}`);
        lines.push(`Recorded daily expenses (${row.currency}; up to the last 10 dates): ${days.join("; ")}.`);
      }
    }
    if (["LARGEST_EXPENSES", "FINANCIAL_INSIGHTS"].includes(item.intent) && data.largest_expenses?.length) {
      lines.push(`Largest recorded expenses (ranked within each currency): ${data.largest_expenses.map((tx: any) => `${tx.activity_date}: ${formatCurrency(Number(tx.amount), tx.currency)} for ${tx.description}`).join("; ")}.`);
    }
    if (item.intent === "TRANSACTION_LOOKUP" || (item.intent === "SUMMARY" && item.transactionDate)) {
      if (data.matching_transactions?.length) lines.push(`Matching records: ${data.matching_transactions.map((tx: any) => `${tx.activity_date}: ${formatCurrency(Number(tx.amount), tx.currency)} for ${tx.description}`).join("; ")}.`);
    }
    if (compareStart && compareEnd && data.comparisons?.length) {
      lines.push(`Comparison: ${compareStart} to ${compareEnd} vs ${start} to ${end}.`);
      for (const row of data.comparisons) {
        const diff = Number(row.current_expense_total) - Number(row.previous_expense_total);
        const direction = diff > 0 ? "increased" : diff < 0 ? "decreased" : "was unchanged";
        lines.push(`${row.currency} expenses ${direction} by ${formatCurrency(Math.abs(diff), row.currency)} (${formatCurrency(Number(row.previous_expense_total), row.currency)} to ${formatCurrency(Number(row.current_expense_total), row.currency)}).`);
        if (item.intent === "COMPARE_PERIODS") lines.push(`${row.currency} recorded income: ${formatCurrency(Number(row.previous_income_total), row.currency)} to ${formatCurrency(Number(row.current_income_total), row.currency)}.`);
        if (item.intent === "CATEGORY_TRENDS") {
          const changed = row.category_changes.filter((c: any) => Number(c.change) !== 0).slice(0, 5);
          if (changed.length) lines.push(`Category changes: ${changed.map((c: any) => `${c.category} ${Number(c.change) > 0 ? "up" : "down"} ${formatCurrency(Math.abs(Number(c.change)), row.currency)}`).join("; ")}.`);
        }
      }
    }
    if (data.transaction_count > 0) lines.push(`_Transactions recorded: ${data.transaction_count}_`, "These figures reflect records saved in FinTrack and may cover only part of the period. Loans received are not earned income; refunds are shown separately and counted once.");
    await send(phone, lines.join("\n"));
  } catch (error: any) {
    console.error(`[FinTrack] Financial insight request failed (HTTP ${apiStatus(error) || "network"}); details omitted.`);
    await send(phone, "Sorry, I couldn't retrieve that from your records just now. No figures were estimated. Please try again shortly.");
  }
}

function displayTransaction(tx: any): string {
  return `#${tx.id}: ${formatCurrency(Number(tx.amount), tx.currency)} for ${tx.description} (${tx.activity_date})`;
}

async function saveAndAsk(phone: string, type: any, payload: Record<string, any>, messageId: string, prompt: string, send: (to: string, text: string) => Promise<void>) {
  await api.savePendingAction(phone, type, payload, messageId);
  await send(phone, prompt);
}

async function routeInterpretation(phone: string, item: Interpretation, raw: string, messageId: string, send: (to: string, text: string) => Promise<void>, currency: string, timeZone: string): Promise<void> {
  if (["SUMMARY", "SPENDING_BREAKDOWN", "LARGEST_EXPENSES", "INCOME_VS_EXPENSES", "INCOME_BREAKDOWN", "COMPARE_PERIODS", "SPENDING_TREND", "CATEGORY_TRENDS", "FINANCIAL_INSIGHTS", "TRANSACTION_LOOKUP"].includes(item.intent)) {
    await handleFinancialQuestion(phone, item, send, timeZone); return;
  }
  if (item.intent === "MENU") { await sendMenu(phone, send); return; }
  if (item.intent === "PRIVACY") { await send(phone, privacyMessage()); return; }
  if (item.intent === "SUPPORT") { await send(phone, supportMessage()); return; }
  if (item.intent === "ACCOUNT_DELETE") { await saveAndAsk(phone, "ACCOUNT_DELETE_CONFIRM", {}, messageId, "This permanently deletes your FinTrack account, profile, and saved financial records. Reply ‘delete my account’ to confirm, or ‘cancel’ to keep your data.", send); return; }
  if (item.intent === "PROFILE_NAME_QUESTION") { await send(phone, "I couldn't retrieve your saved profile name just now. Please try again shortly."); return; }
  if (item.intent === "PRODUCT_QUESTION") { await send(phone, "FinTrack is a personal finance assistant built by Kamate Group Ltd. Welcome! I can record income, expenses, gifts, loans, refunds, and asset sales, and show summaries from your saved records."); return; }
  if (item.intent === "MULTI_TRANSACTION") {
    const events = item.transactions;
    if (events.length < 2 || events.some((tx) => tx.statementStatus !== "COMPLETED" || tx.confidence !== "HIGH" || !tx.amount || !tx.description || !tx.transactionType)) {
      await send(phone, "I found multiple possible events, but need a little more detail before recording them. Please send the amount and what happened for each event."); return;
    }
    await recordMultipleTransactions(phone, events, messageId, send, currency, timeZone);
    return;
  }
  if (["RECORD_EXPENSE", "RECORD_INCOME", "RECORD_REFUND", "RECORD_LOAN_RECEIVED", "RECORD_LOAN_REPAYMENT", "RECORD_LOAN_GIVEN", "RECORD_LOAN_REPAYMENT_RECEIVED", "RECORD_GIFT_RECEIVED", "RECORD_ASSET_SALE"].includes(item.intent)) {
    if (item.statementStatus !== "COMPLETED" || item.confidence !== "HIGH") {
      await send(phone, "I only record completed transactions. Tell me once it has happened, with the amount and what it was for."); return;
    }
    const inferredTypes: Record<string, string> = { RECORD_EXPENSE: "EXPENSE", RECORD_INCOME: "INCOME", RECORD_REFUND: "REFUND", RECORD_LOAN_RECEIVED: "LOAN_RECEIVED", RECORD_LOAN_REPAYMENT: "LOAN_REPAYMENT", RECORD_LOAN_GIVEN: "LOAN_GIVEN", RECORD_LOAN_REPAYMENT_RECEIVED: "LOAN_REPAYMENT_RECEIVED", RECORD_GIFT_RECEIVED: "GIFT_RECEIVED", RECORD_ASSET_SALE: "ASSET_SALE" };
    const missing = !item.amount ? "AMOUNT" : !item.description ? "DESCRIPTION" : !(item.transactionType || inferredTypes[item.intent]) ? "TRANSACTION_TYPE" : !item.transactionDate ? "DATE" : "";
    const payload = { amount: item.amount, currency: item.currency || currency, description: item.description, category: item.category, activity_type: item.transactionType || inferredTypes[item.intent], activity_date: item.transactionDate || zonedDate(new Date(), timeZone) };
    if (missing) { await saveAndAsk(phone, "TRANSACTION", payload, messageId, clarificationPrompt(missing as any), send); return; }
    await api.clearPendingAction(phone);
    await handleTransaction(phone, { type: "TRANSACTION", ...payload } as any, messageId, send); return;
  }
  if (["LIST_TRANSACTIONS", "FIND_TRANSACTION", "CORRECT_TRANSACTION", "DELETE_TRANSACTION"].includes(item.intent)) {
    const matches = await api.getTransactions(phone, item.searchQuery || item.description || "", item.intent === "LIST_TRANSACTIONS", item.previousAmount || "");
    if (!matches.length) { await send(phone, "I couldn't find a matching transaction in your records."); return; }
    if (item.intent === "LIST_TRANSACTIONS" || item.intent === "FIND_TRANSACTION") { await send(phone, matches.slice(0, 10).map(displayTransaction).join("\n")); return; }
    if (matches.length > 1) {
      const choices = matches.slice(0, 5); await saveAndAsk(phone, "CORRECTION_SELECT", { intent: item.intent, ids: choices.map((x) => x.id), changes: item }, messageId, `Which transaction do you mean? Reply with its number:\n${choices.map((x, i) => `${i + 1}. ${displayTransaction(x)}`).join("\n")}`, send); return;
    }
    const target = matches[0];
    if (item.intent === "DELETE_TRANSACTION") { await saveAndAsk(phone, "DELETE_CONFIRM", { id: target.id }, messageId, `Delete ${displayTransaction(target)}? Reply yes to confirm or no to cancel.`, send); return; }
    const change: Record<string, unknown> = {};
    if (item.fieldsToChange.includes("amount") && item.amount) change.amount = item.amount;
    if (item.fieldsToChange.includes("currency") && item.currency) change.currency = item.currency;
    if (item.fieldsToChange.includes("description") && item.description) change.description = item.description;
    if (item.fieldsToChange.includes("category") && item.category) change.category = item.category;
    if (item.fieldsToChange.includes("transactionDate") && item.transactionDate) change.activity_date = item.transactionDate;
    if (item.fieldsToChange.includes("transactionType") && item.transactionType) change.activity_type = item.transactionType;
    if (!Object.keys(change).length) { await saveAndAsk(phone, "CORRECTION", { id: target.id, changes: item }, messageId, "What detail should I correct: amount, date, description, category, or type?", send); return; }
    await saveAndAsk(phone, "CORRECTION", { id: target.id, change }, messageId, `Update ${displayTransaction(target)} with the requested details? Reply yes to confirm or no to cancel.`, send); return;
  }
  if (item.intent === "UNDO_TRANSACTION") {
    const records = await api.getTransactions(phone, "", true);
    if (!records.length) { await send(phone, "There are no recent transactions to undo."); return; }
    await saveAndAsk(phone, "UNDO_CONFIRM", { id: records[0].id }, messageId, `Undo ${displayTransaction(records[0])}? Reply yes to confirm or no to cancel.`, send); return;
  }
  if (item.intent === "AFFORDABILITY") { await send(phone, "I can't assess affordability or give financial advice. I can show your recorded transactions and summaries."); return; }
  if (item.intent === "HELP") { await send(phone, "I can record completed income, expenses, refunds and loan activity, find or correct records, and show summaries. I don't assess affordability or give financial advice."); return; }
  if (item.intent === "GREETING") { await send(phone, "Hello! What would you like to record or review?"); return; }
  if (item.intent === "NON_TRANSACTION" || item.statementStatus !== "COMPLETED") { await send(phone, "Nothing was recorded. I can record completed income, expenses, refunds, or loan activity."); return; }
  await send(phone, "I couldn't safely understand that. Please rephrase with what happened and what you'd like me to do.");
}

async function handlePendingAction(phone: string, pending: any, text: string, messageId: string, send: (to: string, text: string) => Promise<void>, currency: string, timeZone: string): Promise<void> {
  const answer = text.trim().toLowerCase();
  if (["cancel", "never mind", "nevermind", "no", "nope"].includes(answer)) { await api.clearPendingAction(phone); await send(phone, "Cancelled. Nothing was changed."); return; }
  if (["yes", "confirm", "confirmed", "yep"].includes(answer) && pending.action_type === "DELETE_CONFIRM") { await api.voidTransaction(phone, pending.payload.id, "DELETE", messageId); await api.clearPendingAction(phone); await send(phone, "Deleted from your active records. The audit history is retained."); return; }
  if (["yes", "confirm", "confirmed", "yep"].includes(answer) && pending.action_type === "UNDO_CONFIRM") { await api.voidTransaction(phone, pending.payload.id, "UNDO", messageId); await api.clearPendingAction(phone); await send(phone, "Undone. The transaction is excluded from your records and summaries."); return; }
  if ((["yes", "confirm", "confirmed", "yep"].includes(answer) || /^(delete|erase|remove) my (fd )?(account|data)$/.test(answer)) && pending.action_type === "ACCOUNT_DELETE_CONFIRM") {
    try {
      await api.deleteAccountData(phone, messageId);
      registeredPhones.delete(phone);
      profileStatusCache.delete(phone);
      onboardingState.delete(phone);
      await send(phone, "Your FinTrack account and saved financial records have been deleted.");
    } catch (error: any) {
      console.error(`[FinTrack] Account data deletion failed (HTTP ${apiStatus(error) || "network"}); details omitted.`);
      await send(phone, "I couldn't delete your account just now. Your data remains as it was; please contact https://wa.me/256787360381 for help.");
    }
    return;
  }
  if (["yes", "confirm", "confirmed", "yep"].includes(answer) && pending.action_type === "CORRECTION") { await api.updateTransaction(phone, pending.payload.id, pending.payload.change); await api.clearPendingAction(phone); await send(phone, "Correction saved."); return; }
  try {
    const interpretation = await interpretMessage(text, { preferredCurrency: currency, timeZone, pendingContext: { action_type: pending.action_type, payload: pending.payload } });
    if (pending.action_type === "TRANSACTION") {
      const merged = { ...pending.payload };
      if (interpretation.amount) merged.amount = interpretation.amount;
      if (interpretation.description) merged.description = interpretation.description;
      if (interpretation.currency) merged.currency = interpretation.currency;
      if (interpretation.transactionType) merged.activity_type = interpretation.transactionType;
      if (interpretation.transactionDate) merged.activity_date = interpretation.transactionDate;
      if (merged.amount && merged.description && merged.activity_type && merged.activity_date) {
        const saved = await handleTransaction(phone, { type: "TRANSACTION", ...merged } as any, messageId, send);
        if (saved) await api.clearPendingAction(phone);
      }
      else { await api.savePendingAction(phone, "TRANSACTION", merged, pending.original_message_id || messageId); await send(phone, clarificationPrompt(!merged.amount ? "AMOUNT" : !merged.description ? "DESCRIPTION" : "TRANSACTION_TYPE")); }
      return;
    }
    if (pending.action_type === "CORRECTION_SELECT" && /^\d+$/.test(answer)) {
      const id = pending.payload.ids[Number(answer) - 1]; if (!id) { await send(phone, "Please reply with one of the listed numbers, or cancel."); return; }
      if (pending.payload.intent === "DELETE_TRANSACTION") { await api.savePendingAction(phone, "DELETE_CONFIRM", { id }, pending.original_message_id || messageId); await send(phone, "Delete the selected transaction? Reply yes to confirm or no to cancel."); return; }
      await api.savePendingAction(phone, "CORRECTION", { id, changes: pending.payload.changes }, pending.original_message_id || messageId);
      await send(phone, "What should I change on that transaction?"); return;
    }
    if (pending.action_type === "CORRECTION" && pending.payload.changes) {
      const item = interpretation; const change: Record<string, unknown> = {};
      if (item.amount) change.amount = item.amount; if (item.currency) change.currency = item.currency; if (item.description) change.description = item.description; if (item.category) change.category = item.category; if (item.transactionDate) change.activity_date = item.transactionDate; if (item.transactionType) change.activity_type = item.transactionType;
      if (!Object.keys(change).length) { await send(phone, "Please say the corrected value, such as ‘change it to 20,000’."); return; }
      const tx = (await api.getTransactions(phone)).find((x) => x.id === pending.payload.id); if (!tx) { await api.clearPendingAction(phone); await send(phone, "I couldn't find that transaction anymore."); return; }
      await api.savePendingAction(phone, "CORRECTION", { id: tx.id, change }, pending.original_message_id || messageId);
      await send(phone, `Apply the correction to ${displayTransaction(tx)}? Reply yes to confirm or no to cancel.`); return;
    }
    await send(phone, "Please reply yes to confirm or no to cancel.");
  } catch (error: any) { console.error(`[FinTrack] Pending action failed (HTTP ${apiStatus(error) || "language service"}).`); await send(phone, "I couldn't safely complete that. Nothing was changed; please try again."); }
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
