const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { acquireSessionProcessLock } = require('../dist/instance-lock.js');

test('only one process can own a session lock, and normal release permits a later owner', () => {
  const sessionDir = path.join(os.tmpdir(), `fd-lock-test-${crypto.randomUUID()}`);
  const release = acquireSessionProcessLock(sessionDir);
  try {
    assert.throws(() => acquireSessionProcessLock(sessionDir), /already has a bridge owner/);
  } finally {
    release();
  }

  const releaseAgain = acquireSessionProcessLock(sessionDir);
  releaseAgain();
});

test('a lock owned by an exited process is reclaimed safely', () => {
  const sessionDir = path.join(os.tmpdir(), `fd-stale-lock-test-${crypto.randomUUID()}`);
  const normalizedSessionDir = path.resolve(sessionDir).toLowerCase();
  const suffix = crypto.createHash('sha256').update(normalizedSessionDir).digest('hex').slice(0, 16);
  const lockPath = path.join(os.tmpdir(), `fd-whatsapp-session-${suffix}.lock`);
  const recoveryPath = `${lockPath}.recovery`;
  const stalePid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  fs.writeFileSync(lockPath, JSON.stringify({ pid: stalePid, createdAt: new Date(0).toISOString() }));

  const release = acquireSessionProcessLock(sessionDir);
  try {
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
    assert.equal(fs.existsSync(recoveryPath), false);
  } finally {
    release();
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    if (fs.existsSync(recoveryPath)) fs.unlinkSync(recoveryPath);
  }
});
