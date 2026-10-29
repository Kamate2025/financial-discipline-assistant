const test = require('node:test');
const assert = require('node:assert/strict');
const {
  api, dispatchMessage, onboardingState, registeredPhones, profileStatusCache, processedMessages,
} = require('../dist/handlers.js');
const groq = require('../dist/groq.js');

const phone = '256787360381';
const from = `${phone}@s.whatsapp.net`;
const original = {};
const activeCountries = [{ name: 'Uganda', country_code: 'UG', currency_code: 'UGX', currency_name: 'Ugandan shilling' }];
let originalInterpretMessage;

function expenseInterpretation(amount, description, transactionDate = new Date().toISOString().slice(0, 10)) {
  return {
    intent: 'RECORD_EXPENSE', statementStatus: 'COMPLETED', confidence: 'HIGH', transactionType: 'EXPENSE',
    amount: String(amount), previousAmount: '', currency: 'UGX', description, category: 'FOOD', transactionDate,
    period: 'UNSPECIFIED', startDate: '', endDate: '', compareStartDate: '', compareEndDate: '', name: '',
    searchQuery: '', fieldsToChange: [], missingInformation: 'NONE',
  };
}

test.beforeEach(() => {
  originalInterpretMessage = groq.interpretMessage;
  for (const key of ['resolvePhone', 'saveWhatsAppProfile', 'saveWhatsAppCountry', 'getOnboardingStatus', 'getActiveCountries', 'recordTransaction', 'getSummary', 'getFinancialInsights', 'getPendingAction', 'savePendingAction', 'clearPendingAction', 'deleteAccountData']) {
    original[key] = api[key];
  }
  api.getOnboardingStatus = async () => ({ registered: true, preferred_name: 'Kamate', needs_name: false, needs_country: false, currency_code: 'UGX' });
  api.getActiveCountries = async () => activeCountries;
  api.getPendingAction = async () => null;
  api.savePendingAction = async () => {};
  api.clearPendingAction = async () => {};
  api.getFinancialInsights = async (phoneNumber, params) => ({
    start_date: params.start_date, end_date: params.end_date, transaction_count: 0,
    currencies: [], comparisons: [], matching_transactions: [], largest_expenses: [],
  });
  api.deleteAccountData = async () => {};
  api.saveWhatsAppCountry = async () => ({ created: false });
  onboardingState.clear();
  registeredPhones.clear();
  profileStatusCache.clear();
  processedMessages.clear();
});

test.afterEach(() => {
  groq.interpretMessage = originalInterpretMessage;
  for (const [key, value] of Object.entries(original)) api[key] = value;
  onboardingState.clear();
  registeredPhones.clear();
  profileStatusCache.clear();
  processedMessages.clear();
});

test('a bare name deterministically completes onboarding without calling Groq', async () => {
  onboardingState.add(phone);
  let saved;
  api.saveWhatsAppProfile = async (...args) => { saved = args; return { created: true }; };
  api.getOnboardingStatus = async () => ({ registered: true, preferred_name: 'Kamate', needs_name: false, needs_country: true });
  const replies = [];

  await dispatchMessage(from, 'Kamate', 'name-message-1', async (_to, text) => replies.push(text));

  assert.deepEqual(saved, [phone, 'Kamate']);
  assert.equal(onboardingState.has(phone), false);
  assert.equal(registeredPhones.has(phone), true);
  assert.match(replies[0], /Nice to meet you, Kamate/);
  assert.match(replies[1], /Uganda \(UGX/);
});

test('a greeting starts onboarding and an unregistered expense cannot create a profile or transaction', async () => {
  let profileChecks = 0;
  let transactionWrites = 0;
  api.resolvePhone = async () => { profileChecks += 1; return false; };
  api.getOnboardingStatus = async () => ({ registered: false });
  api.saveWhatsAppProfile = async () => { throw new Error('name was not supplied'); };
  api.recordTransaction = async () => { transactionWrites += 1; };
  const replies = [];

  await dispatchMessage(from, 'Hello', 'greeting-new-1', async (_to, text) => replies.push(text));
  assert.match(replies[0], /what's your name/i);
  assert.match(replies[0], /Kamate Group Ltd/);
  assert.equal(onboardingState.has(phone), true);

  await dispatchMessage(from, 'I spent 50,000 on lunch today', 'expense-awaiting-name-1', async (_to, text) => replies.push(text));
  assert.equal(profileChecks, 0, 'the name prompt state handles the reply without another profile lookup');
  assert.equal(transactionWrites, 0);
  assert.match(replies[1], /tell me your name/i);
});

test('a saved name resumes at country selection and applies the configured currency', async () => {
  registeredPhones.add(phone);
  let savedCountry;
  api.getOnboardingStatus = async () => ({ registered: true, preferred_name: 'Sam', needs_name: false, needs_country: true });
  api.saveWhatsAppCountry = async (_phone, code) => { savedCountry = code; return { created: false }; };
  const replies = [];

  await dispatchMessage(from, '1', 'country-select-1', async (_to, text) => replies.push(text));

  assert.equal(savedCountry, 'UG');
  assert.match(replies[0], /all set with UGX/i);
  assert.match(replies[0], /first transaction/i);
});

test('an interrupted country step can be resumed from persisted onboarding state', async () => {
  let statusCalls = 0;
  api.resolvePhone = async () => true;
  api.getOnboardingStatus = async () => {
    statusCalls += 1;
    return { registered: true, preferred_name: 'Sam', needs_name: false, needs_country: true };
  };
  const replies = [];
  await dispatchMessage(from, 'Uganda', 'country-resume-1', async (_to, text) => replies.push(text));
  assert.equal(statusCalls, 1);
  assert.match(replies[0], /all set with UGX/i);
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

test('the requested comma-formatted expense persists before FinTrack confirms it', async () => {
  groq.interpretMessage = async () => ({
    intent: 'RECORD_EXPENSE', statementStatus: 'COMPLETED', confidence: 'HIGH', transactionType: 'EXPENSE',
    amount: '50000', previousAmount: '', currency: 'UGX', description: 'lunch', category: 'FOOD',
    transactionDate: new Date().toISOString().slice(0, 10), period: 'UNSPECIFIED', startDate: '', endDate: '',
    compareStartDate: '', compareEndDate: '', name: '', searchQuery: '', fieldsToChange: [], missingInformation: 'NONE',
  });
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

test('a clear expense command records deterministically without waiting for Groq', async () => {
  registeredPhones.add(phone);
  groq.interpretMessage = async () => { throw new Error('Groq should not be called'); };
  let transactionWrites = 0;
  api.recordTransaction = async () => { transactionWrites += 1; };
  const replies = [];
  await dispatchMessage(from, 'I spent 50,000 on lunch today', 'expense-groq-offline', async (_to, text) => replies.push(text));
  assert.equal(transactionWrites, 1);
  assert.match(replies[0], /Recorded: UGX 50,000 for lunch/);
});

test('300 meat keeps its known fields in a durable pending clarification when Groq is down', async () => {
  registeredPhones.add(phone);
  groq.interpretMessage = async () => { throw new Error('offline'); };
  let pending;
  api.savePendingAction = async (_phone, action_type, payload, original_message_id) => { pending = { action_type, payload, original_message_id }; };
  const replies = [];
  await dispatchMessage(from, '300 meat', 'ambiguous-meat-1', async (_to, text) => replies.push(text));
  assert.equal(pending.action_type, 'TRANSACTION');
  assert.deepEqual(pending.payload, {
    amount: '300', currency: 'UGX', description: 'meat', activity_date: pending.payload.activity_date,
  });
  assert.match(replies[0], /UGX 300 for meat.*expense.*received/i);
});

test('a failed Django write never receives a success confirmation', async () => {
  registeredPhones.add(phone);
  groq.interpretMessage = async () => expenseInterpretation(50000, 'lunch');
  api.recordTransaction = async () => { throw new Error('write rejected'); };
  const replies = [];
  await dispatchMessage(from, 'I spent 50,000 on lunch today', 'expense-failed-1', async (_to, text) => replies.push(text));
  assert.equal(replies.some((text) => text.startsWith('Recorded:')), false);
  assert.match(replies[0], /couldn't record/i);
});

test('an outbound failure after persistence is not reported as a Django write failure', async () => {
  registeredPhones.add(phone);
  groq.interpretMessage = async () => expenseInterpretation(2000, 'a drink');
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
  groq.interpretMessage = async () => expenseInterpretation(2000, 'a drink');
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
  api.getFinancialInsights = async (_phone, params) => { range = [params.start_date, params.end_date]; return { transaction_count: 0, currencies: [], comparisons: [] }; };
  const replies = [];
  await dispatchMessage(from, 'How much have I spent today?', 'summary-today-1', async (_to, text) => replies.push(text));
  assert.equal(range[0], range[1]);
  assert.match(replies[0], /No matching transactions were recorded/);
});

test('show my summary takes the deterministic Django command path', async () => {
  registeredPhones.add(phone);
  let summaryCalls = 0;
  api.getFinancialInsights = async () => { summaryCalls += 1; return { transaction_count: 0, currencies: [], comparisons: [] }; };
  const replies = [];
  await dispatchMessage(from, 'Show my summary', 'summary-show-1', async (_to, text) => replies.push(text));
  assert.equal(summaryCalls, 1);
  assert.match(replies[0], /No matching transactions were recorded/);
  assert.match(replies[0], /\*FinTrack \| Summary\*/);
  assert.match(replies[0], /October|2026/);
  assert.doesNotMatch(replies[0], /Loans received: UGX 0|Income: UGX 0|Expenses: UGX 0/);
});

test('a summary request is handled while an unrelated transaction clarification remains pending', async () => {
  registeredPhones.add(phone);
  const pending = { action_type: 'TRANSACTION', payload: { amount: '30000', description: 'dinner', activity_type: 'EXPENSE' }, original_message_id: 'pending-meal' };
  api.getPendingAction = async () => pending;
  let cleared = false;
  api.clearPendingAction = async () => { cleared = true; };
  let query;
  api.getFinancialInsights = async (_phone, params) => { query = params; return { transaction_count: 0, currencies: [], comparisons: [], matching_transactions: [], largest_expenses: [] }; };
  const replies = [];
  await dispatchMessage(from, 'show my summary', 'summary-while-pending', async (_to, text) => replies.push(text));
  assert.ok(query);
  assert.equal(cleared, false);
  assert.match(replies[0], /FinTrack \| Summary/);
});

test('repeat summary requests reuse profile status and skip pending-action reads', async () => {
  registeredPhones.add(phone);
  let profileReads = 0;
  let pendingReads = 0;
  api.getOnboardingStatus = async () => { profileReads += 1; return { registered: true, preferred_name: 'Kamate', needs_name: false, needs_country: false, currency_code: 'UGX' }; };
  api.getPendingAction = async () => { pendingReads += 1; return null; };
  const send = async () => {};
  await dispatchMessage(from, 'show my summary', 'fast-summary-1', send);
  await dispatchMessage(from, 'show my summary', 'fast-summary-2', send);
  assert.equal(profileReads, 1);
  assert.equal(pendingReads, 0);
});

test('profile-name questions return the saved name without invoking Groq', async () => {
  registeredPhones.add(phone);
  groq.interpretMessage = async () => { throw new Error('profile questions must bypass Groq'); };
  const replies = [];
  await dispatchMessage(from, 'Remind me my name', 'profile-name-1', async (_to, text) => replies.push(text));
  assert.equal(replies[0], 'Your saved name is Kamate.');
});

test('an earnings-only monthly query bypasses a stale transaction clarification', async () => {
  registeredPhones.add(phone);
  let pendingReads = 0;
  let insightParams;
  api.getPendingAction = async () => { pendingReads += 1; return { action_type: 'TRANSACTION', payload: { amount: '5000' } }; };
  api.getFinancialInsights = async (_phone, params) => { insightParams = params; return { transaction_count: 0, currencies: [], comparisons: [], matching_transactions: [], largest_expenses: [] }; };
  groq.interpretMessage = async () => { throw new Error('income query must bypass Groq'); };
  const replies = [];
  await dispatchMessage(from, 'Hello, send me my earning only for this month', 'income-only-month-1', async (_to, text) => replies.push(text));
  assert.equal(pendingReads, 0);
  assert.match(insightParams.start_date, /^\d{4}-\d{2}-01$/);
  assert.match(replies[0], /No earned income was recorded/);
});

test('menu option wording and human support bypass a stale transaction clarification', async () => {
  registeredPhones.add(phone);
  let pendingReads = 0;
  api.getPendingAction = async () => { pendingReads += 1; return { action_type: 'TRANSACTION', payload: { amount: '5000' } }; };
  const replies = [];
  await dispatchMessage(from, 'Option 5 in menu', 'menu-option-five-1', async (_to, text) => replies.push(text));
  await dispatchMessage(from, 'They are not picking my calls', 'call-support-1', async (_to, text) => replies.push(text));
  assert.equal(pendingReads, 0);
  assert.match(replies[0], /human support/i);
  assert.match(replies[1], /contact Kamate Group Ltd/i);
});

test('date-prefixed transaction is persisted with its explicit date and amount', async () => {
  registeredPhones.add(phone);
  groq.interpretMessage = async () => expenseInterpretation(100, 'bag keeping at the campus library', '2026-10-22');
  let payload;
  api.recordTransaction = async (_phone, value) => { payload = value; return { id: 44 }; };
  const replies = [];
  await dispatchMessage(from, '22/10/2026 I paid 100 UGX for bag keeping at the campus library', 'expense-date-1', async (_to, text) => replies.push(text));
  assert.equal(payload.amount, '100');
  assert.equal(payload.activity_date, '2026-10-22');
  assert.equal(payload.description, 'bag keeping at the campus library');
  assert.match(replies[0], /Recorded: UGX 100/);
});

test('a completed refund uses its own transaction type and is persisted before confirmation', async () => {
  registeredPhones.add(phone);
  groq.interpretMessage = async () => ({
    intent: 'RECORD_REFUND', statementStatus: 'COMPLETED', confidence: 'HIGH', transactionType: 'REFUND',
    amount: '15000', previousAmount: '', currency: 'UGX', description: 'returned shoes', category: 'SHOPPING',
    transactionDate: '2026-10-22', period: 'UNSPECIFIED', startDate: '', endDate: '', compareStartDate: '', compareEndDate: '', name: '', searchQuery: '',
    fieldsToChange: [], missingInformation: 'NONE',
  });
  let payload;
  api.recordTransaction = async (_phone, value) => { payload = value; return { id: 51 }; };
  const replies = [];
  await dispatchMessage(from, 'I got a refund of 15000 UGX for the shoes today', 'refund-1', async (_to, text) => replies.push(text));
  assert.equal(payload.activity_type, 'REFUND');
  assert.equal(payload.amount, '15000');
  assert.match(replies[0], /Recorded: UGX 15,000/);
});

test('a pending transaction clarification is completed using the saved details', async () => {
  registeredPhones.add(phone);
  groq.interpretMessage = async () => ({
    intent: 'CLARIFICATION', statementStatus: 'COMPLETED', confidence: 'HIGH', transactionType: '', amount: '', previousAmount: '',
    currency: '', description: '', category: '', transactionDate: '', period: 'UNSPECIFIED', startDate: '', endDate: '', compareStartDate: '', compareEndDate: '', name: '',
    searchQuery: '', fieldsToChange: [], missingInformation: 'NONE',
  });
  api.getPendingAction = async () => ({ action_type: 'TRANSACTION', payload: { amount: '25000', currency: 'UGX', description: 'taxi fare', activity_type: 'EXPENSE', activity_date: '2026-10-22' }, original_message_id: 'clarify-original' });
  let payload;
  let writeCount = 0;
  let cleared = false;
  api.recordTransaction = async (_phone, value, messageId) => { writeCount += 1; payload = [value, messageId]; return { id: 52 }; };
  api.clearPendingAction = async () => { cleared = true; };
  const replies = [];
  await dispatchMessage(from, 'to work', 'clarify-answer', async (_to, text) => replies.push(text));
  assert.equal(payload[0].amount, '25000');
  assert.equal(payload[0].description, 'taxi fare');
  assert.equal(payload[1], 'clarify-answer');
  assert.equal(writeCount, 1);
  assert.equal(cleared, true);
  assert.match(replies[0], /Recorded: UGX 25,000/);
  await dispatchMessage(from, 'to work', 'clarify-answer', async (_to, text) => replies.push(text));
  assert.equal(writeCount, 1, 'redelivery of the clarification event is idempotent');
});

test('a natural-language date lookup returns only the database result and its exact amount', async () => {
  registeredPhones.add(phone);
  groq.interpretMessage = async () => ({
    intent: 'TRANSACTION_LOOKUP', statementStatus: 'QUESTION', confidence: 'HIGH', transactionType: '', amount: '', previousAmount: '', currency: '', description: '', category: '',
    transactionDate: '2026-10-15', period: 'CUSTOM', startDate: '2026-10-15', endDate: '2026-10-15', compareStartDate: '', compareEndDate: '', name: '', searchQuery: '', fieldsToChange: [], missingInformation: 'NONE',
  });
  let params;
  api.getFinancialInsights = async (_phone, value) => { params = value; return {
    transaction_count: 1, currencies: [], comparisons: [], largest_expenses: [],
    matching_transactions: [{ activity_date: '2026-10-15', description: 'Lunch at Africana Hotel with my friend', amount: '15000.00', currency: 'UGX' }],
  }; };
  const replies = [];
  await dispatchMessage(from, 'What did I buy on 15th October 2026?', 'lookup-date-1', async (_to, text) => replies.push(text));
  assert.equal(params.start_date, '2026-10-15');
  assert.equal(params.end_date, '2026-10-15');
  assert.match(replies[0], /UGX 15,000 for Lunch at Africana Hotel with my friend/);
});

test('menu and privacy are shown only when requested and use honest text actions', async () => {
  registeredPhones.add(phone);
  const replies = [];
  await dispatchMessage(from, 'Show my menu', 'menu-request-1', async (_to, text) => replies.push(text));
  await dispatchMessage(from, 'What data do you store?', 'privacy-request-1', async (_to, text) => replies.push(text));
  assert.match(replies[0], /FinTrack menu/);
  assert.match(replies[0], /not clickable buttons/);
  assert.match(replies[1], /does not read bank or mobile money accounts/);
  assert.match(replies[1], /delete my FinTrack account/);
  assert.equal(replies.length, 2);
});

test('human support requests return the configured WhatsApp contact', async () => {
  registeredPhones.add(phone);
  const replies = [];
  await dispatchMessage(from, 'I need human support', 'support-request-1', async (_to, text) => replies.push(text));
  assert.match(replies[0], /Kamate Group Ltd/);
  assert.match(replies[0], /https:\/\/wa\.me\/256787360381/);
});

test('account data is deleted only after the persisted confirmation phrase', async () => {
  registeredPhones.add(phone);
  api.getPendingAction = async () => ({ action_type: 'ACCOUNT_DELETE_CONFIRM', payload: {}, original_message_id: 'delete-request-1' });
  let deleted;
  api.deleteAccountData = async (_phone, messageId) => { deleted = messageId; };
  const replies = [];
  await dispatchMessage(from, 'delete my account', 'delete-confirm-1', async (_to, text) => replies.push(text));
  assert.equal(deleted, 'delete-confirm-1');
  assert.equal(registeredPhones.has(phone), false);
  assert.match(replies[0], /account and saved financial records have been deleted/);
});

test('cancelling an account deletion confirmation preserves the account', async () => {
  registeredPhones.add(phone);
  api.getPendingAction = async () => ({ action_type: 'ACCOUNT_DELETE_CONFIRM', payload: {}, original_message_id: 'delete-request-2' });
  let deleted = false;
  let cleared = false;
  api.deleteAccountData = async () => { deleted = true; };
  api.clearPendingAction = async () => { cleared = true; };
  const replies = [];
  await dispatchMessage(from, 'Cancel', 'delete-cancel-1', async (_to, text) => replies.push(text));
  assert.equal(deleted, false);
  assert.equal(registeredPhones.has(phone), true);
  assert.equal(cleared, true);
  assert.match(replies[0], /Cancelled. Nothing was changed/);
});

test('end-to-end mocked WhatsApp flow completes onboarding, records, summarizes, compares, corrects, deletes, and helps', async () => {
  let profileReady = false;
  let countryReady = false;
  let pending = null;
  const records = [];
  let updated = false;
  api.resolvePhone = async () => profileReady;
  api.getOnboardingStatus = async () => ({
    registered: profileReady,
    preferred_name: profileReady ? 'Sam' : undefined,
    needs_name: false,
    needs_country: profileReady && !countryReady,
    currency_code: countryReady ? 'UGX' : null,
    time_zone: 'Africa/Kampala',
  });
  api.saveWhatsAppProfile = async () => { profileReady = true; return { created: true }; };
  api.getActiveCountries = async () => activeCountries;
  api.saveWhatsAppCountry = async (_phone, code) => { assert.equal(code, 'UG'); countryReady = true; return { created: false }; };
  api.getPendingAction = async () => pending;
  api.savePendingAction = async (_phone, action_type, payload, original_message_id) => { pending = { action_type, payload, original_message_id }; };
  api.clearPendingAction = async () => { pending = null; };
  api.recordTransaction = async (_phone, payload, messageId) => { records.push({ id: 1, ...payload, messageId, is_voided: false }); return records[0]; };
  api.getTransactions = async (_phone, search = '', recent = false, amount = '') => records.filter((row) => !row.is_voided && (!search || row.description.toLowerCase().includes(search.toLowerCase())) && (!amount || Number(row.amount) === Number(amount)));
  api.updateTransaction = async (_phone, id, changes) => { Object.assign(records.find((row) => row.id === id), changes); updated = true; return records[0]; };
  api.voidTransaction = async (_phone, id) => { records.find((row) => row.id === id).is_voided = true; return records[0]; };
  api.getFinancialInsights = async (_phone, params) => {
    const matched = records.filter((row) => !row.is_voided && row.activity_date >= params.start_date && row.activity_date <= params.end_date && (!params.search || row.description.toLowerCase().includes(params.search.toLowerCase())));
    const expenses = matched.filter((row) => row.activity_type === 'EXPENSE');
    const total = expenses.reduce((sum, row) => sum + Number(row.amount), 0);
    const prior = records.filter((row) => !row.is_voided && params.compare_start_date && row.activity_date >= params.compare_start_date && row.activity_date <= params.compare_end_date && row.activity_type === 'EXPENSE');
    return {
      transaction_count: matched.length, matching_transactions: matched, largest_expenses: expenses.slice().sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 5),
      currencies: matched.length ? [{ currency: 'UGX', income_total: '0.00', expense_total: total.toFixed(2), refund_total: '0.00', loan_received_total: '0.00', loan_repayment_total: '0.00', net_cash_flow: (-total).toFixed(2), category_breakdown: [{ category: 'FOOD', expense_total: total.toFixed(2) }], daily_expenses: [] }] : [],
      comparisons: params.compare_start_date ? [{ currency: 'UGX', current_expense_total: total.toFixed(2), previous_expense_total: prior.reduce((sum, row) => sum + Number(row.amount), 0).toFixed(2), current_income_total: '0.00', previous_income_total: '0.00', category_changes: [] }] : [],
    };
  };
  const base = {
    statementStatus: 'QUESTION', confidence: 'HIGH', transactionType: '', amount: '', previousAmount: '', currency: '', description: '', category: '', transactionDate: '', period: 'CUSTOM', startDate: '', endDate: '', compareStartDate: '', compareEndDate: '', name: '', searchQuery: '', fieldsToChange: [], missingInformation: 'NONE',
  };
  groq.interpretMessage = async (text) => {
    if (text.toLowerCase().startsWith('spent 15k')) return { ...base, intent: 'RECORD_EXPENSE', statementStatus: 'COMPLETED', confidence: 'HIGH', transactionType: 'EXPENSE', amount: '15000', currency: 'UGX', description: 'lunch at Africana Hotel with my friend', category: 'FOOD', transactionDate: '2026-10-15' };
    if (text.startsWith('What did I buy')) return { ...base, intent: 'TRANSACTION_LOOKUP', transactionDate: '2026-10-15', startDate: '2026-10-15', endDate: '2026-10-15' };
    if (text.startsWith('Show category')) return { ...base, intent: 'SPENDING_BREAKDOWN', startDate: '2026-10-01', endDate: '2026-10-31' };
    if (text.startsWith('Compare October')) return { ...base, intent: 'COMPARE_PERIODS', startDate: '2026-10-01', endDate: '2026-10-31', compareStartDate: '2026-09-01', compareEndDate: '2026-09-30' };
    if (text.startsWith('Correct')) return { ...base, intent: 'CORRECT_TRANSACTION', searchQuery: 'lunch', previousAmount: '15000', amount: '20000', fieldsToChange: ['amount'] };
    if (text.startsWith('Delete')) return { ...base, intent: 'DELETE_TRANSACTION', searchQuery: 'lunch' };
    return { ...base, intent: 'HELP' };
  };
  const replies = [];
  const send = async (_to, text) => replies.push(text);
  await dispatchMessage(from, 'Hello', 'e2e-hello', send);
  assert.match(replies.at(-1), /what should I call you/i);
  await dispatchMessage(from, 'Sam', 'e2e-name', send);
  assert.match(replies.at(-1), /Which country/);
  await dispatchMessage(from, 'Uganda', 'e2e-country', send);
  assert.match(replies.at(-1), /UGX/);
  await dispatchMessage(from, 'Spent 15k on lunch at Africana Hotel with my friend on 15th October 2026', 'e2e-expense', send);
  assert.equal(records[0].amount, '15000');
  assert.match(records[0].description, /lunch at Africana Hotel with my friend/i);
  assert.equal(records[0].currency, 'UGX');
  assert.equal(records[0].activity_date, '2026-10-15');
  await dispatchMessage(from, 'What did I buy on 15th October 2026?', 'e2e-date-summary', send);
  assert.match(replies.at(-1), /UGX 15,000/);
  await dispatchMessage(from, 'Show category breakdown for October', 'e2e-breakdown', send);
  assert.match(replies.at(-1), /FOOD: UGX 15,000/);
  await dispatchMessage(from, 'Compare October with September', 'e2e-compare', send);
  assert.match(replies.at(-1), /2026-09-01 to 2026-09-30 vs 2026-10-01 to 2026-10-31/);
  await dispatchMessage(from, 'Correct my lunch expense to 20k', 'e2e-correct', send);
  assert.match(replies.at(-1), /Reply yes to confirm/);
  await dispatchMessage(from, 'yes', 'e2e-correct-confirm', send);
  assert.equal(updated, true);
  await dispatchMessage(from, 'Delete the lunch transaction', 'e2e-delete', send);
  assert.match(replies.at(-1), /Reply yes to confirm/);
  await dispatchMessage(from, 'yes', 'e2e-delete-confirm', send);
  assert.equal(records[0].is_voided, true);
  await dispatchMessage(from, 'Help me use FinTrack', 'e2e-help', send);
  assert.match(replies.at(-1), /show my menu/);
});
