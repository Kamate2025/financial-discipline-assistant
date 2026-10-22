const test = require('node:test');
const assert = require('node:assert/strict');
const {
  api, dispatchMessage, onboardingState, registeredPhones, processedMessages,
} = require('../dist/handlers.js');

const phone = '256787360381';
const from = `${phone}@s.whatsapp.net`;
const original = {};

test.beforeEach(() => {
  for (const key of ['resolvePhone', 'saveWhatsAppProfile', 'recordTransaction', 'getSummary']) {
    original[key] = api[key];
  }
  onboardingState.clear();
  registeredPhones.clear();
  processedMessages.clear();
});

test.afterEach(() => {
  for (const [key, value] of Object.entries(original)) api[key] = value;
  onboardingState.clear();
  registeredPhones.clear();
  processedMessages.clear();
});

test('a bare name deterministically completes onboarding without calling Gemini', async () => {
  onboardingState.add(phone);
  let saved;
  api.saveWhatsAppProfile = async (...args) => { saved = args; return { created: true }; };
  const replies = [];

  await dispatchMessage(from, 'Kamate', 'name-message-1', async (_to, text) => replies.push(text));

  assert.deepEqual(saved, [phone, 'Kamate']);
  assert.equal(onboardingState.has(phone), false);
  assert.equal(registeredPhones.has(phone), true);
  assert.match(replies[0], /Nice to meet you, Kamate/);
});

test('a greeting starts onboarding and an unregistered expense cannot create a profile or transaction', async () => {
  let profileChecks = 0;
  let transactionWrites = 0;
  api.resolvePhone = async () => { profileChecks += 1; return false; };
  api.saveWhatsAppProfile = async () => { throw new Error('name was not supplied'); };
  api.recordTransaction = async () => { transactionWrites += 1; };
  const replies = [];

  await dispatchMessage(from, 'Hello', 'greeting-new-1', async (_to, text) => replies.push(text));
  assert.match(replies[0], /what's your name/i);
  assert.equal(onboardingState.has(phone), true);

  await dispatchMessage(from, 'I spent 50,000 on lunch today', 'expense-awaiting-name-1', async (_to, text) => replies.push(text));
  assert.equal(profileChecks, 1);
  assert.equal(transactionWrites, 0);
  assert.match(replies[1], /tell me your name/i);
});

test('Ok during onboarding asks for the name again; an ordinary acknowledgement is natural', async () => {
  onboardingState.add(phone);
  const replies = [];
  await dispatchMessage(from, 'Ok', 'ack-onboarding-1', async (_to, text) => replies.push(text));
  assert.match(replies[0], /still need your name/i);

  onboardingState.clear();
  registeredPhones.add(phone);
  await dispatchMessage(from, 'Thanks', 'ack-registered-1', async (_to, text) => replies.push(text));
  assert.match(replies[1], /You're welcome/);
});

test('the requested comma-formatted expense persists before FD confirms it', async () => {
  registeredPhones.add(phone);
  let persisted = false;
  let payload;
  api.recordTransaction = async (...args) => {
    payload = args;
    await Promise.resolve();
    persisted = true;
    return { id: 42 };
  };
  const replies = [];

  await dispatchMessage(from, 'I spent 50,000 on lunch today', 'expense-message-1', async (_to, text) => {
    assert.equal(persisted, true, 'reply must follow the successful persistence response');
    replies.push(text);
  });

  assert.equal(payload[0], phone);
  assert.equal(payload[1].amount, '50000');
  assert.equal(payload[1].currency, 'UGX');
  assert.equal(payload[1].description, 'lunch');
  assert.equal(payload[1].activity_type, 'EXPENSE');
  assert.equal(payload[2], 'expense-message-1');
  assert.match(replies[0], /Recorded: UGX 50,000 for lunch/);
});

test('a failed Django write never receives a success confirmation', async () => {
  registeredPhones.add(phone);
  api.recordTransaction = async () => { throw new Error('write rejected'); };
  const replies = [];
  await dispatchMessage(from, 'I spent 50,000 on lunch today', 'expense-failed-1', async (_to, text) => replies.push(text));
  assert.equal(replies.some((text) => text.startsWith('Recorded:')), false);
  assert.match(replies[0], /couldn't record/i);
});

test('an outbound failure after persistence is not reported as a Django write failure', async () => {
  registeredPhones.add(phone);
  let persisted = false;
  api.recordTransaction = async () => { persisted = true; return { id: 45 }; };
  const replies = [];
  await assert.rejects(
    dispatchMessage(from, 'I spent 2000 UGX on a drink', 'reply-failure-after-commit', async (_to, text) => {
      replies.push(text);
      throw new Error('outbound socket unavailable');
    }),
    /outbound socket unavailable/,
  );
  assert.equal(persisted, true);
  assert.equal(replies.some((text) => /couldn't record/i.test(text)), false);
});

test('the exact unknown-phone response under Django 403 negotiation selects onboarding', async () => {
  registeredPhones.add(phone);
  api.recordTransaction = async () => {
    const error = new Error('forbidden');
    error.response = { status: 403, data: { detail: 'Unknown WhatsApp phone number.' } };
    throw error;
  };
  const replies = [];
  await dispatchMessage(from, 'I spent 2000 UGX on a drink', 'unknown-profile-403', async (_to, text) => replies.push(text));
  assert.equal(registeredPhones.has(phone), false);
  assert.equal(onboardingState.has(phone), true);
  assert.match(replies[0], /not registered/i);
});

test('today summary is fetched from Django for a single-day date range', async () => {
  registeredPhones.add(phone);
  let range;
  api.getSummary = async (_phone, startDate, endDate) => { range = [startDate, endDate]; return []; };
  const replies = [];
  await dispatchMessage(from, 'How much have I spent today?', 'summary-today-1', async (_to, text) => replies.push(text));
  assert.equal(range[0], range[1]);
  assert.match(replies[0], /No transactions recorded/);
});

test('show my summary takes the deterministic Django command path', async () => {
  registeredPhones.add(phone);
  let summaryCalls = 0;
  api.getSummary = async () => { summaryCalls += 1; return []; };
  const replies = [];
  await dispatchMessage(from, 'Show my summary', 'summary-show-1', async (_to, text) => replies.push(text));
  assert.equal(summaryCalls, 1);
  assert.match(replies[0], /No transactions recorded/);
});

test('date-prefixed transaction is persisted with its explicit date and amount', async () => {
  registeredPhones.add(phone);
  let payload;
  api.recordTransaction = async (_phone, value) => { payload = value; return { id: 44 }; };
  const replies = [];
  await dispatchMessage(from, '22/10/2026 I paid 100 UGX for bag keeping at the campus library', 'expense-date-1', async (_to, text) => replies.push(text));
  assert.equal(payload.amount, '100');
  assert.equal(payload.activity_date, '2026-10-22');
  assert.equal(payload.description, 'bag keeping at the campus library');
  assert.match(replies[0], /Recorded: UGX 100/);
});
