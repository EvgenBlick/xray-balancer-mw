'use strict';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateGroups(groups) {
    assert(isObject(groups), 'config.groups must be an object');
    const groupEntries = Object.entries(groups);
    assert(groupEntries.length <= 100, 'config.groups must contain at most 100 groups');

    for (const [groupName, patterns] of groupEntries) {
        assert(groupName.trim().length > 0, 'config.groups contains empty group name');
        assert(groupName.length <= 64, `config.groups[${groupName}] name must be <= 64 chars`);
        assert(Array.isArray(patterns), `config.groups[${groupName}] must be an array`);
        assert(patterns.length > 0, `config.groups[${groupName}] must contain at least one pattern`);
        assert(patterns.length <= 100, `config.groups[${groupName}] must contain at most 100 patterns`);
        for (const pattern of patterns) {
            assert(typeof pattern === 'string' && pattern.trim().length > 0, `config.groups[${groupName}] contains invalid pattern`);
            assert(pattern.length <= 128, `config.groups[${groupName}] contains pattern longer than 128 chars`);
        }
    }
}

function validateStringList(value, key) {
    assert(Array.isArray(value), `config.${key} must be an array`);
    for (const item of value) {
        assert(typeof item === 'string' && item.trim().length > 0, `config.${key} contains invalid value`);
    }
}

const STRATEGY_ALIASES = new Map([
    ['leastload', 'leastLoad'],
    ['leastping', 'leastPing'],
    ['random', 'random'],
    ['roundrobin', 'roundRobin'],
]);

function normalizeStrategy(strategy) {
    if (strategy === undefined || strategy === null) return undefined;
    if (typeof strategy !== 'string') return null;
    return STRATEGY_ALIASES.get(strategy.trim().toLowerCase()) || null;
}

function validateConfig(config) {
    assert(isObject(config), 'config must be a JSON object');

    if (config.port !== undefined) {
        assert(Number.isInteger(config.port) && config.port > 0 && config.port <= 65535, 'config.port must be an integer in range 1..65535');
    }

    if (config.sub_path !== undefined) {
        assert(typeof config.sub_path === 'string' && config.sub_path.startsWith('/'), 'config.sub_path must start with "/"');
    }

    if (config.remnawave_url !== undefined) {
        assert(typeof config.remnawave_url === 'string' && /^https?:\/\//i.test(config.remnawave_url), 'config.remnawave_url must be a valid http(s) URL');
    }

    if (config.sub_page_url !== undefined) {
        assert(typeof config.sub_page_url === 'string' && /^https?:\/\//i.test(config.sub_page_url), 'config.sub_page_url must be a valid http(s) URL');
    }

    if (config.sub_domain !== undefined) {
        assert(typeof config.sub_domain === 'string' && config.sub_domain.trim().length > 0, 'config.sub_domain must be a non-empty string');
    }

    if (config.strategy !== undefined) {
        const normalizedStrategy = normalizeStrategy(config.strategy);
        assert(normalizedStrategy, 'config.strategy must be one of: leastLoad, leastPing, random, roundRobin');
    }

    if (config.probe_interval !== undefined) {
        assert(typeof config.probe_interval === 'string' && config.probe_interval.trim().length > 0, 'config.probe_interval must be a non-empty string');
    }

    if (config.probe_timeout !== undefined) {
        assert(typeof config.probe_timeout === 'string' && config.probe_timeout.trim().length > 0, 'config.probe_timeout must be a non-empty string');
    }

    if (config.probe_connectivity_url !== undefined) {
        assert(typeof config.probe_connectivity_url === 'string', 'config.probe_connectivity_url must be a string');
        assert(config.probe_connectivity_url === '' || /^https?:\/\//i.test(config.probe_connectivity_url), 'config.probe_connectivity_url must be empty or a valid http(s) URL');
    }

    if (config.probe_http_method !== undefined) {
        assert(['HEAD', 'GET'].includes(config.probe_http_method), 'config.probe_http_method must be one of: HEAD, GET');
    }

    if (config.probe_url !== undefined) {
        assert(typeof config.probe_url === 'string' && /^https?:\/\//i.test(config.probe_url), 'config.probe_url must be a valid http(s) URL');
    }

    if (config.fastest_probe_url !== undefined) {
        assert(typeof config.fastest_probe_url === 'string' && /^https?:\/\//i.test(config.fastest_probe_url), 'config.fastest_probe_url must be a valid http(s) URL');
    }

    if (config.fastest_group_name !== undefined) {
        assert(typeof config.fastest_group_name === 'string' && config.fastest_group_name.trim().length > 0, 'config.fastest_group_name must be a non-empty string');
    }

    const boolKeys = [
        'fastest_group',
        'auto_groups',
        'node_stats',
        'trust_x_forwarded_for',
        'auto_quarantine_enabled',
        'auto_drain_enabled',
        'protection_enabled',
        'emergency_fallback_enabled',
        'sticky_enabled',
        'sticky_new_connections_only',
    ];
    for (const key of boolKeys) {
        if (config[key] !== undefined) {
            assert(typeof config[key] === 'boolean', `config.${key} must be boolean`);
        }
    }

    if (config.sticky_mode !== undefined) {
        const allowedStickyModes = new Set(['pin', 'prefer']);
        assert(allowedStickyModes.has(config.sticky_mode), 'config.sticky_mode must be one of: pin, prefer');
    }

    const intKeys = ['auto_groups_interval_sec', 'node_stats_interval_sec', 'max_users_per_gb', 'max_users_per_cpu'];
    for (const key of intKeys) {
        if (config[key] !== undefined) {
            assert(Number.isInteger(config[key]) && config[key] > 0, `config.${key} must be a positive integer`);
        }
    }

    const positiveIntKeys = [
        'cache_ttl_sec',
        'cache_stale_if_error_sec',
        'cache_max_entries',
        'cache_max_bytes',
        'cache_max_item_bytes',
        'rate_limit_per_minute',
        'rate_limit_burst_10s',
        'token_rate_limit_per_minute',
        'token_rate_limit_burst_10s',
        'token_limiter_max_entries',
        'token_limiter_cleanup_batch',
        'ip_limiter_max_entries',
        'admin_limiter_max_entries',
        'max_upstream_concurrency',
        'negative_cache_ttl_sec',
        'admin_rate_limit_per_minute',
        'admin_rate_limit_burst_10s',
        'node_stats_stale_sec',
        'auto_quarantine_failures',
        'auto_quarantine_release_successes',
        'auto_quarantine_max_nodes',
        'auto_drain_failures',
        'auto_drain_release_successes',
        'protection_failures',
        'protection_release_successes',
        'protection_isolation_ttl_sec',
        'protection_latency_threshold_ms',
        'protection_min_available_nodes',
        'emergency_fallback_max_nodes',
        'probe_sampling',
        'balancer_max_latency_ms',
        'ready_success_window_sec',
        'request_timeout_ms',
        'max_redirects',
        'circuit_breaker_failures',
        'circuit_breaker_open_sec',
        'sticky_ttl_sec',
        'sticky_max_entries',
    ];
    for (const key of positiveIntKeys) {
        if (config[key] !== undefined) {
            assert(Number.isInteger(config[key]) && config[key] > 0, `config.${key} must be a positive integer`);
        }
    }

    const floatKeys = [
        'auto_drain_load_threshold',
        'auto_drain_score_penalty',
        'balancer_load_weight',
        'balancer_latency_weight',
        'balancer_smoothing_alpha',
        'balancer_hysteresis_delta',
    ];
    for (const key of floatKeys) {
        if (config[key] !== undefined) {
            assert(typeof config[key] === 'number' && Number.isFinite(config[key]), `config.${key} must be a finite number`);
            assert(config[key] >= 0, `config.${key} must be >= 0`);
        }
    }

    if (config.balancer_smoothing_alpha !== undefined) {
        assert(config.balancer_smoothing_alpha <= 1, 'config.balancer_smoothing_alpha must be <= 1');
    }

    if (config.groups !== undefined) {
        validateGroups(config.groups);
    }

    if (config.fastest_exclude_groups !== undefined) {
        validateStringList(config.fastest_exclude_groups, 'fastest_exclude_groups');
    }

    if (config.fastest_fallback !== undefined) {
        validateStringList(config.fastest_fallback, 'fastest_fallback');
    }

    if (config.node_stats_exclude !== undefined) {
        validateStringList(config.node_stats_exclude, 'node_stats_exclude');
    }

    if (config.expand_groups_to_nodes !== undefined) {
        validateStringList(config.expand_groups_to_nodes, 'expand_groups_to_nodes');
    }

    if (config.hidden_groups !== undefined) {
        validateStringList(config.hidden_groups, 'hidden_groups');
    }

    if (config.hidden_nodes !== undefined) {
        validateStringList(config.hidden_nodes, 'hidden_nodes');
    }

    if (config.profile_mode !== undefined) {
        const allowedProfiles = new Set(['balanced', 'stable', 'aggressive', 'debug']);
        assert(allowedProfiles.has(config.profile_mode), 'config.profile_mode must be one of: balanced, stable, aggressive, debug');
    }

    if (config.admin_token !== undefined) {
        assert(typeof config.admin_token === 'string' && config.admin_token.length >= 8, 'config.admin_token must be a string with length >= 8');
    }

    if (config.api_token !== undefined) {
        assert(typeof config.api_token === 'string', 'config.api_token must be a string');
    }

    if (config.panel_auth_cookie !== undefined) {
        assert(typeof config.panel_auth_cookie === 'string', 'config.panel_auth_cookie must be a string');
    }

    if (config.warmup_tokens !== undefined) {
        assert(Array.isArray(config.warmup_tokens), 'config.warmup_tokens must be an array');
        for (const token of config.warmup_tokens) {
            assert(typeof token === 'string' && /^[a-zA-Z0-9_-]+$/.test(token), 'config.warmup_tokens contains invalid token');
        }
    }

    if (config.quarantine_nodes !== undefined) {
        assert(Array.isArray(config.quarantine_nodes), 'config.quarantine_nodes must be an array');
        assert(config.quarantine_nodes.length <= 500, 'config.quarantine_nodes must contain at most 500 entries');
        for (const node of config.quarantine_nodes) {
            assert(typeof node === 'string' && node.trim().length > 0, 'config.quarantine_nodes contains invalid node name');
            assert(node.length <= 128, 'config.quarantine_nodes contains node name longer than 128 chars');
        }
    }

    if (config.auto_quarantine_nodes !== undefined) {
        assert(Array.isArray(config.auto_quarantine_nodes), 'config.auto_quarantine_nodes must be an array');
        assert(config.auto_quarantine_nodes.length <= 500, 'config.auto_quarantine_nodes must contain at most 500 entries');
        for (const node of config.auto_quarantine_nodes) {
            assert(typeof node === 'string' && node.trim().length > 0, 'config.auto_quarantine_nodes contains invalid node name');
            assert(node.length <= 128, 'config.auto_quarantine_nodes contains node name longer than 128 chars');
        }
    }

    if (config.attack_nodes !== undefined) {
        assert(Array.isArray(config.attack_nodes), 'config.attack_nodes must be an array');
        assert(config.attack_nodes.length <= 500, 'config.attack_nodes must contain at most 500 entries');
        for (const item of config.attack_nodes) {
            assert(isObject(item), 'config.attack_nodes contains invalid entry');
            assert(typeof item.node === 'string' && item.node.trim().length > 0, 'config.attack_nodes entry must contain a node');
            assert(item.node.length <= 128, 'config.attack_nodes node must be <= 128 chars');
            if (item.reason !== undefined) {
                assert(typeof item.reason === 'string' && item.reason.length <= 256, 'config.attack_nodes reason must be <= 256 chars');
            }
            if (item.source !== undefined) {
                assert(typeof item.source === 'string' && item.source.length <= 64, 'config.attack_nodes source must be <= 64 chars');
            }
            if (item.mode !== undefined) {
                assert(['manual', 'automatic'].includes(item.mode), 'config.attack_nodes mode must be one of: manual, automatic');
            }
            if (item.expires_at !== undefined && item.expires_at !== null) {
                assert(typeof item.expires_at === 'string' && Number.isFinite(Date.parse(item.expires_at)), 'config.attack_nodes expires_at must be an ISO date');
            }
        }
    }

    return config;
}

module.exports = {
    normalizeStrategy,
    validateConfig,
};
