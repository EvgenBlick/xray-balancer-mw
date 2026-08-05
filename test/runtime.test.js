'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenCache, createRateLimiter, createKeyedRateLimiter } = require('../lib/runtime');

test('token cache returns fresh values and expires old ones', async () => {
    const cache = createTokenCache(1, 10);
    cache.set('tok', '{"ok":true}', { 'content-type': 'application/json' });

    assert.equal(cache.get('tok').body, '{"ok":true}');

    await new Promise(r => setTimeout(r, 1100));
    assert.equal(cache.get('tok'), null);
});

test('token cache can return stale within configured window', async () => {
    const cache = createTokenCache(1, 10);
    cache.set('tok', '{"ok":true}', {});
    await new Promise(r => setTimeout(r, 1100));

    assert.equal(cache.get('tok'), null);
    assert.equal(cache.getStale('tok', 5).body, '{"ok":true}');
    assert.equal(cache.getStale('tok', 0), null);
});

test('stale reads do not extend stale window lifetime', async () => {
    const cache = createTokenCache(1, 10);
    cache.set('tok', '{"ok":true}', {});
    await new Promise(r => setTimeout(r, 1100));

    assert.ok(cache.getStale('tok', 2));
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(cache.getStale('tok', 2), null);
});

test('token cache evicts oldest items when limit exceeded', () => {
    const cache = createTokenCache(30, 2);
    cache.set('a', 'A', {});
    cache.set('b', 'B', {});
    cache.set('c', 'C', {});

    assert.equal(cache.get('a'), null);
    assert.equal(cache.get('b').body, 'B');
    assert.equal(cache.get('c').body, 'C');
});

test('token cache can be cleared after runtime config changes', () => {
    const cache = createTokenCache(30, 10);
    cache.set('a', 'A', {});
    cache.set('b', 'B', {});

    assert.equal(cache.clear(), 2);
    assert.equal(cache.get('a'), null);
    assert.equal(cache.getStale('b', 60), null);
    assert.equal(cache.clear(), 0);
});

test('token cache reports size and byte usage across overwrite and clear', () => {
    const cache = createTokenCache(30, 10);
    const emptyHeadersBytes = Buffer.byteLength('{}');

    cache.set('a', 'one', {});
    cache.set('b', 'four', {});
    assert.equal(cache.size(), 2);
    assert.equal(cache.bytes(), 7 + (2 * emptyHeadersBytes));

    cache.set('a', 'x', {});
    assert.equal(cache.size(), 2);
    assert.equal(cache.bytes(), 5 + (2 * emptyHeadersBytes));

    assert.equal(cache.clear(), 2);
    assert.equal(cache.size(), 0);
    assert.equal(cache.bytes(), 0);
});

test('token cache evicts least recently used items to stay within maxBytes', () => {
    const cache = createTokenCache(30, 10, { maxBytes: 12 });
    cache.set('a', '1111', {});
    cache.set('b', '2222', {});
    assert.equal(cache.get('a').body, '1111');

    cache.set('c', '3333', {});

    assert.equal(cache.get('a').body, '1111');
    assert.equal(cache.get('b'), null);
    assert.equal(cache.get('c').body, '3333');
    assert.equal(cache.size(), 2);
    assert.equal(cache.bytes(), 12);
});

test('token cache rejects oversized items and removes an overwritten value', () => {
    const cache = createTokenCache(30, { maxEntries: 10, maxBytes: 20, maxItemBytes: 6 });
    cache.set('a', '1234', {});
    assert.equal(cache.get('a').body, '1234');
    assert.equal(cache.bytes(), 6);

    cache.set('a', '12345', {});
    assert.equal(cache.get('a'), null);
    assert.equal(cache.size(), 0);
    assert.equal(cache.bytes(), 0);
});

test('token cache decrements byte usage when stale entries expire', async () => {
    const cache = createTokenCache(1, 10);
    cache.set('a', '1234', {});
    assert.equal(cache.bytes(), 6);

    await new Promise(r => setTimeout(r, 10));
    assert.equal(cache.getStale('a', 0), null);
    assert.equal(cache.size(), 0);
    assert.equal(cache.bytes(), 0);
});

test('rate limiter blocks burst overflow', () => {
    const limiter = createRateLimiter(100, 2);
    const ip = '1.1.1.1';

    assert.equal(limiter.allow(ip, 1000), true);
    assert.equal(limiter.allow(ip, 1001), true);
    assert.equal(limiter.allow(ip, 1002), false);
});

test('rate limiter cleanup cursor eventually reaches stale tail entries', () => {
    const limiter = createRateLimiter(100, 100, {
        idleMs: 1000,
        cleanupBatch: 1,
        cleanupIntervalMs: 1,
    });

    assert.equal(limiter.allow('hot', 0), true);
    assert.equal(limiter.allow('stale-1', 0), true);
    assert.equal(limiter.allow('stale-2', 0), true);
    assert.equal(limiter.size(), 3);

    assert.equal(limiter.allow('hot', 2000), true);
    assert.equal(limiter.allow('hot', 2002), true);
    assert.equal(limiter.allow('hot', 2004), true);

    assert.equal(limiter.size(), 1);
});

test('rate limiter keeps a bounded number of IP entries', () => {
    const limiter = createRateLimiter(1, 1, {
        idleMs: 600000,
        maxEntries: 2,
    });

    assert.equal(limiter.allow('1.1.1.1', 1000), true);
    assert.equal(limiter.allow('1.1.1.1', 1001), false);
    assert.equal(limiter.allow('2.2.2.2', 1002), true);
    assert.equal(limiter.allow('3.3.3.3', 1003), true);
    assert.equal(limiter.size(), 2);

    assert.equal(limiter.allow('1.1.1.1', 1004), true);
    assert.equal(limiter.size(), 2);
});

test('keyed limiter keeps bounded number of token buckets', () => {
    const limiter = createKeyedRateLimiter(100, 100, {
        idleMs: 600000,
        maxEntries: 3,
        cleanupBatch: 1,
    });

    assert.equal(limiter.allow('t1', 1000), true);
    assert.equal(limiter.allow('t2', 1001), true);
    assert.equal(limiter.allow('t3', 1002), true);
    assert.equal(limiter.size(), 3);

    assert.equal(limiter.allow('t4', 1003), true);
    assert.equal(limiter.size(), 3);
});

test('keyed limiter performs cleanup only after cleanup interval', () => {
    const limiter = createKeyedRateLimiter(100, 100, {
        idleMs: 1000,
        cleanupBatch: 100,
        cleanupIntervalMs: 10000,
        maxEntries: 10,
    });

    assert.equal(limiter.allow('t1', 0), true);
    assert.equal(limiter.allow('t2', 1), true);
    assert.equal(limiter.size(), 2);

    assert.equal(limiter.allow('t3', 2000), true);
    assert.equal(limiter.size(), 3);

    assert.equal(limiter.allow('t4', 10001), true);
    assert.equal(limiter.size(), 1);
});
