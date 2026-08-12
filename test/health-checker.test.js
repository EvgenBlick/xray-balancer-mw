'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthChecker } = require('../lib/health-checker');

test('health-checker initializes and records probe results', () => {
    const checker = createHealthChecker({ targets: ['https://www.gstatic.com/generate_204'] });
    
    const r1 = checker.recordProbeResult('Node-1', { success: true, rttMs: 40 });
    assert.equal(r1.nodeName, 'Node-1');
    assert.equal(r1.lastRttMs, 40);
    assert.equal(r1.lossPercent, 0);

    const r2 = checker.recordProbeResult('Node-1', { success: false, isRst: true, isPartialBlock: true });
    assert.equal(r2.rstCount, 1);
    assert.equal(r2.partialBlock, true);
    assert.equal(r2.lossPercent, 50);
});

test('health-checker calculates jitter across multiple probes', () => {
    const checker = createHealthChecker();
    checker.recordProbeResult('Node-2', { success: true, rttMs: 50 });
    checker.recordProbeResult('Node-2', { success: true, rttMs: 70 });
    checker.recordProbeResult('Node-2', { success: true, rttMs: 40 });

    const m = checker.getMetrics('Node-2');
    assert.equal(m.avgRttMs, 53);
    assert.ok(m.jitterMs > 0);
});
