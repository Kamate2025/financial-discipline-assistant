import axios from "axios";
import { createBaileysClient, SESSION_DIR, renderQrCode, getReconnectDelay, isRecoverableDisconnect, describeError, rememberOutboundMessageForRetry } from "./client";
import { dispatchMessage } from "./handlers";
import { getGroqConfigStatus, loadServiceConfig } from "./config";
import { acquireSessionProcessLock } from "./instance-lock";

async function checkDjangoHealth(baseURL: string): Promise<{ reachable: boolean; status?: number; message: string }> {
  try {
    const response = await axios.get(`${baseURL.replace(/\/$/, "")}/api/v1/health/`, { timeout: 8000 });
    return {
      reachable: true,
      status: response.status,
      message: `Django health responded with status ${response.status}`,
    };
  } catch (error: any) {
    const reason = error.response?.status ? `HTTP ${error.response.status}` : error.message;
    return {
      reachable: false,
      message: `Django health check failed: ${reason}`,
    };
  }
}

async function main(): Promise<void> {
  const releaseSessionLock = acquireSessionProcessLock(SESSION_DIR);
  process.once("exit", releaseSessionLock);
  const { backendBaseUrl, serviceKey } = loadServiceConfig();

  const djangoHealth = await checkDjangoHealth(backendBaseUrl);
  console.log(`[${new Date().toISOString()}] Django backend URL configured.`);
  console.log(`[${new Date().toISOString()}] Service key configured: ${serviceKey ? "yes" : "no"}`);
  const groqStatus = getGroqConfigStatus();
  console.log(`[${new Date().toISOString()}] Groq configured: ${groqStatus.configured ? `yes (${groqStatus.model})` : "no"}`);
  console.log(`[${new Date().toISOString()}] ${djangoHealth.message}`);

  if (!djangoHealth.reachable) {
    console.warn(`[${new Date().toISOString()}] Continuing startup, but the Django backend is not reachable yet.`);
  }

  let activeSocket: any = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let startLock = false;
  let socketReady = false;
  let shuttingDown = false;
  const maxReconnectAttempts = 8;

  const scheduleReconnect = (status: string, statusCode?: number): void => {
    if (shuttingDown || reconnectTimer) return;
    if (reconnectAttempt >= maxReconnectAttempts) {
      console.error(`[${new Date().toISOString()}] Reconnect limit reached after ${maxReconnectAttempts} attempts. Restart the service after checking WhatsApp connectivity.`);
      return;
    }
    const delayMs = status === "restart_required" ? 0 : getReconnectDelay(reconnectAttempt);
    reconnectAttempt += 1;
    console.warn(`[${new Date().toISOString()}] Reconnect scheduled (attempt ${reconnectAttempt}, statusCode=${statusCode ?? "n/a"}) in ${delayMs}ms`);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await startSocket();
      } catch (error) {
        const details = describeError(error);
        console.error(`[${new Date().toISOString()}] Failed to create WhatsApp socket (${details.name}): ${details.message}`);
        scheduleReconnect("reconnecting", statusCode);
      }
    }, delayMs);
  };

  const closeCurrentSocket = (): void => {
    socketReady = false;
    if (!activeSocket) return;
    try {
      activeSocket.ws?.close?.();
    } catch {
      // no-op
    }
    try {
      activeSocket.ev?.removeAllListeners?.();
    } catch {
      // no-op
    }
    activeSocket = null;
  };

  const sendWhatsAppReply = async (recipientJid: string, message: string): Promise<void> => {
    if (!activeSocket || !socketReady) {
      console.warn(`[${new Date().toISOString()}] Skipped reply because WhatsApp socket is not active.`);
      throw new Error("WhatsApp socket is not active.");
    }

    try {
      if (!/^\d{7,20}@s\.whatsapp\.net$/.test(recipientJid) && !/^\d+@lid$/.test(recipientJid)) {
        console.warn(`[${new Date().toISOString()}] Refusing reply to unsupported recipient identifier.`);
        throw new Error("Unsupported WhatsApp recipient identifier.");
      }
      const result = await activeSocket.sendMessage(recipientJid, { text: message });
      rememberOutboundMessageForRetry(result);
      const messageId = typeof result?.key?.id === "string" ? result.key.id.slice(-8) : "no-id";
      console.info(`[${new Date().toISOString()}] [Baileys][${messageId}] Outbound send accepted using ${recipientJid.endsWith("@lid") ? "LID" : "phone JID"} route; delivery awaits WhatsApp status updates.`);
    } catch (error) {
      const details = describeError(error);
      console.error(`[${new Date().toISOString()}] Failed to submit WhatsApp reply (${details.name}); recipient and content omitted.`);
      throw error;
    }
  };

  const startSocket = async (): Promise<void> => {
    if (startLock) return;
    startLock = true;
    closeCurrentSocket();

    try {
      const sock = await createBaileysClient(
        async (from: string, text: string, messageId: string, replyJid: string): Promise<void> => {
          await dispatchMessage(from, text, messageId, async (_identity, response) => {
            await sendWhatsAppReply(replyJid, response);
          });
        },
        (qr: string): void => {
          renderQrCode(qr);
        },
        (status: string, statusCode?: number): void => {
          if (shuttingDown) return;
          console.log(`[${new Date().toISOString()}] Connection status: ${status}`);
          if (status !== "open") socketReady = false;

          if (status === "logged_out") {
            socketReady = false;
            reconnectAttempt = 0;
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
            console.warn("[WhatsApp] WhatsApp reported a logged-out session (401). Re-link the device to continue.");
            return;
          }

          if (status === "connection_conflict") {
            socketReady = false;
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
            console.error("[WhatsApp] Connection was replaced by another linked session (440). Automatic reconnect stopped to avoid repeated takeovers. Check for another bridge process or linked-device session, then restart intentionally. Authentication files were left unchanged.");
            return;
          }

          if (status === "reconnecting" || status === "restart_required") {
            scheduleReconnect(status, statusCode);
            return;
          }

          if (status === "open") {
            socketReady = true;
            reconnectAttempt = 0;
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
          }
        },
        (sock: any): void => {
          activeSocket = sock;
          socketReady = false;
        }
      );

      activeSocket = sock;
      console.log(`[${new Date().toISOString()}] FinTrack WhatsApp service is running.`);
      console.log(`[${new Date().toISOString()}] Session directory: ${SESSION_DIR}`);
      console.log(`[${new Date().toISOString()}] Waiting for device pairing or a valid persisted session.`);
    } finally {
      startLock = false;
    }
  };

  await startSocket();

  const shutdown = (): void => {
    shuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    closeCurrentSocket();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: Error) => {
  console.error("Fatal error starting WhatsApp service:", error.message);
  process.exit(1);
});
