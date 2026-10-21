import fs from "fs";
import path from "path";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const ENV_FILE_PATH = path.join(PROJECT_ROOT, ".env");

function loadRootEnvFile(): void {
  if (!fs.existsSync(ENV_FILE_PATH)) {
    return;
  }

  const content = fs.readFileSync(ENV_FILE_PATH, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }

    const [key, ...rest] = line.split("=");
    const value = rest.join("=").trim();
    const normalizedKey = key.trim();
    const normalizedValue = value.replace(/^['"]|['"]$/g, "");

    if (normalizedKey && !(normalizedKey in process.env)) {
      process.env[normalizedKey] = normalizedValue;
    }
  }
}

export interface ServiceConfig {
  backendBaseUrl: string;
  serviceKey: string;
}

export function loadServiceConfig(): ServiceConfig {
  loadRootEnvFile();

  const backendBaseUrl = (process.env.DJANGO_BASE_URL || "http://127.0.0.1:8000").trim();
  const serviceKey = (process.env.DJANGO_SERVICE_KEY || "").trim();

  if (!backendBaseUrl) {
    throw new Error("DJANGO_BASE_URL is not configured.");
  }

  if (!serviceKey) {
    throw new Error("DJANGO_SERVICE_KEY is not configured.");
  }

  return {
    backendBaseUrl,
    serviceKey,
  };
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}
