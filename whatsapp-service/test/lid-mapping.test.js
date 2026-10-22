const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Baileys6LidMappingStore,
  resolveIncomingSender,
} = require('../dist/lid-mapping.js');

test('private phone JID resolves to the same verified identity and reply recipient', () => {
  const result = resolveIncomingSender({ remoteJid: '256787360381@s.whatsapp.net' });
  assert.equal(result.phoneJid, '256787360381@s.whatsapp.net');
  assert.equal(result.replyJid, '256787360381@s.whatsapp.net');
  assert.equal(result.reason, 'resolved');
});

test('private LID resolves through Baileys 6 senderPn metadata, never from its numeric localpart', () => {
  const result = resolveIncomingSender({
    remoteJid: '918273645@lid',
    senderLid: '918273645@lid',
    senderPn: '+256787360381@s.whatsapp.net',
  });
  assert.equal(result.phoneJid, '256787360381@s.whatsapp.net');
  assert.equal(result.replyJid, '256787360381@s.whatsapp.net');
  assert.equal(result.isLid, true);
});

test('a validated runtime alternate phone JID is accepted when Baileys supplies it', () => {
  const result = resolveIncomingSender({
    remoteJid: '918273645@lid',
    remoteJidAlt: '256787360381@s.whatsapp.net',
  });
  assert.equal(result.phoneJid, '256787360381@s.whatsapp.net');
  assert.equal(result.replyJid, '256787360381@s.whatsapp.net');
  assert.equal(result.resolutionSource, 'alternate_phone_jid');
});

test('private LID resolves from a chats.phoneNumberShare mapping and replies to that LID', () => {
  const store = new Baileys6LidMappingStore();
  assert.equal(store.addPhoneNumberShare('918273645@lid', '256787360381@s.whatsapp.net'), true);
  const result = resolveIncomingSender({ remoteJid: '918273645@lid' }, store);
  assert.equal(result.phoneJid, '256787360381@s.whatsapp.net');
  assert.equal(result.replyJid, '918273645@lid');
  assert.equal(result.mappingFound, true);
});

test('unmapped LID has no profile identity or reply target; its number is never treated as a phone', () => {
  const result = resolveIncomingSender({ remoteJid: '256787360381@lid' }, new Baileys6LidMappingStore());
  assert.equal(result.phoneJid, null);
  assert.equal(result.replyJid, null);
  assert.equal(result.reason, 'unmapped_lid');
  assert.equal(result.mappingStoreAvailable, true);
});

test('missing, malformed, group, and invalid alternate sender fields cannot resolve a profile', () => {
  for (const key of [
    undefined,
    {},
    { remoteJid: null },
    { remoteJid: '12345@lid', senderPn: '12345@lid' },
    { remoteJid: '120363000000000@g.us', participantPn: '256787360381@s.whatsapp.net' },
  ]) {
    const result = resolveIncomingSender(key, new Baileys6LidMappingStore());
    assert.equal(result.phoneJid, null);
    assert.equal(
      ['group_or_broadcast', 'unsupported_sender', 'unmapped_lid'].includes(result.reason),
      true,
    );
  }
});

test('invalid phone-share mappings are rejected and cannot later attribute messages', () => {
  const store = new Baileys6LidMappingStore();
  assert.equal(store.addPhoneNumberShare('777@lid', '777@s.whatsapp.net'), false);
  assert.equal(resolveIncomingSender({ remoteJid: '777@lid' }, store).phoneJid, null);
});
