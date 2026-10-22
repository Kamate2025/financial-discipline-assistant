const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessage } = require('../dist/parser.js');

test('comma-formatted expenses keep the exact amount and clean description', () => {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.deepEqual(parseMessage('I spent 50,000 on lunch today'), {
    type: 'TRANSACTION',
    activity_type: 'EXPENSE',
    amount: 50000,
    currency: 'UGX',
    description: 'lunch',
    activity_date: date,
  });
});

test('an omitted currency uses the selected profile preference', () => {
  const parsed = parseMessage('I spent 50,000 on lunch today', 'KES');
  assert.equal(parsed.type, 'TRANSACTION');
  assert.equal(parsed.currency, 'KES');
});

test('an explicitly supplied three-letter currency is preserved', () => {
  const parsed = parseMessage('I spent 50,000 KES on lunch today', 'UGX');
  assert.equal(parsed.type, 'TRANSACTION');
  assert.equal(parsed.currency, 'KES');
});

test('a today summary uses the current date for both query bounds', () => {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.deepEqual(parseMessage('How much have I spent today?'), {
    type: 'SUMMARY', period: 'custom', start_date: date, end_date: date,
  });
});

test('date-prefixed expense uses the transaction amount, not the date digits', () => {
  assert.deepEqual(parseMessage('22/10/2026 I paid 100 UGX for bag keeping at the campus library'), {
    type: 'TRANSACTION', activity_type: 'EXPENSE', amount: 100, currency: 'UGX',
    description: 'bag keeping at the campus library', activity_date: '2026-10-22',
  });
});

test('ISO date-prefixed expense excludes the date from amount and description', () => {
  assert.deepEqual(parseMessage('2026-10-21: I spent 2000 UGX on Sting'), {
    type: 'TRANSACTION', activity_type: 'EXPENSE', amount: 2000, currency: 'UGX',
    description: 'Sting', activity_date: '2026-10-21',
  });
});

test('named date with year is excluded from the amount and full description', () => {
  const result = parseMessage('Spent 15k on lunch at Africana Hotel with my friend on 15th October 2026', 'UGX', 'Africa/Kampala');
  assert.equal(result.type, 'TRANSACTION');
  assert.equal(result.amount, 15000);
  assert.equal(result.activity_date, '2026-10-15');
  assert.equal(result.description, 'lunch at Africana Hotel with my friend');
});

test('multiple amounts require clarification instead of a guessed transaction', () => {
  assert.deepEqual(parseMessage('I paid 2000 UGX for Sting and 100 UGX for bag keeping'), {
    type: 'AMBIGUOUS',
    question: 'I found more than one amount. Please send one transaction at a time, with a separate amount for each.',
  });
});

test('an amount and description without a financial direction are preserved for clarification', () => {
  for (const [input, amount, description] of [['300 meat', '300', 'meat'], ['5000 transport', '5000', 'transport'], ['90000 dinner', '90000', 'dinner']]) {
    const parsed = parseMessage(input);
    assert.equal(parsed.type, 'AMBIGUOUS');
    assert.match(parsed.question, new RegExp(`UGX ${Number(amount).toLocaleString('en-US')} for ${description}.*expense.*received`, 'i'));
    assert.equal(parsed.pendingTransaction.amount, amount);
    assert.equal(parsed.pendingTransaction.currency, 'UGX');
    assert.equal(parsed.pendingTransaction.description, description);
    assert.match(parsed.pendingTransaction.activity_date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('summary commands are deterministic', () => {
  assert.equal(parseMessage('Show my summary').type, 'SUMMARY');
  assert.equal(parseMessage('What did I spend on today?').type, 'SUMMARY');
});
