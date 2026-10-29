import { makeWASocket, useMultiFileAuthState, BaileysEventMap, DisconnectReason, WAMessageStatus } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import { Baileys6LidMappingStore, resolveIncomingSender } from "./lid-mapping";

export const SESSION_DIR = path.join(process.cwd(), "whatsapp-session");
const outboundRetryMessages = new Map<string, any>();

export function rememberOutboundMessageForRetry(message: any): void {
  const id = message?.key?.id;
  if (typeof id !== "string" || !id || !message?.message) return;
  outboundRetryMessages.delete(id);
  outboundRetryMessages.set(id, message.message);
  while (outboundRetryMessages.size > 256) {
    const oldest = outboundRetryMessages.keys().next().value;
    if (oldest === undefined) break;
    outboundRetryMessages.delete(oldest);
  }
}

export function getOutboundMessageForRetry(key: { id?: string | null }): any | undefined {
  if (typeof key.id !== "string") return undefined;
  const message = outboundRetryMessages.get(key.id);
  if (message) {
    outboundRetryMessages.delete(key.id);
    outboundRetryMessages.set(key.id, message);
  }
  return message;
}

export function isRecoverableDisconnect(statusCode?: number): boolean {
  // Reconnecting on connectionReplaced (440) can create an endless session
  // takeover loop. Stop and require an operator to resolve the competing link.
  return statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.connectionReplaced;
}

export function getReconnectDelay(attempt: number): number {
  const baseDelayMs = 1000;
  const maxDelayMs = 30000;
  const computed = baseDelayMs * Math.pow(2, Math.max(0, attempt));
  return Math.min(computed, maxDelayMs);
}

export function getMessagePhoneJid(key: { remoteJid?: string | null; remoteJidAlt?: string | null }): string | null {
  for (const jid of [key.remoteJidAlt, key.remoteJid]) {
    if (jid && /^\d+(?::\d+)?@s\.whatsapp\.net$/.test(jid)) {
      return jid.replace(/:\d+@/, "@");
    }
  }
  return null;
}

export function getMessageStatusName(status: unknown): string {
  return Object.entries(WAMessageStatus).find(([, value]) => value === status)?.[0]?.toLowerCase() || "unknown";
}

export function describeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  return { name: "UnknownError", message: typeof error === "string" ? error : "Non-error value thrown" };
}

function safeErrorDetails(error: unknown): string {
  if (!error || typeof error !== "object") return "UnknownError";
  const item = error as Record<string, any>;
  const name = typeof item.name === "string" ? item.name : "Error";
  const status = Number.isInteger(item.output?.statusCode) ? ` status=${item.output.statusCode}` : "";
  const frames = typeof item.stack === "string"
    ? item.stack.split(/\r?\n/).slice(1, 6).map((line: string) => line.trim()).join(" <- ")
    : "";
  return `${name}${status}${frames ? ` frames=${frames}` : ""}`;
}

function jidKind(value: unknown): string {
  if (typeof value !== "string") return "missing";
  if (/@s\.whatsapp\.net$/.test(value)) return "phone";
  if (/@lid$/.test(value)) return "lid";
  if (/@g\.us$/.test(value)) return "group";
  if (/@broadcast$|@newsletter$/.test(value)) return "broadcast";
  return "other";
}

function safeBaileysMessage(message?: string): string {
  const allowed = new Set([
    "connected to WA",
    "logging in...",
    "failed to decrypt message",
    "sent retry receipt",
    "error in handling message",
    "connection errored",
  ]);
  return message && allowed.has(message) ? message : "event";
}

function createSafeBaileysLogger(): any {
  const emit = (level: "info" | "warn" | "error", context: unknown, message?: string): void => {
    const record = context && typeof context === "object" ? context as Record<string, unknown> : {};
    const error = context instanceof Error ? context : record.err || record.error;
    const details = error ? ` ${safeErrorDetails(error)}` : "";
    const key = record.key && typeof record.key === "object" ? record.key as Record<string, unknown> : null;
    const correlation = typeof key?.id === "string" ? key.id.slice(-8) : null;
    const keyDetails = key
      ? ` key=${correlation || "no-id"} fromMe=${key.fromMe === true ? "yes" : key.fromMe === false ? "no" : "unknown"}`
        + ` remote=${jidKind(key.remoteJid)} participant=${jidKind(key.participant)}`
        + ` senderPn=${jidKind(key.senderPn)} remoteAlt=${jidKind(key.remoteJidAlt)}`
      : "";
    const line = `[${new Date().toISOString()}] [Baileys] ${safeBaileysMessage(message)}${keyDetails}${details}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  };
  const logger: any = {
    level: "warn",
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: (context: unknown, message?: string) => emit("info", context, message),
    warn: (context: unknown, message?: string) => emit("warn", context, message),
    error: (context: unknown, message?: string) => emit("error", context, message),
  };
  return logger;
}

export function ensureSessionDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

export function renderQrCode(qr: string): void {
  console.log("\n=== WhatsApp Pairing QR Code ===");
  console.log("Open WhatsApp > Linked Devices > Link a device and scan the QR code below.");
  qrcode.generate(qr, { small: true });
  console.log("================================\n");
}

export async function createBaileysClient(
  onMessage: (from: string, message: string, messageId: string, replyJid: string) => Promise<void>,
  onQR: (qr: string) => void,
  onConnectionChange: (status: string, statusCode?: number) => void,
  onSocketCreated?: (sock: any) => void
) {
  ensureSessionDir();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    browser: ["Windows", "Chrome", "126.0.0.0"],
    auth: state,
    logger: createSafeBaileysLogger(),
    getMessage: async (key) => getOutboundMessageForRetry(key),
  });
  const lidMappings = new Baileys6LidMappingStore();
  // Baileys' multi-file store persists Signal/app-state key writes through
  // state.keys.set(). creds.update separately persists creds.json below.

  // Baileys 6.7.24 emits this after the contact explicitly shares a phone
  // number. It is a trusted LID/PN pair; unrelated message fields are not.
  sock.ev.on("chats.phoneNumberShare", ({ lid, jid }: { lid: string; jid: string }) => {
    const stored = lidMappings.addPhoneNumberShare(lid, jid);
    console.info(`[${new Date().toISOString()}] Baileys phone-number share mapping ${stored ? "stored" : "rejected"} (LID and phone values omitted).`);
  });

  if (onSocketCreated) {
    onSocketCreated(sock);
  }

  sock.ev.on("connection.update", (update: Partial<BaileysEventMap["connection.update"]>) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      onQR(qr);
    }

    if (connection === "close") {
      const error = lastDisconnect?.error as Boom | undefined;
      const statusCode = error?.output?.statusCode;
      const message = error?.message || "unknown disconnect";

      console.error(`[${new Date().toISOString()}] WhatsApp disconnect: ${message} (statusCode=${statusCode ?? "n/a"})`);

      if (statusCode === DisconnectReason.loggedOut) {
        onConnectionChange("logged_out", statusCode);
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        onConnectionChange("connection_conflict", statusCode);
        return;
      }

      if (statusCode === DisconnectReason.restartRequired) {
        onConnectionChange("restart_required", statusCode);
      } else if (isRecoverableDisconnect(statusCode)) {
        onConnectionChange("reconnecting", statusCode);
      } else {
        onConnectionChange("disconnected", statusCode);
      }
    } else if (connection === "open") {
      onConnectionChange("open");
      console.log(`[${new Date().toISOString()}] WhatsApp connected successfully.`);
    }
  });

  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Failed to persist WhatsApp credential update (${safeErrorDetails(error)}).`);
    }
  });

  sock.ev.on("messages.upsert", (event: any) => {
    void processMessageUpsert(event, onMessage, lidMappings);
  });

  sock.ev.on("messages.update", (updates: any[]) => {
    for (const item of updates || []) {
      const correlation = typeof item?.key?.id === "string" ? item.key.id.slice(-8) : "no-id";
      const hasMessage = Boolean(item?.update?.message);
      const status = item?.update?.status;
      const statusName = getMessageStatusName(status);
      console.info(`[${new Date().toISOString()}] [Baileys][${correlation}] messages.update received (status=${statusName}, content=${hasMessage ? "present" : "status-only"}); update not independently dispatched.`);
    }
  });

  sock.ev.on("messaging-history.set", (event: any) => {
    console.info(`[${new Date().toISOString()}] [Baileys] messaging-history.set received (messages=${Array.isArray(event?.messages) ? event.messages.length : 0}, contacts=${Array.isArray(event?.contacts) ? event.contacts.length : 0}); contents omitted.`);
  });

  return sock;
}

export async function processMessageUpsert(
  event: any,
  onMessage: (from: string, message: string, messageId: string, replyJid: string) => Promise<void>,
  lidMappings: Baileys6LidMappingStore,
): Promise<void> {
  try {
    for (const msg of event?.messages ?? []) {
        try {
          const messageId = typeof msg?.key?.id === "string" ? msg.key.id : "";
          const correlation = messageId.slice(-8) || "no-id";
          console.info(`[${new Date().toISOString()}] [Baileys][${correlation}] messages.upsert received (type=${event?.type || "unknown"}).`);
          if (msg?.messageStubType === 2) {
            console.warn(`[${new Date().toISOString()}] [Baileys][${correlation}] Undecrypted ciphertext upsert (fromMe=${msg?.key?.fromMe === true ? "yes" : msg?.key?.fromMe === false ? "no" : "unknown"}, remote=${jidKind(msg?.key?.remoteJid)}, participant=${jidKind(msg?.key?.participant)}); not dispatched.`);
          }
          if (msg?.key?.fromMe) {
            console.info(`[${new Date().toISOString()}] [Baileys][${correlation}] Self message filtered.`);
            continue;
          }
          if (!messageId) {
            console.warn(`[${new Date().toISOString()}] [Baileys] Inbound event missing a usable message ID; skipped.`);
            continue;
          }
          if (!msg?.message) {
            console.warn(`[${new Date().toISOString()}] [Baileys][${correlation}] Message event received without decrypted content (stub=${msg?.messageStubType ?? "none"}); not dispatched.`);
            continue;
          }

          const text = extractMessageText(msg);
          if (!text) {
            const messageTypes = Object.keys(msg.message || {}).slice(0, 8).join(",") || "unknown";
            console.info(`[${new Date().toISOString()}] [Baileys][${correlation}] Message decrypted but has no supported text or image caption (types=${messageTypes}).`);
            continue;
          }
          console.info(`[${new Date().toISOString()}] [Baileys][${correlation}] Message content decrypted; text extracted and omitted from logs.`);

          const sender = resolveIncomingSender(msg.key || {}, lidMappings);
          if (sender.reason === "group_or_broadcast") {
            console.warn(`[${new Date().toISOString()}] Ignoring inbound group or broadcast message.`);
            continue;
          }
          if (!sender.phoneJid || !sender.replyJid) {
            if (sender.isLid) {
              console.warn(`[${new Date().toISOString()}] Unmapped private LID received; alternate phone JID ${sender.alternatePhonePresent ? "present but invalid" : "absent"}; mapping store ${sender.mappingStoreAvailable ? "available" : "unavailable"}; mapping ${sender.mappingFound ? "found" : "not found"}. No profile or transaction was accessed.`);
            } else {
              console.warn(`[${new Date().toISOString()}] Ignoring inbound message with missing or malformed sender fields.`);
            }
            continue;
          }

          console.info(`[${new Date().toISOString()}] Private inbound message identity resolved via ${sender.resolutionSource}; reply route ${sender.replyJid.endsWith("@lid") ? "LID" : "phone JID"}. Message text and identifiers omitted.`);
          const dispatchStartedAt = Date.now();
          try {
            await onMessage(sender.phoneJid, text, messageId, sender.replyJid);
          } finally {
            console.info(`[${new Date().toISOString()}] [Baileys][${correlation}] FinTrack dispatch completed in ${Date.now() - dispatchStartedAt}ms.`);
          }
        }
        catch (error: unknown) {
          console.error(`[${new Date().toISOString()}] Incoming message processing failed (${safeErrorDetails(error)}).`);
        }
    }
  } catch (error: unknown) {
      console.error(`[${new Date().toISOString()}] WhatsApp message event failed (${safeErrorDetails(error)}).`);
  }
}

function extractMessageText(msg: any): string | null {
  const message = msg.message;
  if (!message) return null;

  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage) return message.extendedTextMessage.text;
  if (message.imageMessage && message.imageMessage.caption) return message.imageMessage.caption;
  return null;
}
