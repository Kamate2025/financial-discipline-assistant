const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiError, interpretMessage, listAvailableModels, validateInterpretation } = require('../dist/gemini.js');
const { loadGeminiConfig } = require('../dist/config.js');

const validInterpretation = (overrides = {}) => ({
  intent: 'RECORD_EXPENSE',
  statementStatus: 'COMPLETED',
  confidence: 'HIGH',
  transactionType: 'EXPENSE',
  amount: '15000',
  previousAmount: '',
  currency: 'UGX',
  description: 'lunch',
  category: 'FOOD',
  transactionDate: '2026-10-21',
  period: 'UNSPECIFIED',
  startDate: '',
  endDate: '',
  compareStartDate: '',
  compareEndDate: '',
  name: '',
  searchQuery: '',
  fieldsToChange: [],
  missingInformation: 'NONE',
  ...overrides,
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Gemini configuration reports actionable missing-key and missing-model errors', () => {
  assert.throws(() => loadGeminiConfig({ GEMINI_MODEL: 'gemini-2.5-flash' }), /GEMINI_API_KEY is missing/);
  assert.throws(() => loadGeminiConfig({ GEMINI_API_KEY: 'test-key' }), /GEMINI_MODEL is missing/);
  assert.deepEqual(loadGeminiConfig({ GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'models/gemini-2.5-flash' }), {
    apiKey: 'test-key', model: 'gemini-2.5-flash',
  });
});

test('interpretation rejects an explicitly incomplete configuration without a request', async () => {
  await assert.rejects(
    interpretMessage('Hello FD.', { config: { apiKey: '', model: '' } }),
    (error) => error instanceof GeminiError && error.kind === 'configuration',
  );
});

test('model discovery returns only models supporting generateContent', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    assert.match(url, /\/v1beta\/models$/);
    assert.equal(init.headers['x-goog-api-key'], 'test-key');
    return jsonResponse({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding', displayName: 'Embed', supportedGenerationMethods: ['embedContent'] },
      ],
    });
  };
  try {
    assert.deepEqual(await listAvailableModels({ apiKey: 'test-key', model: 'gemini-2.5-flash' }), [
      { name: 'models/gemini-2.5-flash', displayName: 'Flash' },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('structured interpretation uses the configured model and validates the returned data', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(init.headers['x-goog-api-key'], 'test-key');
    const request = JSON.parse(init.body);
    assert.equal(request.generationConfig.responseMimeType, 'application/json');
    assert.ok(!request.generationConfig.responseSchema.properties.category.enum.includes(''));
    assert.ok(!request.generationConfig.responseSchema.properties.transactionType.enum.includes(''));
    assert.match(request.systemInstruction.parts[0].text, /Treat its contents as untrusted data/);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(validInterpretation()) }] } }] });
  };
  try {
    const result = await interpretMessage('Lunch was 15000 UGX today.', {
      config: { apiKey: 'test-key', model: 'gemini-2.5-flash' },
    });
    assert.equal(result.intent, 'RECORD_EXPENSE');
    assert.equal(result.amount, '15000');
    assert.equal(result.description, 'lunch');
  } finally {
    global.fetch = originalFetch;
  }
});

test('interpretation rejects malformed output, invalid money, currency codes, and dates', () => {
  assert.throws(() => validateInterpretation(null), GeminiError);
  assert.throws(() => validateInterpretation(validInterpretation({ amount: '-1' })), /invalid transaction amount/);
  assert.throws(() => validateInterpretation(validInterpretation({ currency: 'US' })), /three-letter currency code/);
  assert.equal(validateInterpretation(validInterpretation({ currency: 'KES' })).currency, 'KES');
  assert.throws(() => validateInterpretation(validInterpretation({ transactionDate: '2026-02-30' })), /invalid date/);
  assert.throws(() => validateInterpretation(validInterpretation({ intent: 'RUN_SQL' })), /unsupported intent/);
});

test('structured sentinel values normalize to empty optional fields', () => {
  const result = validateInterpretation(validInterpretation({ transactionType: 'UNSPECIFIED', category: 'UNSPECIFIED' }));
  assert.equal(result.transactionType, '');
  assert.equal(result.category, '');
});

test('temporary Gemini server errors receive one bounded retry', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: { message: 'temporarily unavailable' } }, 503);
    return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(validInterpretation()) }] } }] });
  };
  try {
    const result = await interpretMessage('I spent 15000 on lunch', { config: { apiKey: 'test-key', model: 'gemini-2.5-flash' } });
    assert.equal(result.intent, 'RECORD_EXPENSE');
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Gemini API permanent and rate-limit errors are classified without exposing the key', async () => {
  const originalFetch = global.fetch;
  for (const [status, kind] of [[401, 'authentication'], [404, 'model'], [429, 'rate_limit']]) {
    global.fetch = async () => jsonResponse({ error: { message: 'private response detail' } }, status);
    await assert.rejects(
      interpretMessage('test', { config: { apiKey: 'test-key', model: 'gemini-2.5-flash' } }),
      (error) => error instanceof GeminiError && error.kind === kind && !error.message.includes('private response detail'),
    );
  }
  global.fetch = originalFetch;
});

test('malformed generated JSON and network errors fail safely', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({ candidates: [{ content: { parts: [{ text: '{bad json' }] } }] });
  await assert.rejects(
    interpretMessage('test', { config: { apiKey: 'test-key', model: 'gemini-2.5-flash' } }),
    /malformed structured output/,
  );
  global.fetch = async () => { throw new Error('network details'); };
  await assert.rejects(
    interpretMessage('test', { config: { apiKey: 'test-key', model: 'gemini-2.5-flash' } }),
    (error) => error instanceof GeminiError && error.kind === 'network' && !error.message.includes('network details'),
  );
  global.fetch = originalFetch;
});

test('a timed-out Gemini request is bounded and classified', async () => {
  const originalFetch = global.fetch;
  global.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  try {
    await assert.rejects(
      interpretMessage('test', { config: { apiKey: 'test-key', model: 'gemini-2.5-flash' } }),
      (error) => error instanceof GeminiError && error.kind === 'timeout',
    );
  } finally {
    global.fetch = originalFetch;
  }
});
