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

test('multiple amounts require clarification instead of a guessed transaction', () => {
  assert.deepEqual(parseMessage('I paid 2000 UGX for Sting and 100 UGX for bag keeping'), {
    type: 'AMBIGUOUS',
    question: 'I found more than one amount. Please send one transaction at a time, with a separate amount for each.',
  });
});

test('summary commands are deterministic', () => {
  assert.equal(parseMessage('Show my summary').type, 'SUMMARY');
  assert.equal(parseMessage('What did I spend on today?').type, 'SUMMARY');
});
