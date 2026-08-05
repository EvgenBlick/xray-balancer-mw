'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateConfig } = require('../lib/config');

test('config.json.example is valid', () => {
    const examplePath = path.join(__dirname, '..', 'config.json.example');
    const cfg = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
    assert.deepEqual(validateConfig(cfg), cfg);
});

test('validateConfig accepts a valid config', () => {
    const cfg = {
        port: 4100,
        sub_path: '/api/sub',
        remnawave_url: 'https://panel.example.com',
        sub_page_url: 'http://subscription-page:3010',
        sub_domain: 'sub.example.com',
        strategy: 'leastLoad',
        fastest_group: true,
        node_stats: true,
        api_token: 'panel-token',
        panel_auth_cookie: '',
        max_users_per_gb: 20,
        max_users_per_cpu: 40,
        groups: {
            '🇩🇪 Germany': ['German'],
        },
    };

    assert.deepEqual(validateConfig(cfg), cfg);
});

test('validateConfig accepts leastPing strategy aliases', () => {
    assert.deepEqual(validateConfig({ strategy: 'leastPing' }), { strategy: 'leastPing' });
    assert.deepEqual(validateConfig({ strategy: 'leastping' }), { strategy: 'leastping' });
});

test('validateConfig rejects invalid port', () => {
    assert.throws(() => validateConfig({ port: 70000 }), /config\.port/);
});

test('validateConfig rejects malformed groups', () => {
    assert.throws(() => validateConfig({ groups: { test: [] } }), /at least one pattern/);
});

test('validateConfig accepts runtime and fastest-exclude options', () => {
    const cfg = {
        profile_mode: 'stable',
        admin_token: 'supersecret',
        fastest_probe_url: 'https://ya.ru',
        probe_sampling: 1,
        probe_timeout: '3s',
        probe_connectivity_url: 'https://connectivitycheck.gstatic.com/generate_204',
        probe_http_method: 'HEAD',
        fastest_exclude_groups: ['🇷🇺 White List'],
        fastest_fallback: ['🇪🇺 LTE'],
        node_stats_exclude: ['🇷🇺 White List'],
        expand_groups_to_nodes: ['🇩🇪 Germany'],
        hidden_groups: ['🇺🇸 USA'],
        hidden_nodes: ['Germany-99'],
        sticky_enabled: true,
        sticky_mode: 'prefer',
        sticky_ttl_sec: 3600,
        sticky_max_entries: 10000,
        cache_ttl_sec: 300,
        cache_stale_if_error_sec: 1800,
        cache_max_entries: 1000,
        rate_limit_per_minute: 120,
        rate_limit_burst_10s: 30,
        token_limiter_max_entries: 5000,
        token_limiter_cleanup_batch: 200,
        ready_success_window_sec: 300,
        protection_enabled: true,
        protection_failures: 2,
        protection_release_successes: 3,
        protection_isolation_ttl_sec: 300,
        protection_latency_threshold_ms: 1500,
        protection_min_available_nodes: 1,
        emergency_fallback_enabled: true,
        emergency_fallback_max_nodes: 1,
        attack_nodes: [{ node: 'Germany-1', reason: 'ddos', source: 'admin', expires_at: '2030-01-01T00:00:00.000Z' }],
    };

    assert.deepEqual(validateConfig(cfg), cfg);
});

test('validateConfig rejects malformed fastest probe url', () => {
    assert.throws(() => validateConfig({ fastest_probe_url: 'ya.ru' }), /fastest_probe_url/);
});

test('validateConfig rejects malformed supported URLs', () => {
    assert.throws(() => validateConfig({ remnawave_url: 'panel.example.com' }), /remnawave_url/);
    assert.throws(() => validateConfig({ sub_page_url: 'subscription-page:3010' }), /sub_page_url/);
});

test('validateConfig rejects malformed hidden lists', () => {
    assert.throws(() => validateConfig({ hidden_groups: [''] }), /hidden_groups/);
    assert.throws(() => validateConfig({ hidden_nodes: [42] }), /hidden_nodes/);
    assert.throws(() => validateConfig({ fastest_fallback: [''] }), /fastest_fallback/);
    assert.throws(() => validateConfig({ node_stats_exclude: [42] }), /node_stats_exclude/);
    assert.throws(() => validateConfig({ expand_groups_to_nodes: [''] }), /expand_groups_to_nodes/);
});

test('validateConfig rejects invalid sticky mode', () => {
    assert.throws(() => validateConfig({ sticky_mode: 'smart' }), /sticky_mode/);
});

test('validateConfig rejects too many groups and overly long patterns', () => {
    const groups = {};
    for (let i = 0; i < 101; i += 1) {
        groups[`G${i}`] = ['ok'];
    }
    assert.throws(() => validateConfig({ groups }), /at most 100 groups/);

    assert.throws(
        () => validateConfig({ groups: { main: ['x'.repeat(129)] } }),
        /longer than 128 chars/,
    );
});

test('validateConfig validates quarantine_nodes', () => {
    const cfg = {
        quarantine_nodes: ['Germany-1', 'USA Main'],
        auto_quarantine_nodes: ['Germany-1'],
    };
    assert.deepEqual(validateConfig(cfg), cfg);

    assert.throws(
        () => validateConfig({ quarantine_nodes: [''] }),
        /quarantine_nodes contains invalid node name/,
    );
    assert.throws(
        () => validateConfig({ auto_quarantine_nodes: [''] }),
        /auto_quarantine_nodes contains invalid node name/,
    );
});

test('validateConfig bounds smoothing alpha to 0..1', () => {
    assert.deepEqual(validateConfig({ balancer_smoothing_alpha: 0 }), { balancer_smoothing_alpha: 0 });
    assert.deepEqual(validateConfig({ balancer_smoothing_alpha: 1 }), { balancer_smoothing_alpha: 1 });
    assert.throws(
        () => validateConfig({ balancer_smoothing_alpha: 1.5 }),
        /balancer_smoothing_alpha must be <= 1/,
    );
});

test('validateConfig rejects malformed protection settings', () => {
    assert.throws(() => validateConfig({ probe_http_method: 'POST' }), /probe_http_method/);
    assert.throws(() => validateConfig({ probe_connectivity_url: 'connectivity.test' }), /probe_connectivity_url/);
    assert.throws(() => validateConfig({ protection_failures: 0 }), /protection_failures/);
    assert.throws(() => validateConfig({ attack_nodes: [{ node: '' }] }), /attack_nodes/);
    assert.throws(() => validateConfig({ attack_nodes: [{ node: 'A', expires_at: 'tomorrow' }] }), /expires_at/);
});
