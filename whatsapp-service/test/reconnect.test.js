const test = require('node:test');
const assert = require('node:assert/strict');
const { isRecoverableDisconnect, getReconnectDelay, getMessagePhoneJid, getMessageStatusName, describeError } = require('../dist/client.js');

test('restart required disconnects are treated as recoverable', () => {
  assert.equal(isRecoverableDisconnect(515), true);
  assert.equal(isRecoverableDisconnect(500), true, 'protocol errors can share Baileys badSession status 500');
  assert.equal(isRecoverableDisconnect(401), false, 'only explicit logged-out status invalidates the auth session');
  assert.equal(isRecoverableDisconnect(440), false, 'connection replacement must stop automatic takeover loops');
});

test('incoming sender resolution accepts phone JIDs and rejects unmapped LIDs and groups', () => {
  assert.equal(getMessagePhoneJid({ remoteJid: '256700000000@s.whatsapp.net' }), '256700000000@s.whatsapp.net');
  assert.equal(getMessagePhoneJid({ remoteJid: '123@lid', remoteJidAlt: '256700000000@s.whatsapp.net' }), '256700000000@s.whatsapp.net');
  assert.equal(getMessagePhoneJid({ remoteJid: '123:4@lid' }), null);
  assert.equal(getMessagePhoneJid({ remoteJid: '120363000000000@g.us' }), null);
});

test('safe error serialization preserves useful details without serializing arbitrary objects', () => {
  const details = describeError(new TypeError('decode failed'));
  assert.equal(details.name, 'TypeError');
  assert.equal(details.message, 'decode failed');
  assert.ok(details.stack.includes('TypeError: decode failed'));
  assert.equal(describeError({ secretPayload: 'do not log' }).message, 'Non-error value thrown');
});

test('reconnect delay grows but stays bounded', () => {
  assert.equal(getReconnectDelay(0), 1000);
  assert.equal(getReconnectDelay(1), 2000);
  assert.ok(getReconnectDelay(6) <= 30000);
});

test('outbound status mapping distinguishes server acceptance from recipient delivery and read', () => {
  assert.equal(getMessageStatusName(2), 'server_ack');
  assert.equal(getMessageStatusName(3), 'delivery_ack');
  assert.equal(getMessageStatusName(4), 'read');
  assert.equal(getMessageStatusName(99), 'unknown');
});
