import axios from "axios";
import { createBaileysClient, SESSION_DIR, renderQrCode } from "./client";
import { dispatchMessage } from "./handlers";
import { loadServiceConfig } from "./config";

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
  const { backendBaseUrl, serviceKey } = loadServiceConfig();

  const djangoHealth = await checkDjangoHealth(backendBaseUrl);
  console.log(`[${new Date().toISOString()}] Backend URL: ${backendBaseUrl}`);
  console.log(`[${new Date().toISOString()}] Service key configured: ${serviceKey ? "yes" : "no"}`);
  console.log(`[${new Date().toISOString()}] ${djangoHealth.message}`);

  if (!djangoHealth.reachable) {
    console.warn(`[${new Date().toISOString()}] Continuing startup, but the Django backend is not reachable yet.`);
  }

  const sock = await createBaileysClient(
    async (from: string, text: string, messageId: string): Promise<void> => {
      await dispatchMessage(from, text, messageId, async (to: string, message: string): Promise<void> => {
        const jid = `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
      });
    },
    (qr: string): void => {
      renderQrCode(qr);
    },
    (status: string): void => {
      console.log(`[${new Date().toISOString()}] Connection status: ${status}`);
      if (status === "logged_out") {
        console.warn("[WhatsApp] The current auth session is not valid or has been revoked. Open the QR code again to re-link the device.");
      }
    }
  );

  console.log(`[${new Date().toISOString()}] FD WhatsApp service is running.`);
  console.log(`[${new Date().toISOString()}] Session directory: ${SESSION_DIR}`);
  console.log(`[${new Date().toISOString()}] Waiting for device pairing or a valid persisted session.`);
}

main().catch((error: Error) => {
  console.error("Fatal error starting WhatsApp service:", error.message);
  process.exit(1);
});