'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRequestId, redactTokenPath, sanitizeClientMetadata } = require('../lib/security');

test('redactTokenPath masks subscription token', () => {
    const out = redactTokenPath('/GMfWZNmbtqyR4fgk');
    assert.equal(out, '/GMfW...');
});

test('sanitizeClientMetadata does not leak device details', () => {
    const req = {
        headers: {
            'x-hwid': 'abc',
            'x-device-model': 'Pixel',
            'x-device-os': 'Android',
        },
    };

    assert.deepEqual(sanitizeClientMetadata(req), {
        hwid: 'present',
        device: 'present',
        os: 'present',
    });
});

test('normalizeRequestId accepts bounded safe values only', () => {
    assert.equal(normalizeRequestId('req-123_OK:trace.1', 'fallback'), 'req-123_OK:trace.1');
    assert.equal(normalizeRequestId('bad request id', 'fallback'), 'fallback');
    assert.equal(normalizeRequestId('x'.repeat(129), 'fallback'), 'fallback');
    assert.equal(normalizeRequestId(['first', 'second'], 'fallback'), 'first');
});
