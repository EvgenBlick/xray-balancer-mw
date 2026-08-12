'use strict';

function parsePositiveInt(value) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function resolveBoolean(envValue, configValue) {
    if (envValue === 'true') return true;
    if (envValue === 'false') return false;
    return configValue === true;
}

function normalizeStringList(value) {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
}

function resolvePositiveInt(envValue, configValue, fallback) {
    return parsePositiveInt(envValue) ?? parsePositiveInt(configValue) ?? fallback;
}

function resolveFiniteNumber(envValue, configValue, fallback) {
    return parseFiniteNumber(envValue) ?? parseFiniteNumber(configValue) ?? fallback;
}

function normalizeAttackNodes(value) {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .map((item) => ({
            node: typeof item.node === 'string' ? item.node.trim() : '',
            reason: typeof item.reason === 'string' ? item.reason.trim() : 'manual',
            source: typeof item.source === 'string' ? item.source.trim() : 'admin',
            mode: item.mode === 'automatic' ? 'automatic' : 'manual',
            expires_at: typeof item.expires_at === 'string' ? item.expires_at : null,
        }))
        .filter((item) => item.node);
}

function resolveFiniteNumberInRange(envValue, configValue, fallback, min, max) {
    const envParsed = parseFiniteNumber(envValue);
    if (envParsed !== null && envParsed >= min && envParsed <= max) return envParsed;
    const configParsed = parseFiniteNumber(configValue);
    if (configParsed !== null && configParsed >= min && configParsed <= max) return configParsed;
    return fallback;
}

function readEffectiveRuntime(config = {}, env = process.env) {
    const probeUrl = config.probe_url || 'https://www.gstatic.com/generate_204';

    return {
        probeInterval: config.probe_interval || '30s',
        probeSampling: resolvePositiveInt(env.PROBE_SAMPLING, config.probe_sampling, 1),
        probeTimeout: config.probe_timeout || '3s',
        probeConnectivityUrl: config.probe_connectivity_url || '',
        probeHttpMethod: config.probe_http_method || 'HEAD',
        fastestProbeUrl: config.fastest_probe_url || probeUrl,
        groupDescriptions: config.group_descriptions || {},
        fastestExcludeGroups: normalizeStringList(config.fastest_exclude_groups),
        fastestFallbackGroups: normalizeStringList(config.fastest_fallback),
        nodeStatsExcludeGroups: normalizeStringList(config.node_stats_exclude),
        expandGroupsToNodes: normalizeStringList(config.expand_groups_to_nodes),
        hiddenGroups: normalizeStringList(config.hidden_groups),
        hiddenNodes: normalizeStringList(config.hidden_nodes),
        quarantineNodes: normalizeStringList(config.quarantine_nodes),
        autoQuarantineNodes: normalizeStringList(config.auto_quarantine_nodes),
        stickyEnabled: resolveBoolean(env.STICKY_ENABLED, config.sticky_enabled),
        stickyMode: config.sticky_mode || 'pin',
        stickyNewConnectionsOnly: resolveBoolean(
            env.STICKY_NEW_CONNECTIONS_ONLY,
            config.sticky_new_connections_only
        ),
        stickyTtlSec: resolvePositiveInt(env.STICKY_TTL_SEC, config.sticky_ttl_sec, 3600),
        stickyMaxEntries: resolvePositiveInt(env.STICKY_MAX_ENTRIES, config.sticky_max_entries, 10000),
        autoQuarantineEnabled: resolveBoolean(env.AUTO_QUARANTINE_ENABLED, config.auto_quarantine_enabled),
        autoQuarantineFailures: resolvePositiveInt(env.AUTO_QUARANTINE_FAILURES, config.auto_quarantine_failures, 3),
        autoQuarantineReleaseSuccesses: resolvePositiveInt(
            env.AUTO_QUARANTINE_RELEASE_SUCCESSES,
            config.auto_quarantine_release_successes,
            2
        ),
        autoQuarantineMaxNodes: resolvePositiveInt(env.AUTO_QUARANTINE_MAX_NODES, config.auto_quarantine_max_nodes, 100),
        autoDrainEnabled: resolveBoolean(env.AUTO_DRAIN_ENABLED, config.auto_drain_enabled),
        autoDrainFailures: resolvePositiveInt(env.AUTO_DRAIN_FAILURES, config.auto_drain_failures, 2),
        autoDrainReleaseSuccesses: resolvePositiveInt(
            env.AUTO_DRAIN_RELEASE_SUCCESSES,
            config.auto_drain_release_successes,
            2
        ),
        autoDrainLoadThreshold: resolveFiniteNumber(env.AUTO_DRAIN_LOAD_THRESHOLD, config.auto_drain_load_threshold, 0.85),
        autoDrainScorePenalty: resolveFiniteNumber(env.AUTO_DRAIN_SCORE_PENALTY, config.auto_drain_score_penalty, 0.6),
        protectionEnabled: resolveBoolean(env.PROTECTION_ENABLED, config.protection_enabled),
        protectionFailures: resolvePositiveInt(env.PROTECTION_FAILURES, config.protection_failures, 2),
        protectionReleaseSuccesses: resolvePositiveInt(
            env.PROTECTION_RELEASE_SUCCESSES,
            config.protection_release_successes,
            3
        ),
        protectionIsolationTtlSec: resolvePositiveInt(
            env.PROTECTION_ISOLATION_TTL_SEC,
            config.protection_isolation_ttl_sec,
            300
        ),
        protectionLatencyThresholdMs: resolvePositiveInt(
            env.PROTECTION_LATENCY_THRESHOLD_MS,
            config.protection_latency_threshold_ms,
            1500
        ),
        protectionMinAvailableNodes: resolvePositiveInt(
            env.PROTECTION_MIN_AVAILABLE_NODES,
            config.protection_min_available_nodes,
            1
        ),
        attackNodes: normalizeAttackNodes(config.attack_nodes),
        emergencyFallbackEnabled: resolveBoolean(
            env.EMERGENCY_FALLBACK_ENABLED,
            config.emergency_fallback_enabled
        ),
        emergencyFallbackMaxNodes: resolvePositiveInt(
            env.EMERGENCY_FALLBACK_MAX_NODES,
            config.emergency_fallback_max_nodes,
            1
        ),
        balancerLoadWeight: resolveFiniteNumber(env.BALANCER_LOAD_WEIGHT, config.balancer_load_weight, 0.4),
        balancerLatencyWeight: resolveFiniteNumber(env.BALANCER_LATENCY_WEIGHT, config.balancer_latency_weight, 0.6),
        balancerMaxLatencyMs: resolvePositiveInt(env.BALANCER_MAX_LATENCY_MS, config.balancer_max_latency_ms, 300),
        balancerSmoothingAlpha: resolveFiniteNumberInRange(
            env.BALANCER_SMOOTHING_ALPHA,
            config.balancer_smoothing_alpha,
            0.35,
            0,
            1
        ),
        balancerHysteresisDelta: resolveFiniteNumber(env.BALANCER_HYSTERESIS_DELTA, config.balancer_hysteresis_delta, 0.08),
    };
}

module.exports = {
    readEffectiveRuntime,
};
