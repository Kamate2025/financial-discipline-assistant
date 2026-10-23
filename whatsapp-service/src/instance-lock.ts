import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

function readLockOwner(lockPath: string): { pid: number; createdAt: string } | null {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (Number.isInteger(value?.pid) && value.pid > 0 && typeof value.createdAt === "string") {
      return { pid: value.pid, createdAt: value.createdAt };
    }
  } catch {
    // An unreadable owner record must stay fail-closed.
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but cannot be signalled. Treat every
    // result except ESRCH as alive so PID probing cannot steal an active lock.
    return error?.code !== "ESRCH";
  }
}

function writeLock(descriptor: number): void {
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
  fs.fsyncSync(descriptor);
}

export function acquireSessionProcessLock(sessionDir: string): () => void {
  const normalizedSessionDir = path.resolve(sessionDir).toLowerCase();
  const suffix = crypto.createHash("sha256").update(normalizedSessionDir).digest("hex").slice(0, 16);
  const lockPath = path.join(os.tmpdir(), `fd-whatsapp-session-${suffix}.lock`);

  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;

    const existingOwner = readLockOwner(lockPath);
    const ownerLabel = existingOwner ? String(existingOwner.pid) : "unknown";
    if (!existingOwner || isProcessAlive(existingOwner.pid)) {
      throw new Error(`WhatsApp session already has a bridge owner (PID ${ownerLabel}); refusing a second socket. Lock: ${lockPath}`);
    }

    // Only one contender may remove and replace a stale lock. Other startups
    // fail closed while this short recovery section is in progress.
    const recoveryPath = `${lockPath}.recovery`;
    let recoveryDescriptor: number;
    try {
      recoveryDescriptor = fs.openSync(recoveryPath, "wx", 0o600);
    } catch (recoveryError: any) {
      if (recoveryError?.code === "EEXIST") {
        throw new Error(`A stale WhatsApp session lock is already being recovered. Refusing a second socket. Lock: ${lockPath}`);
      }
      throw recoveryError;
    }

    const recoveryToken = crypto.randomUUID();
    try {
      fs.writeFileSync(recoveryDescriptor, JSON.stringify({ pid: process.pid, token: recoveryToken }), "utf8");
      fs.fsyncSync(recoveryDescriptor);
      const currentOwner = readLockOwner(lockPath);
      if (!currentOwner || currentOwner.pid !== existingOwner.pid || currentOwner.createdAt !== existingOwner.createdAt || isProcessAlive(currentOwner.pid)) {
        throw new Error(`WhatsApp session lock changed during stale-owner recovery. Refusing a second socket. Lock: ${lockPath}`);
      }
      fs.unlinkSync(lockPath);
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } finally {
      try { fs.closeSync(recoveryDescriptor); } catch { /* already closed */ }
      try {
        const recoveryOwner = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
        if (recoveryOwner?.pid === process.pid && recoveryOwner?.token === recoveryToken) fs.unlinkSync(recoveryPath);
      } catch {
        // Never remove a recovery marker whose ownership cannot be confirmed.
      }
    }
  }

  try {
    writeLock(descriptor);
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
