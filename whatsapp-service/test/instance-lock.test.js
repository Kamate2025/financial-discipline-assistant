const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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
