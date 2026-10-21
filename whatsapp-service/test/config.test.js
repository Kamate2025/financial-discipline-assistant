const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServiceConfig, getProjectRoot } = require('../dist/config.js');
const { renderQrCode } = require('../dist/client.js');

test('loadServiceConfig resolves the project-root env values', () => {
  const config = loadServiceConfig();

  assert.ok(typeof config.backendBaseUrl === 'string');
  assert.ok(config.backendBaseUrl.startsWith('http'));
  assert.ok(typeof config.serviceKey === 'string');
  assert.ok(config.serviceKey.length > 0);
  assert.ok(getProjectRoot().endsWith('fd'));
});

test('renderQrCode prints a terminal QR without throwing', () => {
  assert.doesNotThrow(() => renderQrCode('test-qr-string'));
});
