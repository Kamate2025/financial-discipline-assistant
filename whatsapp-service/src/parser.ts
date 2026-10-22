export type ActivityType = "INCOME" | "EXPENSE" | "TRANSFER";

export interface ParsedTransaction {
  type: "TRANSACTION";
  activity_type: ActivityType;
  amount: number;
  currency: string;
  description: string;
  category?: string;
  activity_date: string;
}

export interface OnboardingRequest {
  type: "ONBOARDING_REQUEST";
}

export interface NameUpdateRequest {
  type: "NAME_UPDATE";
  name: string;
}

export interface SummaryRequest {
  type: "SUMMARY";
  period: "this_month" | "custom";
  start_date?: string;
  end_date?: string;
}

export interface AmbiguousRequest {
  type: "AMBIGUOUS";
  question: string;
  pendingTransaction?: {
    amount: string;
    currency: string;
    description: string;
    activity_date: string;
  };
}

export interface UnsupportedRequest {
  type: "UNSUPPORTED";
  reason: string;
}

export type ParsedMessage =
  | OnboardingRequest
  | NameUpdateRequest
  | SummaryRequest
  | ParsedTransaction
  | AmbiguousRequest
  | UnsupportedRequest;

const INCOME_KEYWORDS = [
  "received", "income", "earned", "salary", "payment received",
  "money in", "credit", "deposited",
];
const EXPENSE_KEYWORDS = [
  "spent", "expense", "paid", "purchase", "bought", "cost",
  "money out", "debited",
];
const TRANSFER_KEYWORDS = [
  "transferred", "transfer", "moved", "to savings", "to account",
];

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

function extractAmount(text: string): { amount: number; sourceText: string } | "multiple" | null {
  const withoutDate = stripDateExpressions(text);
  const matches = [...withoutDate.matchAll(/\b\d+(?:\.\d+)?\s*[kmb]\b|\b\d+(?:(?:,|\s)\d{3})*(?:\.\d{1,2})?\b/gi)];
  if (matches.length > 1) return "multiple";
  const match = matches[0];
  if (!match) return null;
  const token = match[0].replace(/\s/g, "").toLowerCase();
  const suffix = token.slice(-1);
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  const value = Number(/[kmb]$/.test(token) ? token.slice(0, -1) : token.replace(/[ ,]/g, "")) * multiplier;
  return !Number.isFinite(value) || value <= 0 ? null : { amount: value, sourceText: match[0] };
}

function stripDateExpressions(text: string): string {
  const months = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, " ")
    .replace(new RegExp(`\\b(?:on\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${months})(?:,?\\s+\\d{4})?\\b`, "gi"), " ")
    .replace(new RegExp(`\\b(?:${months})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"), " ");
}


function extractCurrency(text: string, defaultCurrency: string): string {
  const defaultCode = defaultCurrency.toUpperCase();
  const tokens = text.match(/\b[A-Za-z]{3}\b/g) || [];
  const explicit = tokens.find((token) => token === token.toUpperCase() || token.toUpperCase() === defaultCode);
  return explicit ? explicit.toUpperCase() : defaultCode;
}

function extractDescription(text: string, amountStr: string, currency: string): string {
  let desc = text;
  const escapedAmount = amountStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  desc = desc.replace(new RegExp(escapedAmount, "g"), " ");
  desc = desc.replace(new RegExp(`\\b${currency}\\b`, "gi"), " ");
  desc = desc.replace(/\b(i spent|i paid|i bought|spent|paid|bought|received|income|earned|transferred|transfer|from|for|on|today|yesterday)\b/gi, " ");
  desc = desc.replace(/\s+/g, " ").replace(/^[\s:,-]+|[\s:,-]+$/g, "").trim();
  return desc || "Unnamed transaction";
}

function isOnboarding(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return lower === "hello" || lower === "hi" || lower === "hey";
}

function isNameUpdate(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return lower.startsWith("call me ") || lower.startsWith("my name is ");
}

function isSummary(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower === "summary" ||
    /^(?:show|give|send|display) (?:me )?(?:my )?(?:spending )?summary\??$/.test(lower) ||
    /\b(?:what did i spend|how much did i spend|how much have i spent|what have i spent)\b/.test(lower) ||
    /\b(?:summarise|summarize|summary)\b/.test(lower) ||
    /\b(?:spending|transactions) (?:for |in )?this month\b/.test(lower)
  );
}

function extractName(text: string): string | null {
  const lower = text.trim().toLowerCase();
  let name: string | null = null;

  if (lower.startsWith("call me ")) {
    name = text.trim().slice("call me ".length).trim();
  } else if (lower.startsWith("my name is ")) {
    name = text.trim().slice("my name is ".length).trim();
  }

  if (!name || name.length < 1 || name.length > 100) return null;
  return name;
}

function determineActivityType(text: string): ActivityType | null {
  const lower = text.toLowerCase();

  const unsupportedKeywords = [
    "borrow", "lend", "loan", "repay", "refund", "owes", "owing", "back",
  ];
  if (containsAny(lower, unsupportedKeywords)) {
    return null;
  }

  if (containsAny(lower, TRANSFER_KEYWORDS)) return "TRANSFER";
  if (containsAny(lower, INCOME_KEYWORDS)) return "INCOME";
  if (containsAny(lower, EXPENSE_KEYWORDS)) return "EXPENSE";

  return null;
}

function determineDate(text: string, timeZone: string): string {
  const today = dateInTimeZone(new Date(), timeZone);
  const lower = text.toLowerCase();

  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso && isValidDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))) return iso[0];
  const local = text.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/);
  if (local) {
    const year = Number(local[3]) < 100 ? 2000 + Number(local[3]) : Number(local[3]);
    const day = Number(local[1]);
    const month = Number(local[2]);
    if (isValidDate(year, month, day)) return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const months: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
    dec: 12, december: 12,
  };
  const monthPattern = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const dayFirst = text.match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:,?\\s+(\\d{4}))?`, "i"));
  const monthFirst = text.match(new RegExp(`(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "i"));
  if (dayFirst && months[dayFirst[2].toLowerCase()]) {
    const year = Number(dayFirst[3] || today.slice(0, 4));
    const month = months[dayFirst[2].toLowerCase()];
    const day = Number(dayFirst[1]);
    if (isValidDate(year, month, day)) return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (monthFirst && months[monthFirst[1].toLowerCase()]) {
    const year = Number(monthFirst[3] || today.slice(0, 4));
    const month = months[monthFirst[1].toLowerCase()];
    const day = Number(monthFirst[2]);
    if (isValidDate(year, month, day)) return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  if (lower.includes("yesterday")) {
    return addDays(today, -1);
  }

  return today;
}

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function parseMessage(text: string, defaultCurrency = "UGX", timeZone = "Africa/Kampala"): ParsedMessage {
  const trimmed = text.trim();

  if (isOnboarding(trimmed)) {
    return { type: "ONBOARDING_REQUEST" };
  }

  if (isNameUpdate(trimmed)) {
    const name = extractName(trimmed);
    if (name) {
      return { type: "NAME_UPDATE", name };
    }
    return {
      type: "AMBIGUOUS",
      question: "Please tell me your name. For example: Call me Sam.",
    };
  }

  if (isSummary(trimmed)) {
    const lower = trimmed.toLowerCase();
    if (/\btoday\b/.test(lower)) {
      const today = dateInTimeZone(new Date(), timeZone);
      return { type: "SUMMARY", period: "custom", start_date: today, end_date: today };
    }
    if (/\byesterday\b/.test(lower)) {
      const yesterday = addDays(dateInTimeZone(new Date(), timeZone), -1);
      return { type: "SUMMARY", period: "custom", start_date: yesterday, end_date: yesterday };
    }
    if (/\blast week\b/.test(lower)) {
      const today = dateInTimeZone(new Date(), timeZone);
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
      const thisMondayOffset = weekday === 0 ? -6 : 1 - weekday;
      const thisMonday = addDays(today, thisMondayOffset);
      return {
        type: "SUMMARY",
        period: "custom",
        start_date: addDays(thisMonday, -7),
        end_date: addDays(thisMonday, -1),
      };
    }
    if (lower.includes("this month")) {
      const today = dateInTimeZone(new Date(), timeZone);
      const [year, month] = today.split("-").map(Number);
      const start = `${year}-${String(month).padStart(2, "0")}-01`;
      const end = `${year}-${String(month).padStart(2, "0")}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
      return {
        type: "SUMMARY",
        period: "this_month",
        start_date: start,
        end_date: end,
      };
    }
    return {
      type: "SUMMARY",
      period: "this_month",
    };
  }

  const lower = trimmed.toLowerCase();
  const unsafeForDeterministicWrite =
    /\?/.test(trimmed) ||
    /\b(?:might|may|maybe|plan(?:ning)? to|going to|will|would|could|should|need to|want to|if i|suppose|imagine|hypothetically|did not|didn't|never|nothing|no purchase)\b/.test(lower) ||
    /[\"'“”‘’].+[\"'“”‘’]/.test(trimmed) ||
    /\blast week\b/.test(lower);
  if (unsafeForDeterministicWrite) {
    return { type: "AMBIGUOUS", question: "" };
  }

  const activityType = determineActivityType(trimmed);
  if (activityType === null) {
    const amount = extractAmount(trimmed);
    if (amount && amount !== "multiple") {
      const currency = extractCurrency(trimmed, defaultCurrency);
      const description = extractDescription(stripDateExpressions(trimmed), amount.sourceText, currency);
      if (description && description !== "Unnamed transaction") {
        const pendingTransaction = {
          amount: String(amount.amount),
          currency,
          description,
          activity_date: determineDate(trimmed, timeZone),
        };
        return {
          type: "AMBIGUOUS",
          question: `Was the ${currency} ${amount.amount.toLocaleString("en-US")} for ${description} an expense, money you received, or something else?`,
          pendingTransaction,
        };
      }
    }
    return {
      type: "AMBIGUOUS",
      question: "Was this money received or spent?",
    };
  }

  const amount = extractAmount(trimmed);
  if (amount === "multiple") {
    return {
      type: "AMBIGUOUS",
      question: "I found more than one amount. Please send one transaction at a time, with a separate amount for each.",
    };
  }
  if (amount === null) {
    return {
      type: "AMBIGUOUS",
      question: "How much was the amount?",
    };
  }

  if (activityType === "TRANSFER") {
    return { type: "UNSUPPORTED", reason: "Transfers between your own accounts are not supported yet." };
  }

  const currency = extractCurrency(trimmed, defaultCurrency);
  const dateRemoved = stripDateExpressions(trimmed);
  const description = extractDescription(dateRemoved, amount.sourceText, currency);

  if (!description || description === "Unnamed transaction") {
    return {
      type: "AMBIGUOUS",
      question: "What was the payment for?",
    };
  }

  return {
    type: "TRANSACTION",
    activity_type: activityType,
    amount: amount.amount,
    currency,
    description,
    activity_date: determineDate(trimmed, timeZone),
  };
}
