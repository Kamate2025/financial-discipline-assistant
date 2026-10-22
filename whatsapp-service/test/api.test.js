const test = require('node:test');
const assert = require('node:assert/strict');
const { isUnknownWhatsAppPhoneResponse } = require('../dist/api.js');

test('unknown WhatsApp phone is recognized with Django 403 authentication negotiation', () => {
  assert.equal(isUnknownWhatsAppPhoneResponse(403, 'Unknown WhatsApp phone number.'), true);
});

test('unknown WhatsApp phone remains recognized with HTTP 401', () => {
  assert.equal(isUnknownWhatsAppPhoneResponse(401, 'Unknown WhatsApp phone number.'), true);
});

test('generic forbidden and invalid service-key errors fail closed', () => {
  assert.equal(isUnknownWhatsAppPhoneResponse(403, 'Invalid service key.'), false);
  assert.equal(isUnknownWhatsAppPhoneResponse(403, 'Permission denied.'), false);
  assert.equal(isUnknownWhatsAppPhoneResponse(500, 'Unknown WhatsApp phone number.'), false);
});
