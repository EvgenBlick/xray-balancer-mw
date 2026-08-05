'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStickyTokenKey, createStickyStore } = require('../lib/sticky');

test('sticky store reuses selected node while ttl is active', () => {
    const store = createStickyStore({ ttlSec: 60 });
    const outbounds = [{ tag: 'Germany-1' }, { tag: 'Germany-2' }];

    const first = store.choose('tok', outbounds, 1000);
    assert.equal(first.selected.tag, 'Germany-1');
    assert.equal(first.changed, true);

    const second = store.choose('tok', [{ tag: 'Germany-2' }, { tag: 'Germany-1' }], 2000);
    assert.equal(second.selected.tag, 'Germany-1');
    assert.equal(second.changed, false);
});

test('sticky store rotates to first available node when old one disappears', () => {
    const store = createStickyStore({ ttlSec: 60 });
    store.assign('tok', 'Germany-1', 1000);

    const result = store.choose('tok', [{ tag: 'Germany-2' }, { tag: 'Germany-3' }], 2000);
    assert.equal(result.selected.tag, 'Germany-2');
    assert.equal(result.changed, true);
});

test('sticky store expires entries after ttl', () => {
    const store = createStickyStore({ ttlSec: 2 });
    store.assign('tok', 'Germany-1', 1000);

    assert.equal(store.get('tok', 2000)?.nodeName, 'Germany-1');
    assert.equal(store.get('tok', 4001), null);
});

test('sticky store can refresh ttl for active assignments', () => {
    const store = createStickyStore({ ttlSec: 2 });
    store.assign('tok', 'Germany-1', 1000);

    const hit = store.choose('tok', [{ tag: 'Germany-1' }, { tag: 'Germany-2' }], 2500, {
        refreshTtlOnHit: true,
    });

    assert.equal(hit.selected.tag, 'Germany-1');
    assert.equal(hit.changed, false);
    assert.equal(store.get('tok', 4001)?.nodeName, 'Germany-1');
});

test('sticky store prefer keeps selected node first but preserves full pool', () => {
    const store = createStickyStore({ ttlSec: 60 });
    const outbounds = [{ tag: 'Germany-1' }, { tag: 'Germany-2' }, { tag: 'USA-1' }];

    const first = store.prefer('tok', outbounds, 1000);
    assert.deepEqual(first.orderedOutbounds.map((outbound) => outbound.tag), ['Germany-1', 'Germany-2', 'USA-1']);
    assert.equal(first.changed, true);

    const second = store.prefer('tok', [{ tag: 'Germany-2' }, { tag: 'USA-1' }, { tag: 'Germany-1' }], 2000);
    assert.deepEqual(second.orderedOutbounds.map((outbound) => outbound.tag), ['Germany-1', 'Germany-2', 'USA-1']);
    assert.equal(second.changed, false);
});

test('sticky scope keys keep per-group assignments isolated for the same token', () => {
    const store = createStickyStore({ ttlSec: 60 });
    const token = 'tok';
    const fastestKey = buildStickyTokenKey(token, 'fastest');
    const germanyKey = buildStickyTokenKey(token, 'group:🇩🇪 Германия');

    const fastest = store.prefer(fastestKey, [{ tag: 'Fast-DE-1' }, { tag: 'Fast-US-1' }], 1000);
    const germany = store.prefer(germanyKey, [{ tag: 'Germany-1' }, { tag: 'Germany-2' }], 1000);

    assert.equal(fastest.selected.tag, 'Fast-DE-1');
    assert.equal(germany.selected.tag, 'Germany-1');

    const nextFastest = store.prefer(fastestKey, [{ tag: 'Fast-US-1' }, { tag: 'Fast-DE-1' }], 2000);
    const nextGermany = store.prefer(germanyKey, [{ tag: 'Germany-2' }, { tag: 'Germany-1' }], 2000);

    assert.equal(nextFastest.selected.tag, 'Fast-DE-1');
    assert.equal(nextGermany.selected.tag, 'Germany-1');
    assert.notEqual(fastestKey, germanyKey);
});

test('sticky store releases every assignment for an isolated node', () => {
    const store = createStickyStore({ ttlSec: 60, maxEntries: 10 });
    store.assign('fastest::one', 'Germany-1', 1000);
    store.assign('group::one', 'germany-1', 1000);
    store.assign('fastest::two', 'Finland-1', 1000);

    assert.equal(store.releaseByNode(' Germany-1 ', 1100), 2);
    assert.equal(store.get('fastest::one', 1100), null);
    assert.equal(store.get('group::one', 1100), null);
    assert.equal(store.get('fastest::two', 1100).nodeName, 'Finland-1');
});
