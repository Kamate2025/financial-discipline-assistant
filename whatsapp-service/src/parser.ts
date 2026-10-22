export type ActivityType = "INCOME" | "EXPENSE" | "TRANSFER";

export interface ParsedTransaction {
  type: "TRANSACTION";
  activity_type: ActivityType;
  amount: number;
  currency: string;
  description: string;
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
  const withoutDate = text.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, " ");
  const matches = [...withoutDate.matchAll(/\b\d+(?:(?:,|\s)\d{3})*(?:\.\d{1,2})?\b/g)];
  if (matches.length > 1) return "multiple";
  const match = matches[0];
  if (!match) return null;
  const value = Number(match[0].replace(/[ ,]/g, ""));
  return !Number.isFinite(value) || value <= 0 ? null : { amount: value, sourceText: match[0] };
}


function extractCurrency(text: string): string {
  const match = text.match(/\b(UGX|USD|KES|EUR|GBP)\b/i);
  return match ? match[1].toUpperCase() : "UGX";
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
    /^(?:what did i spend|how much did i spend|what have i spent)(?: on)? (?:today|yesterday)\??$/.test(lower) ||
    lower.startsWith("summarise") ||
    lower.startsWith("summarize") ||
    lower.includes("how much")
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
    "borrow", "lend", "loan", "repay", "refund", "owes", "owing",
  ];
  if (containsAny(lower, unsupportedKeywords)) {
    return null;
  }

  if (containsAny(lower, TRANSFER_KEYWORDS)) return "TRANSFER";
  if (containsAny(lower, INCOME_KEYWORDS)) return "INCOME";
  if (containsAny(lower, EXPENSE_KEYWORDS)) return "EXPENSE";

  return null;
}

function determineDate(text: string): string {
  const today = new Date();
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

  if (lower.includes("yesterday")) {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return formatDate(yesterday);
  }

  return formatDate(today);
}

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseMessage(text: string): ParsedMessage {
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
      const today = formatDate(new Date());
      return { type: "SUMMARY", period: "custom", start_date: today, end_date: today };
    }
    if (lower.includes("this month")) {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return {
        type: "SUMMARY",
        period: "this_month",
        start_date: formatDate(start),
        end_date: formatDate(end),
      };
    }
    return {
      type: "SUMMARY",
      period: "this_month",
    };
  }

  const activityType = determineActivityType(trimmed);
  if (activityType === null) {
    const lower = trimmed.toLowerCase();
    const unsupportedKeywords = [
      "borrow", "lend", "loan", "repay", "refund", "owes", "owing",
    ];
    if (containsAny(lower, unsupportedKeywords)) {
      return {
        type: "UNSUPPORTED",
        reason:
          "That sounds like borrowing, lending, a loan, or a refund. FD does not yet support those categories.",
      };
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

  const currency = extractCurrency(trimmed);
  const dateRemoved = trimmed.replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, " ");
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
    activity_date: determineDate(trimmed),
  };
}
