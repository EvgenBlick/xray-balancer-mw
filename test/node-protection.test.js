'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    NODE_STATES,
    createNodeProtectionManager,
    normalizeNodeName,
} = require('../lib/node-protection');

test('normalizes node names and rejects empty names', () => {
    assert.equal(normalizeNodeName('  Germany-1  '), 'germany-1');

    const manager = createNodeProtectionManager();
    assert.throws(() => manager.recordFailure('  ', {}, 1000), /nodeName/);
});

test('tracks failures by normalized name and isolates at the configured threshold', () => {
    const manager = createNodeProtectionManager({
        failureThreshold: 2,
        isolationTtlSec: 30,
    });

    const first = manager.recordFailure(' Germany-1 ', { reason: 'timeout', source: 'probe' }, 1000);
    assert.equal(first.node.state, NODE_STATES.SUSPECT);
    assert.equal(first.node.failureCount, 1);
    assert.deepEqual(first.events.map((event) => [event.from, event.to]), [['healthy', 'suspect']]);

    const second = manager.recordFailure('GERMANY-1', { reason: 'packet_loss', source: 'probe' }, 2000);
    assert.equal(second.isolated, true);
    assert.equal(second.node.normalizedNode, 'germany-1');
    assert.equal(second.node.state, NODE_STATES.ISOLATED);
    assert.deepEqual(second.node.isolation, {
        mode: 'automatic',
        reason: 'packet_loss',
        source: 'probe',
        isolatedAt: 2000,
        expiresAt: 32000,
    });
    assert.equal(manager.summary(2000).total, 1);
});

test('a success returns a suspect node to healthy', () => {
    const manager = createNodeProtectionManager({ failureThreshold: 3 });
    manager.recordFailure('Node-A', {}, 1000);

    const result = manager.recordSuccess('node-a', {}, 2000);
    assert.equal(result.node.state, NODE_STATES.HEALTHY);
    assert.equal(result.node.failureCount, 0);
    assert.equal(result.events.at(-1).reason, 'health_check_recovered');
});

test('automatic isolation requires both ttl expiry and consecutive recovery successes', () => {
    const manager = createNodeProtectionManager({
        failureThreshold: 1,
        recoverySuccessThreshold: 2,
        isolationTtlSec: 10,
    });
    manager.recordFailure('Node-A', {}, 1000);

    const first = manager.recordSuccess('Node-A', {}, 2000);
    assert.equal(first.node.state, NODE_STATES.RECOVERING);
    assert.equal(first.isolated, true);

    const second = manager.recordSuccess('Node-A', {}, 3000);
    assert.equal(second.node.state, NODE_STATES.RECOVERING);
    assert.equal(second.node.recoverySuccessCount, 2);

    const expired = manager.expire(11000);
    assert.deepEqual(expired.expired, ['node-a']);
    assert.equal(manager.get('Node-A', 11000).state, NODE_STATES.HEALTHY);
    assert.equal(manager.isIsolated('Node-A', 11000), false);
});

test('automatic isolation stays active after ttl without enough healthy probes', () => {
    const manager = createNodeProtectionManager({
        failureThreshold: 1,
        recoverySuccessThreshold: 2,
        isolationTtlSec: 5,
    });
    manager.recordFailure('Node-A', {}, 1000);

    assert.deepEqual(manager.expire(6000).expired, []);
    assert.equal(manager.isIsolated('Node-A', 6000), true);

    manager.recordSuccess('Node-A', {}, 7000);
    const recovered = manager.recordSuccess('Node-A', {}, 8000);
    assert.equal(recovered.node.state, NODE_STATES.HEALTHY);
    assert.equal(recovered.events.at(-1).reason, 'automatic_isolation_recovered');
});

test('failure during recovery returns the node to isolation and extends ttl', () => {
    const manager = createNodeProtectionManager({
        failureThreshold: 1,
        recoverySuccessThreshold: 2,
        isolationTtlSec: 10,
    });
    manager.recordFailure('Node-A', {}, 1000);
    manager.recordSuccess('Node-A', {}, 2000);

    const result = manager.recordFailure('Node-A', { ttlSec: 20, reason: 'port_down' }, 3000);
    assert.equal(result.node.state, NODE_STATES.ISOLATED);
    assert.equal(result.node.recoverySuccessCount, 0);
    assert.equal(result.node.isolation.expiresAt, 23000);
    assert.deepEqual(result.events.map((event) => [event.from, event.to]), [['recovering', 'isolated']]);
});

test('manual isolation stores metadata and expires automatically', () => {
    const manager = createNodeProtectionManager({ isolationTtlSec: 60 });
    const isolated = manager.isolateManual(' Finland Main ', {
        reason: 'ddos',
        source: 'cabinet',
        ttlSec: 10,
    }, 5000);

    assert.equal(isolated.node.normalizedNode, 'finland main');
    assert.deepEqual(isolated.node.isolation, {
        mode: 'manual',
        reason: 'ddos',
        source: 'cabinet',
        isolatedAt: 5000,
        expiresAt: 15000,
    });
    assert.equal(manager.get('FINLAND MAIN', 14999).state, NODE_STATES.ISOLATED);
    assert.equal(manager.get('FINLAND MAIN', 15000).state, NODE_STATES.HEALTHY);

    const events = manager.drainEvents();
    assert.deepEqual(events.map((event) => event.reason), ['ddos', 'manual_isolation_expired']);
});

test('manual isolation takes precedence over automatic isolation signals', () => {
    const manager = createNodeProtectionManager({ failureThreshold: 1 });
    manager.isolateManual('Node-A', { reason: 'operator', ttlSec: 30 }, 1000);

    const automatic = manager.isolateAutomatic('node-a', { reason: 'timeout', ttlSec: 5 }, 2000);
    const failed = manager.recordFailure('NODE-A', { reason: 'port_down' }, 3000);

    assert.equal(automatic.events.length, 0);
    assert.equal(failed.node.isolation.mode, 'manual');
    assert.equal(failed.node.isolation.reason, 'operator');
    assert.equal(failed.node.isolation.expiresAt, 31000);
});

test('manual isolation can replace automatic isolation and emits an update event', () => {
    const manager = createNodeProtectionManager({ failureThreshold: 1 });
    manager.recordFailure('Node-A', {}, 1000);
    manager.recordSuccess('Node-A', {}, 1500);

    const result = manager.isolateManual('node-a', {
        reason: 'confirmed_ddos',
        source: 'admin',
        ttlSec: 60,
    }, 2000);

    assert.equal(result.node.isolation.mode, 'manual');
    assert.equal(result.node.state, NODE_STATES.ISOLATED);
    assert.equal(result.events.at(-1).type, 'isolation_updated');
    assert.equal(result.events.at(-1).from, NODE_STATES.RECOVERING);
    assert.equal(result.events.at(-1).to, NODE_STATES.ISOLATED);
});

test('release clears manual or automatic protection and reports no-op releases', () => {
    const manager = createNodeProtectionManager();
    manager.isolateManual('Node-A', {}, 1000);

    const released = manager.release('node-a', { reason: 'operator_release', source: 'cabinet' }, 2000);
    assert.equal(released.released, true);
    assert.equal(released.node.state, NODE_STATES.HEALTHY);
    assert.equal(released.node.isolation, null);
    assert.equal(released.events.at(-1).reason, 'operator_release');

    const repeated = manager.release('NODE-A', {}, 3000);
    assert.equal(repeated.released, false);
    assert.equal(repeated.events.length, 0);
});

test('list and summary expose deterministic protected-node state', () => {
    const manager = createNodeProtectionManager({ failureThreshold: 2 });
    manager.recordSuccess('Zulu', {}, 1000);
    manager.recordFailure('Beta', {}, 1000);
    manager.isolateManual('Alpha', { ttlSec: 30 }, 1000);
    manager.isolateAutomatic('Gamma', { ttlSec: 30 }, 1000);
    manager.recordSuccess('Gamma', {}, 2000);

    assert.deepEqual(
        manager.list({ protectedOnly: true }, 2000).map((node) => node.normalizedNode),
        ['alpha', 'gamma'],
    );
    assert.deepEqual(manager.summary(2000), {
        total: 4,
        protected: 2,
        healthy: 1,
        suspect: 1,
        isolated: 1,
        recovering: 1,
        manual: 1,
        automatic: 1,
    });
});

test('transition event queue can be observed without mutation and drained once', () => {
    const manager = createNodeProtectionManager({ failureThreshold: 2 });
    manager.recordFailure('Node-A', {}, 1000);
    manager.recordFailure('Node-A', {}, 2000);

    const firstPeek = manager.peekEvents();
    firstPeek[0].reason = 'mutated';
    assert.equal(manager.peekEvents()[0].reason, 'health_check_failed');
    assert.deepEqual(manager.peekEvents().map((event) => event.id), [1, 2]);
    assert.equal(manager.drainEvents().length, 2);
    assert.deepEqual(manager.drainEvents(), []);
});

test('uses an injectable clock when timestamps are omitted', () => {
    let now = 1000;
    const manager = createNodeProtectionManager({
        failureThreshold: 1,
        isolationTtlSec: 5,
        now: () => now,
    });

    const result = manager.recordFailure('Node-A');
    assert.equal(result.node.lastFailureAt, 1000);
    assert.equal(result.node.isolation.expiresAt, 6000);

    now = 7000;
    assert.equal(manager.get('Node-A').state, NODE_STATES.ISOLATED);
});

test('returned snapshots do not expose mutable internal state', () => {
    const manager = createNodeProtectionManager();
    const result = manager.isolateManual('Node-A', { reason: 'ddos' }, 1000);
    result.node.isolation.reason = 'mutated';

    assert.equal(manager.get('Node-A', 1000).isolation.reason, 'ddos');
});
