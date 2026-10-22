const test = require('node:test');
const assert = require('node:assert/strict');
const { processMessageUpsert, rememberOutboundMessageForRetry, getOutboundMessageForRetry } = require('../dist/client.js');
const { Baileys6LidMappingStore } = require('../dist/lid-mapping.js');

async function quietLogs(run) {
  const oldInfo = console.info;
  const oldWarn = console.warn;
  const oldError = console.error;
  console.info = console.warn = console.error = () => {};
  try { return await run(); }
  finally { console.info = oldInfo; console.warn = oldWarn; console.error = oldError; }
}

test('decrypted private LID message is dispatched with verified PN identity and reply route', async () => {
  await quietLogs(async () => {
    const calls = [];
    await processMessageUpsert({ type: 'notify', messages: [{
      key: { id: 'message-identity-1', remoteJid: '918273645@lid', senderPn: '256787360381@s.whatsapp.net' },
      message: { conversation: 'Hello' },
    }] }, async (...args) => calls.push(args), new Baileys6LidMappingStore());
    assert.deepEqual(calls, [[
      '256787360381@s.whatsapp.net', 'Hello', 'message-identity-1', '256787360381@s.whatsapp.net',
    ]]);
  });
});

test('ciphertext, incomplete, unmapped, self, and group events never reach financial handlers', async () => {
  await quietLogs(async () => {
    const calls = [];
    const store = new Baileys6LidMappingStore();
    await processMessageUpsert({ type: 'notify', messages: [
      { key: { id: 'ciphertext-1', remoteJid: '777@lid', fromMe: false }, message: null, messageStubType: 2 },
      { key: { id: 'empty-1', remoteJid: '777@lid' }, message: {} },
      { key: { id: 'unmapped-1', remoteJid: '777@lid' }, message: { conversation: 'I spent 1,000' } },
      { key: { id: 'self-1', remoteJid: '256700000000@s.whatsapp.net', fromMe: true }, message: { conversation: 'ignore' } },
      { key: { id: 'group-1', remoteJid: '120363000000000@g.us', participantPn: '256787360381@s.whatsapp.net' }, message: { conversation: 'ignore' } },
      { key: { remoteJid: '256700000000@s.whatsapp.net' }, message: { conversation: 'missing id' } },
    ] }, async (...args) => calls.push(args), store);
    assert.deepEqual(calls, []);
  });
});

test('recent outbound messages are available to Baileys retry handling without logging content', () => {
  const message = { conversation: 'private reply content' };
  rememberOutboundMessageForRetry({ key: { id: 'outbound-retry-1' }, message });
  assert.deepEqual(getOutboundMessageForRetry({ id: 'outbound-retry-1' }), message);
  assert.equal(getOutboundMessageForRetry({ id: 'missing-outbound' }), undefined);
});
