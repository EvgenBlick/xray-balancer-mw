'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readEffectiveRuntime } = require('../lib/runtime-config');

test('readEffectiveRuntime returns config-driven mutable settings', () => {
    const runtime = readEffectiveRuntime({
        probe_interval: '1m',
        probe_sampling: 2,
        probe_timeout: '4s',
        probe_connectivity_url: 'https://connectivitycheck.gstatic.com/generate_204',
        probe_http_method: 'GET',
        probe_url: 'https://www.gstatic.com/generate_204',
        fastest_probe_url: 'https://ya.ru',
        fastest_exclude_groups: ['🇷🇺 White List'],
        fastest_fallback: [' 🇪🇺 LTE ', '', 42],
        node_stats_exclude: [' 🇷🇺 White List ', '', 7],
        expand_groups_to_nodes: [' 🇩🇪 Germany ', '', 7],
        hidden_groups: [' 🇺🇸 USA ', '', 42],
        hidden_nodes: [' Germany-9 ', '', 7],
        quarantine_nodes: [' Pedze ', '', 42, 'DEplay'],
        auto_quarantine_nodes: [' Pedze ', '', 42],
        sticky_enabled: true,
        sticky_mode: 'prefer',
        sticky_new_connections_only: true,
        sticky_ttl_sec: 60,
        sticky_max_entries: 500,
        auto_quarantine_enabled: true,
        auto_quarantine_failures: 5,
        auto_quarantine_release_successes: 3,
        auto_quarantine_max_nodes: 50,
        auto_drain_enabled: true,
        auto_drain_failures: 4,
        auto_drain_release_successes: 3,
        auto_drain_load_threshold: 0.95,
        auto_drain_score_penalty: 0.7,
        protection_enabled: true,
        protection_failures: 2,
        protection_release_successes: 4,
        protection_isolation_ttl_sec: 600,
        protection_latency_threshold_ms: 1200,
        protection_min_available_nodes: 2,
        attack_nodes: [{ node: ' Germany-1 ', reason: 'ddos', source: 'admin', expires_at: '2030-01-01T00:00:00.000Z' }],
        emergency_fallback_enabled: true,
        emergency_fallback_max_nodes: 2,
        balancer_load_weight: 0.5,
        balancer_latency_weight: 0.5,
        balancer_max_latency_ms: 250,
        balancer_smoothing_alpha: 0.25,
        balancer_hysteresis_delta: 0.1,
    }, {});

    assert.equal(runtime.probeInterval, '1m');
    assert.equal(runtime.probeSampling, 2);
    assert.equal(runtime.probeTimeout, '4s');
    assert.equal(runtime.probeConnectivityUrl, 'https://connectivitycheck.gstatic.com/generate_204');
    assert.equal(runtime.probeHttpMethod, 'GET');
    assert.equal(runtime.fastestProbeUrl, 'https://ya.ru');
    assert.deepEqual(runtime.fastestExcludeGroups, ['🇷🇺 White List']);
    assert.deepEqual(runtime.fastestFallbackGroups, ['🇪🇺 LTE']);
    assert.deepEqual(runtime.nodeStatsExcludeGroups, ['🇷🇺 White List']);
    assert.deepEqual(runtime.expandGroupsToNodes, ['🇩🇪 Germany']);
    assert.deepEqual(runtime.hiddenGroups, ['🇺🇸 USA']);
    assert.deepEqual(runtime.hiddenNodes, ['Germany-9']);
    assert.deepEqual(runtime.quarantineNodes, ['Pedze', 'DEplay']);
    assert.deepEqual(runtime.autoQuarantineNodes, ['Pedze']);
    assert.equal(runtime.stickyEnabled, true);
    assert.equal(runtime.stickyMode, 'prefer');
    assert.equal(runtime.stickyNewConnectionsOnly, true);
    assert.equal(runtime.stickyTtlSec, 60);
    assert.equal(runtime.stickyMaxEntries, 500);
    assert.equal(runtime.autoQuarantineEnabled, true);
    assert.equal(runtime.autoQuarantineFailures, 5);
    assert.equal(runtime.autoQuarantineReleaseSuccesses, 3);
    assert.equal(runtime.autoQuarantineMaxNodes, 50);
    assert.equal(runtime.autoDrainEnabled, true);
    assert.equal(runtime.autoDrainFailures, 4);
    assert.equal(runtime.autoDrainReleaseSuccesses, 3);
    assert.equal(runtime.autoDrainLoadThreshold, 0.95);
    assert.equal(runtime.autoDrainScorePenalty, 0.7);
    assert.equal(runtime.protectionEnabled, true);
    assert.equal(runtime.protectionFailures, 2);
    assert.equal(runtime.protectionReleaseSuccesses, 4);
    assert.equal(runtime.protectionIsolationTtlSec, 600);
    assert.equal(runtime.protectionLatencyThresholdMs, 1200);
    assert.equal(runtime.protectionMinAvailableNodes, 2);
    assert.deepEqual(runtime.attackNodes, [{ node: 'Germany-1', reason: 'ddos', source: 'admin', mode: 'manual', expires_at: '2030-01-01T00:00:00.000Z' }]);
    assert.equal(runtime.emergencyFallbackEnabled, true);
    assert.equal(runtime.emergencyFallbackMaxNodes, 2);
    assert.equal(runtime.balancerLoadWeight, 0.5);
    assert.equal(runtime.balancerLatencyWeight, 0.5);
    assert.equal(runtime.balancerMaxLatencyMs, 250);
    assert.equal(runtime.balancerSmoothingAlpha, 0.25);
    assert.equal(runtime.balancerHysteresisDelta, 0.1);
});

test('readEffectiveRuntime honors env overrides for mutable settings', () => {
    const runtime = readEffectiveRuntime({
        probe_url: 'https://www.gstatic.com/generate_204',
        sticky_enabled: true,
        sticky_mode: 'prefer',
        sticky_new_connections_only: false,
        sticky_ttl_sec: 60,
        sticky_max_entries: 500,
        auto_quarantine_enabled: false,
        auto_quarantine_failures: 5,
        auto_drain_enabled: true,
        auto_drain_load_threshold: 0.95,
        balancer_load_weight: 0.5,
        balancer_max_latency_ms: 250,
    }, {
        STICKY_ENABLED: 'false',
        STICKY_NEW_CONNECTIONS_ONLY: 'true',
        STICKY_TTL_SEC: '120',
        STICKY_MAX_ENTRIES: '750',
        AUTO_QUARANTINE_ENABLED: 'true',
        AUTO_QUARANTINE_FAILURES: '9',
        AUTO_DRAIN_ENABLED: 'false',
        AUTO_DRAIN_LOAD_THRESHOLD: '0.9',
        BALANCER_LOAD_WEIGHT: '0.7',
        BALANCER_MAX_LATENCY_MS: '200',
    });

    assert.equal(runtime.fastestProbeUrl, 'https://www.gstatic.com/generate_204');
    assert.equal(runtime.stickyEnabled, false);
    assert.equal(runtime.stickyMode, 'prefer');
    assert.equal(runtime.stickyNewConnectionsOnly, true);
    assert.equal(runtime.stickyTtlSec, 120);
    assert.equal(runtime.stickyMaxEntries, 750);
    assert.equal(runtime.autoQuarantineEnabled, true);
    assert.equal(runtime.autoQuarantineFailures, 9);
    assert.equal(runtime.autoDrainEnabled, false);
    assert.equal(runtime.autoDrainLoadThreshold, 0.9);
    assert.equal(runtime.balancerLoadWeight, 0.7);
    assert.equal(runtime.balancerMaxLatencyMs, 200);
});

test('readEffectiveRuntime normalizes fastest exclude groups', () => {
    const runtime = readEffectiveRuntime({
        fastest_exclude_groups: [' Germany ', '', 7],
    }, {});

    assert.deepEqual(runtime.fastestExcludeGroups, ['Germany']);
});

test('readEffectiveRuntime ignores out-of-range smoothing alpha env override', () => {
    const runtime = readEffectiveRuntime({}, {
        BALANCER_SMOOTHING_ALPHA: '2',
    });

    assert.equal(runtime.balancerSmoothingAlpha, 0.35);
});
