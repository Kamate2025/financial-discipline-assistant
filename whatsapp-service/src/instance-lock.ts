import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export function acquireSessionProcessLock(sessionDir: string): () => void {
  const normalizedSessionDir = path.resolve(sessionDir).toLowerCase();
  const suffix = crypto.createHash("sha256").update(normalizedSessionDir).digest("hex").slice(0, 16);
  const lockPath = path.join(os.tmpdir(), `fd-whatsapp-session-${suffix}.lock`);

  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      let owner = "unknown";
      try {
        const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (Number.isInteger(value?.pid)) owner = String(value.pid);
      } catch {
        // Keep the lock fail-closed if its owner record is unreadable.
      }
      throw new Error(`WhatsApp session already has a bridge owner (PID ${owner}); refusing a second socket. Lock: ${lockPath}`);
    }
    throw error;
  }

  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    try { fs.unlinkSync(lockPath); } catch { /* best effort cleanup */ }
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { fs.closeSync(descriptor); } catch { /* already closed */ }
    try {
      const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (value?.pid === process.pid) fs.unlinkSync(lockPath);
    } catch {
      // Never remove a lock whose ownership cannot be confirmed.
    }
  };
}
