import { makeWASocket, useMultiFileAuthState, BaileysEventMap, DisconnectReason } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";

export const SESSION_DIR = path.join(process.cwd(), "whatsapp-session");

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
  onMessage: (from: string, message: string, messageId: string) => Promise<void>,
  onQR: (qr: string) => void,
  onConnectionChange: (status: string) => void
) {
  ensureSessionDir();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    printQRInTerminal: false,
    browser: ["Windows", "Chrome", "126.0.0.0"],
    auth: state,
  });

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
        onConnectionChange("logged_out");
      } else if (statusCode === DisconnectReason.connectionLost || statusCode === DisconnectReason.restartRequired) {
        onConnectionChange("reconnecting");
      } else {
        onConnectionChange("disconnected");
      }
    } else if (connection === "open") {
      onConnectionChange("open");
      console.log(`[${new Date().toISOString()}] WhatsApp connected successfully.`);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (event: any) => {
    const msg = event?.messages?.[0];
    if (!msg || !msg.message) return;
    if (msg.key?.fromMe) return;

    const messageId = msg.key?.id;
    if (!messageId) return;

    const text = extractMessageText(msg);
    if (!text) return;

    const from = msg.key?.remoteJid;
    if (!from) return;

    await onMessage(from, text, messageId);
  });

  return sock;
}

function extractMessageText(msg: any): string | null {
  const message = msg.message;
  if (!message) return null;

  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage) return message.extendedTextMessage.text;
  if (message.imageMessage && message.imageMessage.caption) return message.imageMessage.caption;
  return null;
}
