const http = require('http');
const https = require('https');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { normalizeStrategy, validateConfig } = require('./lib/config');
const { normalizeRequestId, redactTokenPath, sanitizeClientMetadata } = require('./lib/security');
const {
    computePublishedGroupEntries,
    filterHiddenOutbounds,
    filterAndSortByLoad,
    getNodeStats,
    matchGroup,
} = require('./lib/balancing');
const { createCircuitBreaker, createKeyedRateLimiter, createRateLimiter, createTokenCache } = require('./lib/runtime');
const { buildLogger } = require('./lib/log');
const { resolveProfile } = require('./lib/profile');
const { classifyUpstreamPayload } = require('./lib/upstream-contract');
const { buildGroupConfig } = require('./lib/group-builder');
const { buildStickyTokenKey, createStickyStore } = require('./lib/sticky');
const { createRequestGuard } = require('./lib/request-guard');
const { readEffectiveRuntime } = require('./lib/runtime-config');
const { createNodeProtectionManager } = require('./lib/node-protection');

// ─── Загрузка конфига ───
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const CONFIG_RUNTIME_PATH = process.env.CONFIG_RUNTIME_PATH || '';
const MUTABLE_CONFIG_KEYS = [
    'groups',
    'group_descriptions',
    'strategy',
    'fastest_group',
    'fastest_group_name',
    'fastest_exclude_groups',
    'fastest_fallback',
    'node_stats_exclude',
    'expand_groups_to_nodes',
    'hidden_groups',
    'hidden_nodes',
    'probe_interval',
    'probe_sampling',
    'probe_timeout',
    'probe_connectivity_url',
    'probe_http_method',
    'fastest_probe_url',
    'quarantine_nodes',
    'auto_quarantine_nodes',
    'auto_quarantine_enabled',
    'auto_quarantine_failures',
    'auto_quarantine_release_successes',
    'auto_quarantine_max_nodes',
    'auto_drain_enabled',
    'auto_drain_failures',
    'auto_drain_release_successes',
    'auto_drain_load_threshold',
    'auto_drain_score_penalty',
    'protection_enabled',
    'protection_failures',
    'protection_release_successes',
    'protection_isolation_ttl_sec',
    'protection_latency_threshold_ms',
    'protection_min_available_nodes',
    'attack_nodes',
    'emergency_fallback_enabled',
    'emergency_fallback_max_nodes',
    'sticky_enabled',
    'sticky_mode',
    'sticky_new_connections_only',
    'sticky_ttl_sec',
    'sticky_max_entries',
    'balancer_load_weight',
    'balancer_latency_weight',
    'balancer_max_latency_ms',
    'balancer_smoothing_alpha',
    'balancer_hysteresis_delta',
];
let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (CONFIG_RUNTIME_PATH && fs.existsSync(CONFIG_RUNTIME_PATH)) {
        const runtimePatchRaw = fs.readFileSync(CONFIG_RUNTIME_PATH, 'utf8');
        if (runtimePatchRaw.trim()) {
            const runtimePatch = JSON.parse(runtimePatchRaw);
            if (runtimePatch && typeof runtimePatch === 'object' && !Array.isArray(runtimePatch)) {
                config = { ...config, ...runtimePatch };
            }
        }
    }
    validateConfig(config);
} catch (err) {
    console.error(`❌ Ошибка чтения ${CONFIG_PATH}:`, err.message);
    process.exit(1);
}

const PORT = parseInt(process.env.PORT, 10) || config.port || 4100;
const REMNAWAVE_URL = process.env.REMNAWAVE_URL || config.remnawave_url;
if (!REMNAWAVE_URL && !process.env.SUB_PAGE_URL && !config.sub_page_url) {
    console.error('❌ REMNAWAVE_URL не задан (ни в .env, ни в config.json). Укажите хотя бы REMNAWAVE_URL или SUB_PAGE_URL.');
    process.exit(1);
}
const REMNAWAVE_SUB_PATH = process.env.SUB_PATH || config.sub_path || '/api/sub';
const API_TOKEN = process.env.API_TOKEN || config.api_token || '';

const SUB_PAGE_URL = process.env.SUB_PAGE_URL || config.sub_page_url || '';
const SUB_DOMAIN = process.env.SUB_DOMAIN || config.sub_domain || '';

let GROUPS = config.groups || {};

const AUTO_GROUPS = config.auto_groups === true;
const AUTO_GROUPS_INTERVAL = (config.auto_groups_interval_sec || 300) * 1000;

let STRATEGY = normalizeStrategy(config.strategy) || 'leastLoad';
const PROBE_URL = config.probe_url || 'https://www.gstatic.com/generate_204';
const PROFILE_MODE = process.env.PROFILE_MODE || config.profile_mode || 'balanced';
const PROFILE = resolveProfile(PROFILE_MODE);

function pickRuntimeInt(envKey, configKey) {
    const envVal = parseInt(process.env[envKey], 10);
    if (Number.isInteger(envVal) && envVal > 0) return envVal;
    if (Number.isInteger(config[configKey]) && config[configKey] > 0) return config[configKey];
    return PROFILE.values[configKey];
}

function pickRuntimeBool(envKey, configKey) {
    if (process.env[envKey] === 'true') return true;
    if (process.env[envKey] === 'false') return false;
    return config[configKey] === true;
}

function pickPositiveInt(envKey, configKey, fallbackValue) {
    const envVal = parseInt(process.env[envKey], 10);
    if (Number.isInteger(envVal) && envVal > 0) return envVal;
    if (Number.isInteger(config[configKey]) && config[configKey] > 0) return config[configKey];
    return fallbackValue;
}

// Node stats — опрос нагрузки нод из API панели
const NODE_STATS_ENABLED = pickRuntimeBool('NODE_STATS', 'node_stats');
const NODE_STATS_INTERVAL = pickPositiveInt('NODE_STATS_INTERVAL_SEC', 'node_stats_interval_sec', 120) * 1000;
const NODE_STATS_STALE_SEC = pickPositiveInt(
    'NODE_STATS_STALE_SEC',
    'node_stats_stale_sec',
    Math.max(300, Math.ceil((NODE_STATS_INTERVAL / 1000) * 3)),
);
const NODE_STATS_STALE_MS = NODE_STATS_STALE_SEC * 1000;
const MAX_USERS_PER_GB = parseInt(process.env.MAX_USERS_PER_GB, 10) || config.max_users_per_gb || 20;
const MAX_USERS_PER_CPU = parseInt(process.env.MAX_USERS_PER_CPU, 10) || config.max_users_per_cpu || 40;
const CACHE_TTL_SEC = pickRuntimeInt('CACHE_TTL_SEC', 'cache_ttl_sec');
const CACHE_STALE_IF_ERROR_SEC = pickRuntimeInt('CACHE_STALE_IF_ERROR_SEC', 'cache_stale_if_error_sec');
const CACHE_MAX_ENTRIES = pickRuntimeInt('CACHE_MAX_ENTRIES', 'cache_max_entries');
const CACHE_MAX_BYTES = pickPositiveInt('CACHE_MAX_BYTES', 'cache_max_bytes', 128 * 1024 * 1024);
const CACHE_MAX_ITEM_BYTES = pickPositiveInt('CACHE_MAX_ITEM_BYTES', 'cache_max_item_bytes', 10 * 1024 * 1024);
const RATE_LIMIT_PER_MINUTE = pickRuntimeInt('RATE_LIMIT_PER_MINUTE', 'rate_limit_per_minute');
const RATE_LIMIT_BURST_10S = pickRuntimeInt('RATE_LIMIT_BURST_10S', 'rate_limit_burst_10s');
const TOKEN_RATE_LIMIT_PER_MINUTE = pickRuntimeInt('TOKEN_RATE_LIMIT_PER_MINUTE', 'token_rate_limit_per_minute');
const TOKEN_RATE_LIMIT_BURST_10S = pickRuntimeInt('TOKEN_RATE_LIMIT_BURST_10S', 'token_rate_limit_burst_10s');
const TOKEN_LIMITER_MAX_ENTRIES = parseInt(process.env.TOKEN_LIMITER_MAX_ENTRIES, 10) || config.token_limiter_max_entries || 5000;
const TOKEN_LIMITER_CLEANUP_BATCH = parseInt(process.env.TOKEN_LIMITER_CLEANUP_BATCH, 10) || config.token_limiter_cleanup_batch || 200;
const IP_LIMITER_MAX_ENTRIES = pickPositiveInt('IP_LIMITER_MAX_ENTRIES', 'ip_limiter_max_entries', 10000);
const ADMIN_LIMITER_MAX_ENTRIES = pickPositiveInt('ADMIN_LIMITER_MAX_ENTRIES', 'admin_limiter_max_entries', 2000);
const MAX_UPSTREAM_CONCURRENCY = pickPositiveInt('MAX_UPSTREAM_CONCURRENCY', 'max_upstream_concurrency', 32);
const NEGATIVE_CACHE_TTL_SEC = pickPositiveInt('NEGATIVE_CACHE_TTL_SEC', 'negative_cache_ttl_sec', 30);
const TRUST_X_FORWARDED_FOR = pickRuntimeBool('TRUST_X_FORWARDED_FOR', 'trust_x_forwarded_for');
const ADMIN_RATE_LIMIT_PER_MINUTE = parseInt(process.env.ADMIN_RATE_LIMIT_PER_MINUTE, 10) || config.admin_rate_limit_per_minute || 60;
const ADMIN_RATE_LIMIT_BURST_10S = parseInt(process.env.ADMIN_RATE_LIMIT_BURST_10S, 10) || config.admin_rate_limit_burst_10s || 20;
const READY_SUCCESS_WINDOW_SEC = pickRuntimeInt('READY_SUCCESS_WINDOW_SEC', 'ready_success_window_sec');
const REQUEST_TIMEOUT_MS = pickRuntimeInt('REQUEST_TIMEOUT_MS', 'request_timeout_ms');
const MAX_REDIRECTS = pickRuntimeInt('MAX_REDIRECTS', 'max_redirects');
const CIRCUIT_BREAKER_FAILURES = pickRuntimeInt('CIRCUIT_BREAKER_FAILURES', 'circuit_breaker_failures');
const CIRCUIT_BREAKER_OPEN_SEC = pickRuntimeInt('CIRCUIT_BREAKER_OPEN_SEC', 'circuit_breaker_open_sec');
let GROUP_DESCRIPTIONS = {};
let FASTEST_EXCLUDE_GROUPS = [];
let FASTEST_FALLBACK_GROUPS = [];
let NODE_STATS_EXCLUDE_GROUPS = [];
let EXPAND_GROUPS_TO_NODES = [];
let HIDDEN_GROUPS = [];
let HIDDEN_NODES = [];
const DEFAULT_FASTEST_GROUP_NAME = '🏁 🇪🇺 Самые быстрые';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || config.admin_token || '';
const WARMUP_TOKENS = Array.isArray(config.warmup_tokens) ? config.warmup_tokens : [];
let QUARANTINE_NODES = [];
let AUTO_QUARANTINE_NODES = [];
let ATTACK_NODES = [];

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

// Cookie-авторизация для панели за nginx (egam.es и подобные)
const PANEL_AUTH_COOKIE = process.env.PANEL_AUTH_COOKIE || config.panel_auth_cookie || '';

// Собрать заголовки для API панели
function panelHeaders() {
    const h = {
        'Authorization': `Bearer ${API_TOKEN}`,
        'X-Forwarded-For': '127.0.0.1',
        'X-Forwarded-Proto': 'https',
    };
    if (PANEL_AUTH_COOKIE) {
        h['Cookie'] = PANEL_AUTH_COOKIE;
    }
    return h;
}

// Кэш статистики нод: { "Finland2": { usersOnline: 9, totalRamGb: 2.06, cpuCount: 1, ramLoad: 4.37, cpuLoad: 9, load: 0.23 }, ... }
let nodeStatsCache = {};
let lastUpstreamSuccessAt = 0;
let lastUpstreamError = null;
let lastNodeStatsRefreshAt = 0;
let lastNodeStatsError = null;
let nodeStatsRefreshInFlight = null;
const autoQuarantineState = new Map();
const subscriptionCache = createTokenCache(CACHE_TTL_SEC, CACHE_MAX_ENTRIES, {
    maxBytes: CACHE_MAX_BYTES,
    maxItemBytes: CACHE_MAX_ITEM_BYTES,
});
const negativeSubscriptionCache = createTokenCache(NEGATIVE_CACHE_TTL_SEC, Math.min(CACHE_MAX_ENTRIES, 5000), {
    maxBytes: Math.min(CACHE_MAX_BYTES, 16 * 1024 * 1024),
    maxItemBytes: 64 * 1024,
});
let subscriptionCacheGeneration = 0;
const inFlightUpstreamFetches = new Map();
let activeUpstreamFetches = 0;
const rateLimiter = createRateLimiter(RATE_LIMIT_PER_MINUTE, RATE_LIMIT_BURST_10S, {
    maxEntries: IP_LIMITER_MAX_ENTRIES,
});
const tokenRateLimiter = createKeyedRateLimiter(TOKEN_RATE_LIMIT_PER_MINUTE, TOKEN_RATE_LIMIT_BURST_10S, {
    maxEntries: TOKEN_LIMITER_MAX_ENTRIES,
    cleanupBatch: TOKEN_LIMITER_CLEANUP_BATCH,
});
const adminRateLimiter = createRateLimiter(ADMIN_RATE_LIMIT_PER_MINUTE, ADMIN_RATE_LIMIT_BURST_10S, {
    maxEntries: ADMIN_LIMITER_MAX_ENTRIES,
});
const circuitBreaker = createCircuitBreaker(CIRCUIT_BREAKER_FAILURES, CIRCUIT_BREAKER_OPEN_SEC);
const runtimeStats = {
    started_at: Date.now(),
    requests_total: 0,
    request_failures: 0,
    cache_hits_total: 0,
    cache_fallback_total: 0,
    cache_fallback_stale_total: 0,
    cache_invalidations_total: 0,
    upstream_singleflight_joined_total: 0,
    upstream_overload_rejected_total: 0,
    negative_cache_hits_total: 0,
    background_overlap_skipped_total: 0,
    circuit_open_total: 0,
    rate_limited_ip_total: 0,
    rate_limited_token_total: 0,
    upstream_non_json_total: 0,
    fake_config_passthrough_total: 0,
    quarantine_filtered_total: 0,
    protection_isolations_total: 0,
    protection_releases_total: 0,
    protection_suppressed_total: 0,
    sticky_released_by_protection_total: 0,
    protection_filtered_total: 0,
    all_nodes_unavailable_total: 0,
    sticky_assignments_total: 0,
    sticky_hits_total: 0,
    sticky_misses_total: 0,
};
const logger = buildLogger();
const requestGuard = createRequestGuard({
    ipLimiter: rateLimiter,
    tokenLimiter: tokenRateLimiter,
    circuitBreaker,
    stats: runtimeStats,
});
const autoDrainState = new Map();
const autoDrainNodes = new Set();
const balancerRankState = new Map();
let stickyStore = null;
let stickyStoreConfig = null;
let nodeProtectionManager = null;
let nodeProtectionManagerConfig = null;
let runtimeConfigMutationQueue = Promise.resolve();
let shuttingDown = false;
let shutdownStarted = false;
const backgroundIntervals = new Set();
const activeBackgroundTasks = new Set();

function getRuntimeConfig() {
    return readEffectiveRuntime(config, process.env);
}

function ensureNodeProtectionManager() {
    const runtime = getRuntimeConfig();
    const nextConfig = {
        failureThreshold: runtime.protectionFailures,
        recoverySuccessThreshold: runtime.protectionReleaseSuccesses,
        isolationTtlSec: runtime.protectionIsolationTtlSec,
    };
    const unchanged = nodeProtectionManager
        && nodeProtectionManagerConfig
        && Object.keys(nextConfig).every((key) => nodeProtectionManagerConfig[key] === nextConfig[key]);
    if (unchanged) return nodeProtectionManager;

    const previousProtected = nodeProtectionManager
        ? nodeProtectionManager.list({ protectedOnly: true })
        : [];
    const nextManager = createNodeProtectionManager(nextConfig);
    const now = Date.now();
    const seeds = new Map();

    for (const node of previousProtected) {
        seeds.set(node.normalizedNode, {
            node: node.nodeName,
            reason: node.isolation?.reason,
            source: node.isolation?.source,
            mode: node.isolation?.mode,
            expiresAt: node.isolation?.expiresAt,
        });
    }
    for (const node of runtime.attackNodes) {
        seeds.set(normalizeNodeName(node.node), {
            node: node.node,
            reason: node.reason,
            source: node.source,
            mode: node.mode,
            expiresAt: node.expires_at ? Date.parse(node.expires_at) : now + (runtime.protectionIsolationTtlSec * 1000),
        });
    }

    for (const seed of seeds.values()) {
        if (!seed.node || !Number.isFinite(seed.expiresAt) || seed.expiresAt <= now) continue;
        const details = {
            reason: seed.reason,
            source: seed.source,
            ttlSec: Math.max(1, Math.ceil((seed.expiresAt - now) / 1000)),
        };
        if (seed.mode === 'automatic') {
            nextManager.isolateAutomatic(seed.node, details, now);
        } else {
            nextManager.isolateManual(seed.node, details, now);
        }
    }
    nextManager.drainEvents();
    nodeProtectionManager = nextManager;
    nodeProtectionManagerConfig = nextConfig;
    return nodeProtectionManager;
}

function ensureStickyStore() {
    const runtime = getRuntimeConfig();
    const nextConfig = {
        ttlSec: runtime.stickyTtlSec,
        maxEntries: runtime.stickyMaxEntries,
        refreshTtlOnHit: runtime.stickyNewConnectionsOnly,
    };

    if (!stickyStore
        || !stickyStoreConfig
        || stickyStoreConfig.ttlSec !== nextConfig.ttlSec
        || stickyStoreConfig.maxEntries !== nextConfig.maxEntries
        || stickyStoreConfig.refreshTtlOnHit !== nextConfig.refreshTtlOnHit) {
        stickyStore = createStickyStore(nextConfig);
        stickyStoreConfig = nextConfig;
    }

    return stickyStore;
}

function applyMutableRuntimeConfig(nextConfig) {
    config = nextConfig;
    STRATEGY = normalizeStrategy(nextConfig.strategy) || 'leastLoad';
    GROUPS = nextConfig.groups || {};
    GROUP_DESCRIPTIONS = nextConfig.group_descriptions || {};
    const runtime = getRuntimeConfig();
    FASTEST_EXCLUDE_GROUPS = runtime.fastestExcludeGroups;
    FASTEST_FALLBACK_GROUPS = runtime.fastestFallbackGroups;
    NODE_STATS_EXCLUDE_GROUPS = runtime.nodeStatsExcludeGroups;
    EXPAND_GROUPS_TO_NODES = runtime.expandGroupsToNodes;
    HIDDEN_GROUPS = runtime.hiddenGroups;
    HIDDEN_NODES = runtime.hiddenNodes;
    QUARANTINE_NODES = runtime.quarantineNodes;
    AUTO_QUARANTINE_NODES = runtime.autoQuarantineNodes;
    ATTACK_NODES = runtime.attackNodes;
    ensureStickyStore();
    ensureNodeProtectionManager();
}

applyMutableRuntimeConfig(config);

function clearSubscriptionCache(reason, requestId) {
    const removed = subscriptionCache.clear();
    subscriptionCacheGeneration += 1;
    runtimeStats.cache_invalidations_total += 1;
    logger.info('subscription_cache_cleared', {
        request_id: requestId,
        reason,
        removed,
        generation: subscriptionCacheGeneration,
    });
    return removed;
}

function applyStickySelection(token, scope, outbounds, runtime, currentStickyStore) {
    if (!runtime.stickyEnabled || !Array.isArray(outbounds) || outbounds.length === 0) {
        return {
            selectedOutbounds: outbounds,
            selected: null,
            changed: false,
            used: false,
            stickyKey: null,
        };
    }

    const stickyKey = buildStickyTokenKey(token, scope);
    const stickyOptions = {
        refreshTtlOnHit: runtime.stickyNewConnectionsOnly,
    };
    const stickyChoice = runtime.stickyMode === 'prefer'
        ? currentStickyStore.prefer(stickyKey, outbounds, Date.now(), stickyOptions)
        : currentStickyStore.choose(stickyKey, outbounds, Date.now(), stickyOptions);

    if (!stickyChoice.selected) {
        return {
            selectedOutbounds: outbounds,
            selected: null,
            changed: false,
            used: true,
            stickyKey,
        };
    }

    return {
        selectedOutbounds: runtime.stickyMode === 'prefer'
            ? stickyChoice.orderedOutbounds
            : [stickyChoice.selected],
        selected: stickyChoice.selected,
        changed: stickyChoice.changed,
        used: true,
        stickyKey,
    };
}

// ─── Утилиты ───

function isSocketHangupError(err) {
    const msg = String(err && err.message ? err.message : err || '');
    const code = String(err && err.code ? err.code : '');
    return /socket hang up|ECONNRESET|EPIPE|EOF/i.test(msg) || /ECONNRESET|EPIPE/i.test(code);
}

function createTimeoutError() {
    const err = new Error('Timeout');
    err.code = 'ETIMEDOUT';
    return err;
}

function fetchUrl(targetUrl, headers = {}, maxRedirects = MAX_REDIRECTS, deadlineAt = Date.now() + REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
            reject(createTimeoutError());
            return;
        }

        const parsed = new URL(targetUrl);
        const mod = parsed.protocol === 'https:' ? https : http;
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: { ...headers },
        };

        let settled = false;
        let deadlineTimer = null;
        let req = null;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            fn(value);
        };
        const succeed = (value) => finish(resolve, value);
        const fail = (err) => finish(reject, err);

        req = mod.request(opts, (res) => {
            res.on('error', fail);
            if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
                res.resume();
                if (maxRedirects <= 0) {
                    fail(new Error('Too many redirects'));
                    return;
                }
                const redirectUrl = new URL(res.headers.location, targetUrl);
                if (redirectUrl.protocol !== parsed.protocol || redirectUrl.host !== parsed.host) {
                    fail(new Error('Unsafe redirect blocked'));
                    return;
                }
                fetchUrl(redirectUrl.href, headers, maxRedirects - 1, deadlineAt).then(succeed).catch(fail);
                return;
            }

            let data = '';
            let size = 0;
            res.on('data', (chunk) => {
                if (settled) return;
                size += chunk.length;
                if (size > MAX_RESPONSE_SIZE) {
                    const err = new Error('Response too large');
                    req.destroy(err);
                    fail(err);
                    return;
                }
                data += chunk;
            });
            res.on('end', () => succeed({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', fail);
        req.setTimeout(remainingMs, () => {
            const err = createTimeoutError();
            req.destroy(err);
            fail(err);
        });
        deadlineTimer = setTimeout(() => {
            const err = createTimeoutError();
            if (req) req.destroy(err);
            fail(err);
        }, remainingMs);
        if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
        req.end();
    });
}

async function fetchUrlWithSocketRetry(targetUrl, headers, requestId) {
    const deadlineAt = Date.now() + REQUEST_TIMEOUT_MS;
    try {
        return await fetchUrl(targetUrl, headers, MAX_REDIRECTS, deadlineAt);
    } catch (err) {
        if (!isSocketHangupError(err)) {
            throw err;
        }
        logger.warn('upstream_retry_after_socket_hangup', { request_id: requestId, message: err.message });
        return fetchUrl(targetUrl, headers, MAX_REDIRECTS, deadlineAt);
    }
}

async function fetchUpstreamSingleFlight(cacheKey, token, targetUrl, headers, requestId) {
    const existing = inFlightUpstreamFetches.get(cacheKey);
    if (existing) {
        runtimeStats.upstream_singleflight_joined_total += 1;
        logger.info('upstream_singleflight_joined', {
            request_id: requestId,
            token: redactTokenPath(`/${token}`).slice(1),
        });
        return existing;
    }

    if (activeUpstreamFetches >= MAX_UPSTREAM_CONCURRENCY) {
        runtimeStats.upstream_overload_rejected_total += 1;
        const err = new Error('Upstream concurrency limit reached');
        err.code = 'EUPSTREAMBUSY';
        throw err;
    }

    activeUpstreamFetches += 1;
    const promise = fetchUrlWithSocketRetry(targetUrl, headers, requestId);
    inFlightUpstreamFetches.set(cacheKey, promise);
    try {
        return await promise;
    } finally {
        if (inFlightUpstreamFetches.get(cacheKey) === promise) {
            inFlightUpstreamFetches.delete(cacheKey);
        }
        activeUpstreamFetches = Math.max(0, activeUpstreamFetches - 1);
    }
}

function timingSafeEqualString(a, b) {
    const ba = Buffer.from(a || '');
    const bb = Buffer.from(b || '');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function isAdminAuthorized(req) {
    if (!ADMIN_TOKEN) return false;
    const headerToken = (req.headers['x-admin-token'] || '').toString();
    return timingSafeEqualString(headerToken, ADMIN_TOKEN);
}

function sanitizeAdminPath(pathname) {
    if (/^\/admin\/debug\/token\/[a-zA-Z0-9_-]+$/.test(pathname)) return '/admin/debug/token/:token';
    if (/^\/admin\/quarantine\/.+$/.test(pathname)) return '/admin/quarantine/:node';
    if (/^\/admin\/attack-mode\/.+$/.test(pathname)) return '/admin/attack-mode/:node';
    return pathname;
}

function normalizeIpAddress(value) {
    const ip = (value || '').toString().trim();
    return net.isIP(ip) ? ip : null;
}

function isTrustedProxyAddress(ip) {
    const normalized = normalizeIpAddress(ip);
    if (!normalized) return false;
    if (normalized === '::1' || normalized === '127.0.0.1' || normalized === '::ffff:127.0.0.1') return true;

    if (net.isIP(normalized) === 4) {
        const parts = normalized.split('.').map((part) => Number(part));
        if (parts[0] === 10) return true;
        if (parts[0] === 127) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 169 && parts[1] === 254) return true;
        return false;
    }

    const lower = normalized.toLowerCase();
    return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

function parseForwardedForHeader(value) {
    const raw = Array.isArray(value) ? value.join(',') : String(value || '');
    return raw
        .split(',')
        .map((part) => normalizeIpAddress(part))
        .filter(Boolean);
}

function resolveForwardedClientIp(remoteIp, forwardedForHeader) {
    const forwardedIps = parseForwardedForHeader(forwardedForHeader);
    if (forwardedIps.length === 0) return remoteIp;

    const chain = [...forwardedIps, remoteIp].filter(Boolean);
    for (let i = chain.length - 1; i >= 0; i -= 1) {
        const candidate = chain[i];
        if (!isTrustedProxyAddress(candidate)) return candidate;
    }

    return forwardedIps[0] || remoteIp;
}

function resolveClientIp(req) {
    const remoteIp = normalizeIpAddress(req.socket.remoteAddress) || '127.0.0.1';
    if (!TRUST_X_FORWARDED_FOR) return remoteIp;
    if (!isTrustedProxyAddress(remoteIp)) return remoteIp;
    return resolveForwardedClientIp(remoteIp, req.headers['x-forwarded-for']);
}

function enforceAdminAccess(req, res, requestId, clientIp, pathname) {
    if (!adminRateLimiter.allow(clientIp)) {
        logger.warn('admin_rate_limited', { request_id: requestId, ip: clientIp, path: sanitizeAdminPath(pathname) });
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', code: 'RATE_LIMITED', request_id: requestId }));
        return false;
    }

    if (!isAdminAuthorized(req)) {
        logger.warn('admin_auth_failed', { request_id: requestId, ip: clientIp, path: sanitizeAdminPath(pathname) });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', code: 'ADMIN_AUTH_REQUIRED', request_id: requestId }));
        return false;
    }

    return true;
}

function writeConfigFile(nextConfig) {
    const targetPath = CONFIG_RUNTIME_PATH || CONFIG_PATH;
    const payload = CONFIG_RUNTIME_PATH
        ? Object.fromEntries(MUTABLE_CONFIG_KEYS.map((key) => [key, nextConfig[key]]).filter(([_, value]) => value !== undefined))
        : nextConfig;

    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tempPath, targetPath);
}

function persistConfigIfPossible(nextConfig, requestId) {
    const targetPath = CONFIG_RUNTIME_PATH || CONFIG_PATH;
    try {
        writeConfigFile(nextConfig);
        return { persisted: true, error: null };
    } catch (err) {
        logger.warn('config_persist_skipped', {
            request_id: requestId,
            error: err.message,
            config_path: targetPath,
        });
        return { persisted: false, error: err.message };
    }
}

async function mutateRuntimeConfig(requestId, buildMutation) {
    const run = async () => {
        const mutation = buildMutation(config) || {};
        if (!mutation.nextConfig) {
            return {
                changed: mutation.changed === true,
                persisted: true,
                error: null,
                config,
                data: mutation.data || {},
            };
        }

        validateConfig(mutation.nextConfig);
        const persistResult = persistConfigIfPossible(mutation.nextConfig, requestId);
        if (!persistResult.persisted) {
            return {
                changed: false,
                persisted: false,
                error: persistResult.error,
                config,
                data: mutation.data || {},
            };
        }

        applyMutableRuntimeConfig(mutation.nextConfig);
        if (mutation.changed !== false) {
            clearSubscriptionCache('runtime_config_mutation', requestId);
        }
        return {
            changed: mutation.changed !== false,
            persisted: true,
            error: null,
            config: mutation.nextConfig,
            data: mutation.data || {},
        };
    };

    const queued = runtimeConfigMutationQueue.then(run, run);
    runtimeConfigMutationQueue = queued.catch((err) => {
        logger.error('runtime_config_mutation_failed', {
            request_id: requestId,
            error: err.message,
        });
    });
    return queued;
}

function checkConfigPersistenceWritable() {
    const targetPath = CONFIG_RUNTIME_PATH || CONFIG_PATH;
    const targetDir = path.dirname(targetPath);
    const probePath = path.join(targetDir, `.write-test-${process.pid}-${Date.now()}`);
    try {
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        fs.writeFileSync(probePath, 'ok');
        fs.unlinkSync(probePath);
        return { ok: true, path: targetPath, error: null };
    } catch (err) {
        return { ok: false, path: targetPath, error: err.message };
    }
}

async function upsertQuarantineNode(nodeName, requestId, opts = {}) {
    const normalized = normalizeNodeName(nodeName);
    if (!normalized) return { changed: false, persisted: true, error: null };

    return mutateRuntimeConfig(requestId, (currentConfig) => {
        const runtime = getRuntimeConfig();
        const currentNodes = Array.isArray(currentConfig.quarantine_nodes) ? currentConfig.quarantine_nodes : [];
        const currentAutoNodes = Array.isArray(currentConfig.auto_quarantine_nodes) ? currentConfig.auto_quarantine_nodes : [];
        const existing = new Set(currentNodes.map(normalizeNodeName));
        if (existing.has(normalized)) return { changed: false };

        if (currentNodes.length >= runtime.autoQuarantineMaxNodes) {
            return {
                changed: false,
                nextConfig: null,
                data: { error: 'auto_quarantine_max_nodes reached' },
            };
        }

        const autoExisting = new Set(currentAutoNodes.map(normalizeNodeName));
        const nextAutoNodes = opts.auto === true && !autoExisting.has(normalized)
            ? [...currentAutoNodes, nodeName]
            : currentAutoNodes;
        const nextNodes = [...currentNodes, nodeName];
        return {
            changed: true,
            nextConfig: {
                ...currentConfig,
                quarantine_nodes: nextNodes,
                auto_quarantine_nodes: nextAutoNodes,
            },
        };
    }).then((result) => {
        if (result.changed) {
            const released = ensureStickyStore().releaseByNode(nodeName);
            runtimeStats.sticky_released_by_protection_total += released;
        }
        return {
            changed: result.changed,
            persisted: result.persisted && !result.data.error,
            error: result.error || result.data.error || null,
        };
    });
}

async function removeQuarantineNode(nodeName, requestId) {
    const normalized = normalizeNodeName(nodeName);
    if (!normalized) return { changed: false, persisted: true, error: null };

    return mutateRuntimeConfig(requestId, (currentConfig) => {
        const currentNodes = Array.isArray(currentConfig.quarantine_nodes) ? currentConfig.quarantine_nodes : [];
        const currentAutoNodes = Array.isArray(currentConfig.auto_quarantine_nodes) ? currentConfig.auto_quarantine_nodes : [];
        const nextNodes = currentNodes.filter((name) => normalizeNodeName(name) !== normalized);
        const nextAutoNodes = currentAutoNodes.filter((name) => normalizeNodeName(name) !== normalized);
        if (nextNodes.length === currentNodes.length) return { changed: false };

        return {
            changed: true,
            nextConfig: {
                ...currentConfig,
                quarantine_nodes: nextNodes,
                auto_quarantine_nodes: nextAutoNodes,
            },
        };
    }).then((result) => ({
        changed: result.changed,
        persisted: result.persisted,
        error: result.error,
    }));
}

function serializeProtectedNodes() {
    return ensureNodeProtectionManager()
        .list({ protectedOnly: true })
        .map((node) => ({
            node: node.nodeName,
            reason: node.isolation?.reason || 'protection',
            source: node.isolation?.source || 'system',
            mode: node.isolation?.mode || 'automatic',
            expires_at: node.isolation?.expiresAt ? new Date(node.isolation.expiresAt).toISOString() : null,
        }));
}

function protectionStateChanged(events) {
    return events.some((event) => (
        event.type === 'isolation_updated'
        || (event.to === 'isolated' && event.from !== 'recovering')
        || (event.to === 'healthy' && (event.from === 'isolated' || event.from === 'recovering'))
    ));
}

async function syncProtectionTransitions(events, requestId) {
    if (!Array.isArray(events) || events.length === 0) return { changed: false, persisted: true };

    for (const event of events) {
        if (event.to === 'isolated' && event.from !== 'recovering') {
            const released = ensureStickyStore().releaseByNode(event.nodeName);
            runtimeStats.protection_isolations_total += 1;
            runtimeStats.sticky_released_by_protection_total += released;
            logger.warn('node_protection_isolated', {
                request_id: requestId,
                node: event.nodeName,
                reason: event.reason,
                source: event.source,
                mode: event.mode,
                expires_at: toIsoTimestamp(event.expiresAt),
                sticky_released: released,
            });
        } else if (event.to === 'healthy' && (event.from === 'isolated' || event.from === 'recovering')) {
            runtimeStats.protection_releases_total += 1;
            logger.info('node_protection_released', {
                request_id: requestId,
                node: event.nodeName,
                reason: event.reason,
                source: event.source,
            });
        }
    }

    if (!protectionStateChanged(events)) return { changed: false, persisted: true };

    clearSubscriptionCache('node_protection_transition', requestId);
    const attackNodes = serializeProtectedNodes();
    const result = await mutateRuntimeConfig(requestId, (currentConfig) => ({
        changed: false,
        nextConfig: {
            ...currentConfig,
            attack_nodes: attackNodes,
        },
    }));
    if (!result.persisted) {
        logger.error('node_protection_persist_failed', {
            request_id: requestId,
            error: result.error,
        });
    }
    return { changed: true, persisted: result.persisted, error: result.error };
}

async function updateNodeProtectionFromNodes(nodes) {
    const runtime = getRuntimeConfig();
    const manager = ensureNodeProtectionManager();
    manager.expire();

    if (runtime.protectionEnabled && Array.isArray(nodes) && nodes.length > 0) {
        const maxProtected = Math.max(0, nodes.length - runtime.protectionMinAvailableNodes);
        let protectedCount = manager.summary().protected;

        for (const node of nodes) {
            const nodeName = (node.name || '').toString().trim();
            if (!nodeName) continue;
            const latencyMs = readNodeLatencyMs(node);
            const reasons = [];
            if (!Boolean(node.isConnected)) reasons.push('panel_disconnected');
            if (Boolean(node.isDisabled)) reasons.push('panel_disabled');
            if (latencyMs !== null && latencyMs >= runtime.protectionLatencyThresholdMs) {
                reasons.push('latency_threshold');
            }

            if (reasons.length === 0) {
                manager.recordSuccess(nodeName, { reason: 'health_check_recovered', source: 'panel_stats' });
                continue;
            }

            const current = manager.get(nodeName);
            const alreadyProtected = manager.isIsolated(nodeName);
            const wouldIsolate = !alreadyProtected
                && ((current?.failureCount || 0) + 1 >= runtime.protectionFailures);
            if (wouldIsolate && protectedCount >= maxProtected) {
                runtimeStats.protection_suppressed_total += 1;
                logger.warn('node_protection_isolation_suppressed', {
                    node: nodeName,
                    reason: reasons.join(','),
                    protected_count: protectedCount,
                    max_protected: maxProtected,
                });
                continue;
            }

            const result = manager.recordFailure(nodeName, {
                reason: reasons.join(','),
                source: 'panel_stats',
                ttlSec: runtime.protectionIsolationTtlSec,
            });
            if (!alreadyProtected && result.isolated) protectedCount += 1;
        }
    }

    const events = manager.drainEvents();
    if (events.length > 0) {
        await syncProtectionTransitions(events, `node-protection-${Date.now()}`);
    }
}

async function expireProtectionNodes() {
    const manager = ensureNodeProtectionManager();
    manager.expire();
    const events = manager.drainEvents();
    if (events.length > 0) {
        await syncProtectionTransitions(events, `node-protection-expiry-${Date.now()}`);
    } else {
        const attackNodes = serializeProtectedNodes();
        if (attackNodes.length !== ATTACK_NODES.length) {
            await mutateRuntimeConfig(`node-protection-cleanup-${Date.now()}`, (currentConfig) => ({
                changed: false,
                nextConfig: {
                    ...currentConfig,
                    attack_nodes: attackNodes,
                },
            }));
        }
    }
    return { ok: true, events: events.length };
}

async function updateAutoQuarantineFromNodes(nodes) {
    const runtime = getRuntimeConfig();
    if (!runtime.autoQuarantineEnabled || !Array.isArray(nodes) || nodes.length === 0) return;

    const requestId = `auto-quarantine-${Date.now()}`;
    const activeNames = new Set();
    const quarantinedSet = new Set(QUARANTINE_NODES.map(normalizeNodeName).filter(Boolean));
    const autoManagedSet = new Set(AUTO_QUARANTINE_NODES.map(normalizeNodeName).filter(Boolean));

    for (const node of nodes) {
        const nodeName = (node.name || '').toString().trim();
        if (!nodeName) continue;
        activeNames.add(nodeName);

        const isConnected = Boolean(node.isConnected);
        const isDisabled = Boolean(node.isDisabled);
        const usersOnline = node.usersOnline || 0;
        const totalRamGb = parseRamGb(node.totalRam);
        const cpuCount = node.cpuCount || 1;
        const { load } = computeNodeLoad(usersOnline, totalRamGb, cpuCount);
        const degraded = !isConnected || isDisabled || load > 1.0;

        const normalizedNodeName = normalizeNodeName(nodeName);
        const prev = autoQuarantineState.get(nodeName) || {
            fail: 0,
            ok: 0,
            auto: autoManagedSet.has(normalizedNodeName),
        };
        if (degraded) {
            prev.fail += 1;
            prev.ok = 0;
        } else {
            prev.ok += 1;
            prev.fail = 0;
        }

        const currentlyQuarantined = quarantinedSet.has(normalizedNodeName);
        if (!currentlyQuarantined && prev.fail >= runtime.autoQuarantineFailures) {
            const result = await upsertQuarantineNode(nodeName, requestId, { auto: true });
            if (result.changed) {
                prev.auto = true;
                quarantinedSet.add(normalizedNodeName);
                autoManagedSet.add(normalizedNodeName);
                logger.warn('auto_quarantine_added', {
                    node: nodeName,
                    fail_count: prev.fail,
                    degraded,
                    persisted: result.persisted,
                    persist_error: result.error,
                });
            }
        } else if (currentlyQuarantined && (prev.auto || autoManagedSet.has(normalizedNodeName)) && prev.ok >= runtime.autoQuarantineReleaseSuccesses) {
            const result = await removeQuarantineNode(nodeName, requestId);
            if (result.changed) {
                prev.auto = false;
                quarantinedSet.delete(normalizedNodeName);
                autoManagedSet.delete(normalizedNodeName);
                logger.info('auto_quarantine_released', {
                    node: nodeName,
                    success_count: prev.ok,
                    persisted: result.persisted,
                    persist_error: result.error,
                });
            }
        }

        autoQuarantineState.set(nodeName, prev);
    }

    for (const nodeName of autoQuarantineState.keys()) {
        if (!activeNames.has(nodeName)) {
            autoQuarantineState.delete(nodeName);
        }
    }
}

function readJsonBody(req, maxBytes = 512 * 1024) {
    return new Promise((resolve, reject) => {
        let raw = '';
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('Payload too large'));
                req.destroy();
                return;
            }
            raw += chunk;
        });
        req.on('end', () => {
            if (!raw.trim()) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

// ─── Парсинг RAM ───

function parseRamGb(ramStr) {
    if (!ramStr) return 1;
    const match = ramStr.match(/([\d.]+)\s*(GB|MB)/i);
    if (!match) return 1;
    const val = parseFloat(match[1]);
    if (match[2].toUpperCase() === 'MB') return val / 1024;
    return val;
}

function computeNodeLoad(usersOnline, totalRamGb, cpuCount) {
    const ramLoad = totalRamGb > 0 ? usersOnline / totalRamGb : 999;
    const cpuLoad = cpuCount > 0 ? usersOnline / cpuCount : 999;
    const ramNorm = ramLoad / MAX_USERS_PER_GB;
    const cpuNorm = cpuLoad / MAX_USERS_PER_CPU;
    const load = Math.max(ramNorm, cpuNorm);
    return { ramLoad, cpuLoad, load };
}

function readNodeLatencyMs(node) {
    const candidates = [
        node?.latency_ms,
        node?.latencyMs,
        node?.latency,
        node?.ping_ms,
        node?.pingMs,
        node?.ping,
        node?.rtt_ms,
        node?.rtt,
    ];
    for (const candidate of candidates) {
        const value = Number(candidate);
        if (Number.isFinite(value) && value >= 0) return value;
    }
    return null;
}

function updateAutoDrainFromNodes(nodes) {
    const runtime = getRuntimeConfig();
    if (!runtime.autoDrainEnabled || !Array.isArray(nodes) || nodes.length === 0) return;

    const activeNames = new Set();
    let changed = false;
    for (const node of nodes) {
        const nodeName = (node.name || '').toString().trim();
        if (!nodeName) continue;
        activeNames.add(nodeName);

        const usersOnline = node.usersOnline || 0;
        const totalRamGb = parseRamGb(node.totalRam);
        const cpuCount = node.cpuCount || 1;
        const isConnected = Boolean(node.isConnected);
        const isDisabled = Boolean(node.isDisabled);
        const { load } = computeNodeLoad(usersOnline, totalRamGb, cpuCount);
        const degraded = !isConnected || isDisabled || load >= runtime.autoDrainLoadThreshold;

        const prev = autoDrainState.get(nodeName) || { fail: 0, ok: 0, drained: false };
        if (degraded) {
            prev.fail += 1;
            prev.ok = 0;
        } else {
            prev.ok += 1;
            prev.fail = 0;
        }

        const normalizedName = normalizeNodeName(nodeName);
        if (!prev.drained && prev.fail >= runtime.autoDrainFailures) {
            prev.drained = true;
            if (normalizedName) autoDrainNodes.add(normalizedName);
            const released = ensureStickyStore().releaseByNode(nodeName);
            runtimeStats.sticky_released_by_protection_total += released;
            changed = true;
            logger.warn('auto_drain_added', {
                node: nodeName,
                load,
                fail_count: prev.fail,
                threshold: runtime.autoDrainLoadThreshold,
            });
        } else if (prev.drained && prev.ok >= runtime.autoDrainReleaseSuccesses) {
            prev.drained = false;
            if (normalizedName) autoDrainNodes.delete(normalizedName);
            changed = true;
            logger.info('auto_drain_released', {
                node: nodeName,
                load,
                success_count: prev.ok,
            });
        }

        autoDrainState.set(nodeName, prev);
    }

    for (const nodeName of autoDrainState.keys()) {
        if (!activeNames.has(nodeName)) {
            autoDrainState.delete(nodeName);
            if (autoDrainNodes.delete(normalizeNodeName(nodeName))) changed = true;
        }
    }

    if (changed) {
        clearSubscriptionCache('auto_drain_transition', `auto-drain-${Date.now()}`);
    }
}

// ─── Node Stats — опрос панели ───

async function fetchNodeStatsNow() {
    if (!API_TOKEN || !REMNAWAVE_URL) {
        lastNodeStatsError = 'API token or REMNAWAVE_URL is missing';
        return { ok: false, error: lastNodeStatsError };
    }
    try {
        const response = await fetchUrl(`${REMNAWAVE_URL}/api/nodes/`, panelHeaders());
        if (response.status !== 200) {
            console.error('[node-stats] API вернул', response.status);
            lastNodeStatsError = `Panel API returned ${response.status}`;
            return { ok: false, error: lastNodeStatsError };
        }
        const data = JSON.parse(response.body);
        const nodes = data.response || (Array.isArray(data) ? data : []);
        updateAutoDrainFromNodes(nodes);
        await updateAutoQuarantineFromNodes(nodes);
        await updateNodeProtectionFromNodes(nodes);

        const newCache = {};
        for (const node of nodes) {
            const name = node.name || '';
            const address = typeof node.address === 'string' ? node.address.trim() : '';
            const usersOnline = node.usersOnline || 0;
            const totalRamGb = parseRamGb(node.totalRam);
            const cpuCount = node.cpuCount || 1;
            const isConnected = node.isConnected || false;
            const isDisabled = node.isDisabled || false;
            const latencyMs = readNodeLatencyMs(node);

            const { ramLoad, cpuLoad, load } = computeNodeLoad(usersOnline, totalRamGb, cpuCount);
            const normalizedLoad = Math.round(load * 100) / 100;

            newCache[name] = {
                usersOnline,
                totalRamGb,
                cpuCount,
                ramLoad: Math.round(ramLoad * 100) / 100,
                cpuLoad: Math.round(cpuLoad * 100) / 100,
                load: normalizedLoad,
                isConnected,
                isDisabled,
                isAlias: false,
                sourceNode: name,
                ...(latencyMs === null ? {} : { latency_ms: latencyMs }),
            };

            if (address && address !== name) {
                newCache[address] = {
                    ...newCache[name],
                    isAlias: true,
                    sourceNode: name,
                };
            }

            // Также кэшируем по тегам inbound'ов (для матчинга с outbound тегами)
            if (node.configProfile && node.configProfile.activeInbounds) {
                for (const inb of node.configProfile.activeInbounds) {
                    if (inb.tag && inb.tag !== name) {
                        newCache[inb.tag] = {
                            ...newCache[name],
                            isAlias: true,
                            sourceNode: name,
                        };
                    }
                }
            }
        }

        nodeStatsCache = newCache;
        const sorted = Object.entries(newCache)
            .filter(([_, s]) => s.isConnected && !s.isDisabled)
            .sort((a, b) => a[1].load - b[1].load);

        console.log(`[node-stats] Обновлено: ${sorted.length} нод (пороги: ${MAX_USERS_PER_GB} u/GB, ${MAX_USERS_PER_CPU} u/CPU)`);
        for (const [name, s] of sorted.slice(0, 5)) {
            console.log(`  ${name}: ${s.usersOnline}u, ${s.totalRamGb}GB/${s.cpuCount}CPU, ram=${s.ramLoad} cpu=${s.cpuLoad} load=${s.load}`);
        }
        if (sorted.length > 5) console.log(`  ... и ещё ${sorted.length - 5}`);
        lastNodeStatsRefreshAt = Date.now();
        lastNodeStatsError = null;
        return { ok: true, nodes: sorted.length };

    } catch (err) {
        console.error('[node-stats] Ошибка:', err.message);
        lastNodeStatsError = err.message;
        return { ok: false, error: lastNodeStatsError };
    }
}

async function fetchNodeStats() {
    if (nodeStatsRefreshInFlight) {
        return nodeStatsRefreshInFlight;
    }

    nodeStatsRefreshInFlight = fetchNodeStatsNow().finally(() => {
        nodeStatsRefreshInFlight = null;
    });
    return nodeStatsRefreshInFlight;
}

// ─── Remnawave API ───

const COUNTRY_PATTERNS = {
    'Finland': { emoji: '🇫🇮', patterns: ['Finland', 'Финлянд', 'FI', 'Helsinki'] },
    'Germany': { emoji: '🇩🇪', patterns: ['Germany', 'German', 'Германи', 'DE', 'Berlin', 'Frankfurt'] },
    'Netherlands': { emoji: '🇳🇱', patterns: ['Netherlands', 'Нидерланд', 'NL', 'Amsterdam', 'Holland'] },
    'USA': { emoji: '🇺🇸', patterns: ['USA', 'United States', 'Америк', 'US', 'New York', 'Los Angeles', 'Dallas'] },
    'Sweden': { emoji: '🇸🇪', patterns: ['Sweden', 'Швеци', 'SE', 'Stockholm'] },
    'France': { emoji: '🇫🇷', patterns: ['France', 'Франци', 'FR', 'Paris'] },
    'UK': { emoji: '🇬🇧', patterns: ['United Kingdom', 'UK', 'Британи', 'GB', 'London', 'England'] },
    'Poland': { emoji: '🇵🇱', patterns: ['Poland', 'Польш', 'PL', 'Warsaw'] },
    'Turkey': { emoji: '🇹🇷', patterns: ['Turkey', 'Турци', 'TR', 'Istanbul'] },
    'Japan': { emoji: '🇯🇵', patterns: ['Japan', 'Япони', 'JP', 'Tokyo'] },
    'Singapore': { emoji: '🇸🇬', patterns: ['Singapore', 'Сингапур', 'SG'] },
    'Austria': { emoji: '🇦🇹', patterns: ['Austria', 'Австри', 'AT', 'Vienna'] },
    'Canada': { emoji: '🇨🇦', patterns: ['Canada', 'Канад', 'CA', 'Toronto'] },
    'Australia': { emoji: '🇦🇺', patterns: ['Australia', 'Австрали', 'AU', 'Sydney'] },
    'Italy': { emoji: '🇮🇹', patterns: ['Italy', 'Итали', 'IT', 'Rome', 'Milan'] },
    'Spain': { emoji: '🇪🇸', patterns: ['Spain', 'Испани', 'ES', 'Madrid'] },
    'Czech': { emoji: '🇨🇿', patterns: ['Czech', 'Чехи', 'CZ', 'Prague'] },
    'Romania': { emoji: '🇷🇴', patterns: ['Romania', 'Румыни', 'RO'] },
    'Bulgaria': { emoji: '🇧🇬', patterns: ['Bulgaria', 'Болгари', 'BG'] },
    'Latvia': { emoji: '🇱🇻', patterns: ['Latvia', 'Латви', 'LV', 'Riga'] },
    'Lithuania': { emoji: '🇱🇹', patterns: ['Lithuania', 'Литв', 'LT', 'Vilnius'] },
    'Estonia': { emoji: '🇪🇪', patterns: ['Estonia', 'Эстони', 'EE', 'Tallinn'] },
    'Ireland': { emoji: '🇮🇪', patterns: ['Ireland', 'Ирланди', 'IE', 'Dublin'] },
    'Kazakhstan': { emoji: '🇰🇿', patterns: ['Kazakhstan', 'Казахстан', 'KZ'] },
    'Ukraine': { emoji: '🇺🇦', patterns: ['Ukraine', 'Украин', 'UA', 'Kyiv'] },
    'Moldova': { emoji: '🇲🇩', patterns: ['Moldova', 'Молдов', 'MD'] },
    'India': { emoji: '🇮🇳', patterns: ['India', 'Инди', 'IN', 'Mumbai'] },
    'Brazil': { emoji: '🇧🇷', patterns: ['Brazil', 'Бразили', 'BR'] },
    'LTE': { emoji: '🇪🇺', patterns: ['LTE', 'ЕВРОПА'] },
};

function detectCountryFromRemark(remark) {
    const remarkLower = remark.toLowerCase();
    let bestMatch = null;
    let bestLen = 0;

    for (const [country, info] of Object.entries(COUNTRY_PATTERNS)) {
        for (const pattern of info.patterns) {
            const patLower = pattern.toLowerCase();
            let matched = false;

            if (patLower.length <= 2) {
                const regex = new RegExp(`(?:^|[^a-z])${patLower}(?:$|[^a-z])`);
                matched = regex.test(remarkLower);
            } else {
                matched = remarkLower.includes(patLower);
            }

            if (matched && patLower.length > bestLen) {
                bestMatch = { country, emoji: info.emoji, patterns: info.patterns };
                bestLen = patLower.length;
            }
        }
    }
    return bestMatch;
}

async function fetchHostsFromApi() {
    if (!API_TOKEN) return { ok: false, error: 'API token is missing', hosts: null };
    try {
        const response = await fetchUrl(`${REMNAWAVE_URL}/api/hosts/`, panelHeaders());
        if (response.status !== 200) return { ok: false, error: `Panel API returned ${response.status}`, hosts: null };
        const data = JSON.parse(response.body);
        const hosts = data.response || (Array.isArray(data) ? data : null);
        if (!hosts) return { ok: false, error: 'Panel API response does not contain hosts', hosts: null };
        return { ok: true, error: null, hosts };
    } catch (err) {
        console.error('[auto-groups] Ошибка:', err.message);
        return { ok: false, error: err.message, hosts: null };
    }
}

function buildGroupsFromHosts(hosts) {
    const groups = {};
    const seen = new Set();
    for (const host of hosts.filter(h => !h.isDisabled)) {
        const remark = host.remark || host.tag || host.address || '';
        const detected = detectCountryFromRemark(remark);
        if (detected && !seen.has(detected.country)) {
            seen.add(detected.country);
            groups[`${detected.emoji} ${detected.country}`] = detected.patterns;
        }
    }
    return groups;
}

async function refreshGroups(opts = {}) {
    const hostsResult = await fetchHostsFromApi();
    if (!hostsResult.ok || !hostsResult.hosts) return { ok: false, error: hostsResult.error || 'Failed to fetch hosts' };
    const hosts = hostsResult.hosts;
    const newGroups = buildGroupsFromHosts(hosts);
    if (Object.keys(newGroups).length === 0) return { ok: false, error: 'No groups detected from enabled hosts' };
    if (opts.persist === true) {
        const mutationResult = await mutateRuntimeConfig(opts.requestId || 'refresh-groups', (currentConfig) => {
            const mergedGroups = { ...newGroups, ...(currentConfig.groups || {}) };
            return {
                changed: true,
                nextConfig: {
                    ...currentConfig,
                    groups: mergedGroups,
                },
            };
        });
        if (!mutationResult.persisted) {
            return { ok: false, error: mutationResult.error || 'Failed to persist refreshed groups' };
        }
    } else {
        const previousGroupsJson = JSON.stringify(GROUPS);
        const mergedGroups = { ...newGroups, ...(config.groups || {}) };
        GROUPS = mergedGroups;
        if (JSON.stringify(GROUPS) !== previousGroupsJson) {
            clearSubscriptionCache('refresh_groups', opts.requestId || 'refresh-groups');
        }
    }
    console.log(`[auto-groups] Обновлены: ${Object.entries(GROUPS).map(([k, v]) => `${k} [${v}]`).join(' | ')}`);
    return { ok: true, groups: GROUPS };
}

// ─── Собрать все прокси-outbound'ы из XRAY-JSON массива ───

function collectAllProxyOutbounds(configArray) {
    const systemProtocols = new Set(['freedom', 'blackhole', 'dns']);
    const allOutbounds = [];
    const seenTags = new Set();

    for (let i = 0; i < configArray.length; i++) {
        const cfg = configArray[i];
        const outbounds = cfg.outbounds || [];
        const remarks = cfg.remarks || `connection-${i}`;

        for (const ob of outbounds) {
            if (systemProtocols.has(ob.protocol)) continue;
            if (!ob.tag) continue;

            const cloned = { ...ob };

            let tag = cloned.tag;
            if (tag === 'proxy' && remarks) {
                tag = remarks;
            }
            if (seenTags.has(tag)) {
                const baseTag = tag;
                let suffix = i;
                while (seenTags.has(tag)) {
                    tag = `${baseTag}-${suffix}`;
                    suffix += 1;
                }
            }
            cloned.tag = tag;
            if (cfg.description && !cloned.description) cloned.description = cfg.description;
            if (cfg.serverDescription && !cloned.serverDescription) cloned.serverDescription = cfg.serverDescription;
            if (cfg.server_description && !cloned.server_description) cloned.server_description = cfg.server_description;
            if (cfg.title && !cloned.title) cloned.title = cfg.title;
            if (cfg.ps && !cloned.ps) cloned.ps = cfg.ps;
            seenTags.add(tag);
            allOutbounds.push(cloned);
        }
    }

    return allOutbounds;
}

// ─── HTTP сервер ───

// Заголовки запроса которые НЕ пробрасываем на upstream
const SKIP_REQUEST_HEADERS = new Set([
    'authorization',
    'cookie',
    'accept-encoding',      // Чтобы upstream не сжимал ответ
    'host',                 // Перезаписываем сами
    'connection',           // Hop-by-hop
    'keep-alive',           // Hop-by-hop
    'transfer-encoding',    // Hop-by-hop
    'te',                   // Hop-by-hop
    'upgrade',              // Hop-by-hop
    'x-admin-token',
    'proxy-authorization',  // Не нужен для upstream
    'proxy-connection',     // Hop-by-hop
]);

// Заголовки ответа которые НЕ пробрасываем клиенту
const SKIP_RESPONSE_HEADERS = new Set([
    'set-cookie',
    'set-cookie2',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'te',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization',
    'cache-control',
    'pragma',
    'expires',
    'content-length',       // Пересчитываем сами
    'content-encoding',     // Мы отдаём без сжатия
    'date',                 // Своё выставит Node.js
    'server',               // Не светим upstream (nginx и т.д.)
]);

// Request/response header helpers.
const CACHE_VARIANT_HEADERS = new Set([
    'accept',
    'user-agent',
    'x-hwid',
    'x-device-id',
    'x-device-model',
    'x-device-os',
    'x-platform',
    'x-app-version',
]);

const NO_STORE_HEADERS = {
    'Cache-Control': 'no-store, private',
    Pragma: 'no-cache',
    Expires: '0',
};

function applyNoStoreHeaders(res) {
    for (const [key, value] of Object.entries(NO_STORE_HEADERS)) {
        res.setHeader(key, value);
    }
}

function sendMethodNotAllowed(res, requestId, allowedMethods) {
    res.writeHead(405, {
        'Content-Type': 'application/json',
        Allow: allowedMethods.join(', '),
    });
    res.end(JSON.stringify({ status: 'error', code: 'METHOD_NOT_ALLOWED', request_id: requestId }));
}

function buildForwardHeaders(req, clientIp) {
    const forwardHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (!SKIP_REQUEST_HEADERS.has(key)) {
            forwardHeaders[key] = value;
        }
    }

    if (!forwardHeaders['user-agent']) {
        forwardHeaders['user-agent'] = 'Happ/1.0';
    }

    if (SUB_PAGE_URL) {
        forwardHeaders['X-Forwarded-Proto'] = 'https';
        forwardHeaders['X-Forwarded-For'] = clientIp;
        forwardHeaders['X-Real-IP'] = clientIp;
        forwardHeaders['Host'] = SUB_DOMAIN || req.headers['host'] || 'localhost';
    }

    return forwardHeaders;
}

function normalizeHeaderValue(value) {
    const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
    return raw.trim().replace(/\s+/g, ' ').slice(0, 1024);
}

function buildSubscriptionCacheKey(token, forwardHeaders = {}) {
    const variantHeaders = [];
    for (const [key, value] of Object.entries(forwardHeaders)) {
        const normalizedKey = key.toLowerCase();
        if (!CACHE_VARIANT_HEADERS.has(normalizedKey)) continue;
        const normalizedValue = normalizeHeaderValue(value);
        if (normalizedValue) variantHeaders.push([normalizedKey, normalizedValue]);
    }
    variantHeaders.sort(([a], [b]) => a.localeCompare(b));
    const variantHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(variantHeaders))
        .digest('base64url')
        .slice(0, 16);
    return `${token}:${variantHash}`;
}

function forwardResponseHeaders(upstreamHeaders, contentType) {
    const result = { 'Content-Type': contentType || 'application/json; charset=utf-8' };
    for (const [key, val] of Object.entries(upstreamHeaders)) {
        const normalizedKey = key.toLowerCase();
        if (!SKIP_RESPONSE_HEADERS.has(normalizedKey) && normalizedKey !== 'content-type') {
            result[key] = val;
        }
    }
    return result;
}

function sanitizeHeadersForCache(upstreamHeaders = {}) {
    const result = {};
    for (const [key, val] of Object.entries(upstreamHeaders)) {
        if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
            result[key] = val;
        }
    }
    return result;
}

function getCachedFallback(token) {
    const fresh = subscriptionCache.get(token);
    if (fresh) return { kind: 'fresh', item: fresh };
    const stale = subscriptionCache.getStale(token, CACHE_STALE_IF_ERROR_SEC);
    if (stale) return { kind: 'stale', item: stale };
    return null;
}

function getNegativeCachedResponse(cacheKey) {
    const item = negativeSubscriptionCache.get(cacheKey);
    if (!item) return null;
    try {
        return JSON.parse(item.body);
    } catch {
        return null;
    }
}

function setNegativeCachedResponse(cacheKey, upstream) {
    negativeSubscriptionCache.set(cacheKey, JSON.stringify({
        status: upstream.status,
        body: upstream.body,
        headers: sanitizeHeadersForCache(upstream.headers),
    }));
}

function isServiceFailureStatus(status) {
    return status >= 500;
}

function canFallbackForStatus(status) {
    return status >= 500 || status === 408 || status === 429;
}

function toIsoTimestamp(ms) {
    return ms > 0 ? new Date(ms).toISOString() : null;
}

function normalizeNodeName(value) {
    return (value || '').toString().trim().toLowerCase();
}

function buildQuarantineSet() {
    return new Set(QUARANTINE_NODES.map(normalizeNodeName).filter(Boolean));
}

function buildProtectionSet() {
    return new Set(
        ensureNodeProtectionManager()
            .list({ protectedOnly: true })
            .map((node) => node.normalizedNode)
            .filter(Boolean)
    );
}

function buildGroupNameSet(names) {
    return new Set((Array.isArray(names) ? names : []).map(normalizeNodeName).filter(Boolean));
}

function isNodeQuarantined(tag, quarantineSet, sourceNode = null) {
    if (quarantineSet.size === 0) return false;

    const normalizedTag = normalizeNodeName(tag);
    const normalizedSourceNode = normalizeNodeName(sourceNode);

    if (normalizedTag && quarantineSet.has(normalizedTag)) return true;
    if (normalizedSourceNode && quarantineSet.has(normalizedSourceNode)) return true;

    return false;
}

function getNodeStatsAgeMs(now = Date.now()) {
    return lastNodeStatsRefreshAt > 0 ? now - lastNodeStatsRefreshAt : null;
}

function isNodeStatsFresh(now = Date.now()) {
    const age = getNodeStatsAgeMs(now);
    return age !== null && age <= NODE_STATS_STALE_MS;
}

async function warmupToken(token) {
    const targetUrl = `http://127.0.0.1:${PORT}/${token}`;
    const forwardHeaders = {
        'user-agent': 'Happ/1.0',
        accept: '*/*',
    };
    try {
        const upstream = await fetchUrl(targetUrl, forwardHeaders, 0, Date.now() + REQUEST_TIMEOUT_MS + 1000);
        if (upstream.status !== 200) return false;
        const classified = classifyUpstreamPayload(upstream.body);
        if (classified.type === 'xray_json') {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function runManagedBackgroundTask(taskName, task) {
    if (shuttingDown) return Promise.resolve({ ok: false, skipped: true });

    let promise;
    promise = (async () => {
        try {
            return await task();
        } catch (err) {
            logger.error('background_task_failed', { task: taskName, message: err.message });
            return { ok: false, error: err.message };
        } finally {
            activeBackgroundTasks.delete(promise);
        }
    })();
    activeBackgroundTasks.add(promise);
    return promise;
}

function clearBackgroundIntervals() {
    for (const timer of backgroundIntervals) {
        clearInterval(timer);
    }
    backgroundIntervals.clear();
}

async function waitForBackgroundTasks(timeoutMs) {
    if (activeBackgroundTasks.size === 0) return { timedOut: false, pending: 0 };

    let timeout = null;
    let completed = false;
    await Promise.race([
        Promise.allSettled([...activeBackgroundTasks]).then(() => {
            completed = true;
        }),
        new Promise((resolve) => {
            timeout = setTimeout(resolve, timeoutMs);
        }),
    ]);
    if (timeout) clearTimeout(timeout);
    return { timedOut: !completed && activeBackgroundTasks.size > 0, pending: activeBackgroundTasks.size };
}

function setNonOverlappingInterval(taskName, task, intervalMs) {
    let running = false;
    const timer = setInterval(() => {
        if (shuttingDown) return;
        if (running) {
            runtimeStats.background_overlap_skipped_total += 1;
            logger.warn('background_task_overlap_skipped', { task: taskName });
            return;
        }

        running = true;
        runManagedBackgroundTask(taskName, task).finally(() => {
            running = false;
        });
    }, intervalMs);
    backgroundIntervals.add(timer);
    return timer;
}

function scheduleStartupTasks() {
    setNonOverlappingInterval('expire_protection_nodes', () => expireProtectionNodes(), 30000);

    if (AUTO_GROUPS && API_TOKEN) {
        runManagedBackgroundTask('initial_refresh_groups', () => refreshGroups()).finally(() => {
            if (!shuttingDown) {
                setNonOverlappingInterval('refresh_groups', () => refreshGroups(), AUTO_GROUPS_INTERVAL);
            }
        });
    }

    if (NODE_STATS_ENABLED && API_TOKEN) {
        runManagedBackgroundTask('initial_fetch_node_stats', () => fetchNodeStats()).finally(() => {
            if (!shuttingDown) {
                setNonOverlappingInterval('fetch_node_stats', () => fetchNodeStats(), NODE_STATS_INTERVAL);
            }
        });
    }

    if (WARMUP_TOKENS.length > 0) {
        runManagedBackgroundTask('warmup_tokens', async () => {
            let warmed = 0;
            for (const token of WARMUP_TOKENS) {
                if (shuttingDown) break;
                if (await warmupToken(token)) warmed += 1;
            }
            console.log(`рџ”Ґ Warmup: ${warmed}/${WARMUP_TOKENS.length} С‚РѕРєРµРЅРѕРІ`);
            return { ok: true, warmed };
        });
    }
}

function formatStrategyForLog() {
    if (STRATEGY === 'leastLoad') {
        return `${STRATEGY} (expected=1, baselines=1s, tolerance=0.8)`;
    }
    return STRATEGY;
}

const server = http.createServer(async (req, res) => {
    const requestId = normalizeRequestId(req.headers['x-request-id'], crypto.randomUUID());
    let parsedUrl;
    try {
        parsedUrl = new URL(req.url || '/', 'http://localhost');
    } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', code: 'BAD_REQUEST', request_id: requestId }));
        return;
    }
    const pathname = parsedUrl.pathname;
    const clientIp = resolveClientIp(req);
    if (pathname.startsWith('/admin/')) {
        applyNoStoreHeaders(res);
    }

    if (pathname === '/health' || pathname === '/mw-health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            request_id: requestId,
        }));
        return;
    }

    if (pathname === '/admin/groups') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }

        if (req.method === 'GET') {
            const runtime = getRuntimeConfig();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                request_id: requestId,
                groups: GROUPS,
                group_descriptions: GROUP_DESCRIPTIONS,
                strategy: STRATEGY,
                fastest_group: config.fastest_group !== false,
                fastest_group_name: (config.fastest_group_name || DEFAULT_FASTEST_GROUP_NAME),
                fastest_exclude_groups: FASTEST_EXCLUDE_GROUPS,
                fastest_fallback: FASTEST_FALLBACK_GROUPS,
                node_stats_exclude: NODE_STATS_EXCLUDE_GROUPS,
                expand_groups_to_nodes: EXPAND_GROUPS_TO_NODES,
                hidden_groups: HIDDEN_GROUPS,
                hidden_nodes: HIDDEN_NODES,
                quarantine_nodes: QUARANTINE_NODES,
                auto_quarantine_nodes: AUTO_QUARANTINE_NODES,
                attack_nodes: ATTACK_NODES,
                auto_quarantine_enabled: runtime.autoQuarantineEnabled,
                auto_quarantine_failures: runtime.autoQuarantineFailures,
                auto_quarantine_release_successes: runtime.autoQuarantineReleaseSuccesses,
                auto_quarantine_max_nodes: runtime.autoQuarantineMaxNodes,
                auto_drain_enabled: runtime.autoDrainEnabled,
                auto_drain_failures: runtime.autoDrainFailures,
                auto_drain_release_successes: runtime.autoDrainReleaseSuccesses,
                auto_drain_load_threshold: runtime.autoDrainLoadThreshold,
                auto_drain_score_penalty: runtime.autoDrainScorePenalty,
                sticky_enabled: runtime.stickyEnabled,
                sticky_mode: runtime.stickyMode,
                sticky_new_connections_only: runtime.stickyNewConnectionsOnly,
                sticky_ttl_sec: runtime.stickyTtlSec,
                sticky_max_entries: runtime.stickyMaxEntries,
                probe_interval: runtime.probeInterval,
                probe_sampling: runtime.probeSampling,
                probe_timeout: runtime.probeTimeout,
                probe_connectivity_url: runtime.probeConnectivityUrl,
                probe_http_method: runtime.probeHttpMethod,
                fastest_probe_url: runtime.fastestProbeUrl,
                protection_enabled: runtime.protectionEnabled,
                protection_failures: runtime.protectionFailures,
                protection_release_successes: runtime.protectionReleaseSuccesses,
                protection_isolation_ttl_sec: runtime.protectionIsolationTtlSec,
                protection_latency_threshold_ms: runtime.protectionLatencyThresholdMs,
                protection_min_available_nodes: runtime.protectionMinAvailableNodes,
                emergency_fallback_enabled: runtime.emergencyFallbackEnabled,
                emergency_fallback_max_nodes: runtime.emergencyFallbackMaxNodes,
                balancer_load_weight: runtime.balancerLoadWeight,
                balancer_latency_weight: runtime.balancerLatencyWeight,
                balancer_max_latency_ms: runtime.balancerMaxLatencyMs,
                balancer_smoothing_alpha: runtime.balancerSmoothingAlpha,
                balancer_hysteresis_delta: runtime.balancerHysteresisDelta,
            }));
            return;
        }

        if (req.method !== 'PUT') {
            sendMethodNotAllowed(res, requestId, ['GET', 'PUT']);
            return;
        }

        try {
            const payload = await readJsonBody(req);
            const incomingGroups = payload.groups;
            const incomingGroupDescriptions = payload.group_descriptions;
            const incomingExclude = payload.fastest_exclude_groups;
            const incomingFastestFallback = payload.fastest_fallback;
            const incomingNodeStatsExclude = payload.node_stats_exclude;
            const incomingExpandGroupsToNodes = payload.expand_groups_to_nodes;
            const incomingHiddenGroups = payload.hidden_groups;
            const incomingHiddenNodes = payload.hidden_nodes;
            const incomingFastest = payload.fastest_group;
            const incomingFastestName = payload.fastest_group_name;

            const mutationResult = await mutateRuntimeConfig(requestId, (currentConfig) => {
                const nextConfig = { ...currentConfig };
                if (incomingGroups !== undefined) nextConfig.groups = incomingGroups;
                if (incomingGroupDescriptions !== undefined) nextConfig.group_descriptions = incomingGroupDescriptions;
                if (incomingExclude !== undefined) nextConfig.fastest_exclude_groups = incomingExclude;
                if (incomingFastestFallback !== undefined) nextConfig.fastest_fallback = incomingFastestFallback;
                if (incomingNodeStatsExclude !== undefined) nextConfig.node_stats_exclude = incomingNodeStatsExclude;
                if (incomingExpandGroupsToNodes !== undefined) nextConfig.expand_groups_to_nodes = incomingExpandGroupsToNodes;
                if (incomingHiddenGroups !== undefined) nextConfig.hidden_groups = incomingHiddenGroups;
                if (incomingHiddenNodes !== undefined) nextConfig.hidden_nodes = incomingHiddenNodes;
                if (incomingFastest !== undefined) nextConfig.fastest_group = incomingFastest;
                if (incomingFastestName !== undefined) nextConfig.fastest_group_name = incomingFastestName;
                for (const key of MUTABLE_CONFIG_KEYS) {
                    if (key === 'attack_nodes') continue;
                    if (payload[key] !== undefined) {
                        nextConfig[key] = payload[key];
                    }
                }
                if (nextConfig.strategy !== undefined) {
                    nextConfig.strategy = normalizeStrategy(nextConfig.strategy);
                }
                return { changed: true, nextConfig };
            });
            if (!mutationResult.persisted) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    code: 'CONFIG_PERSIST_FAILED',
                    request_id: requestId,
                    message: mutationResult.error,
                }));
                return;
            }
            const runtime = getRuntimeConfig();

            logger.info('admin_groups_updated', {
                request_id: requestId,
                groups_count: Object.keys(GROUPS).length,
                fastest_group: config.fastest_group !== false,
                fastest_group_name: (config.fastest_group_name || DEFAULT_FASTEST_GROUP_NAME),
                fastest_exclude_groups_count: FASTEST_EXCLUDE_GROUPS.length,
                persisted: mutationResult.persisted,
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                request_id: requestId,
                groups: GROUPS,
                strategy: STRATEGY,
                fastest_group: config.fastest_group !== false,
                fastest_group_name: (config.fastest_group_name || DEFAULT_FASTEST_GROUP_NAME),
                fastest_exclude_groups: FASTEST_EXCLUDE_GROUPS,
                fastest_fallback: FASTEST_FALLBACK_GROUPS,
                node_stats_exclude: NODE_STATS_EXCLUDE_GROUPS,
                expand_groups_to_nodes: EXPAND_GROUPS_TO_NODES,
                hidden_groups: HIDDEN_GROUPS,
                hidden_nodes: HIDDEN_NODES,
                quarantine_nodes: QUARANTINE_NODES,
                auto_quarantine_nodes: AUTO_QUARANTINE_NODES,
                attack_nodes: ATTACK_NODES,
                auto_quarantine_enabled: runtime.autoQuarantineEnabled,
                auto_quarantine_failures: runtime.autoQuarantineFailures,
                auto_quarantine_release_successes: runtime.autoQuarantineReleaseSuccesses,
                auto_quarantine_max_nodes: runtime.autoQuarantineMaxNodes,
                auto_drain_enabled: runtime.autoDrainEnabled,
                auto_drain_failures: runtime.autoDrainFailures,
                auto_drain_release_successes: runtime.autoDrainReleaseSuccesses,
                auto_drain_load_threshold: runtime.autoDrainLoadThreshold,
                auto_drain_score_penalty: runtime.autoDrainScorePenalty,
                sticky_enabled: runtime.stickyEnabled,
                sticky_mode: runtime.stickyMode,
                sticky_new_connections_only: runtime.stickyNewConnectionsOnly,
                sticky_ttl_sec: runtime.stickyTtlSec,
                sticky_max_entries: runtime.stickyMaxEntries,
                probe_interval: runtime.probeInterval,
                probe_sampling: runtime.probeSampling,
                probe_timeout: runtime.probeTimeout,
                probe_connectivity_url: runtime.probeConnectivityUrl,
                probe_http_method: runtime.probeHttpMethod,
                fastest_probe_url: runtime.fastestProbeUrl,
                protection_enabled: runtime.protectionEnabled,
                protection_failures: runtime.protectionFailures,
                protection_release_successes: runtime.protectionReleaseSuccesses,
                protection_isolation_ttl_sec: runtime.protectionIsolationTtlSec,
                protection_latency_threshold_ms: runtime.protectionLatencyThresholdMs,
                protection_min_available_nodes: runtime.protectionMinAvailableNodes,
                emergency_fallback_enabled: runtime.emergencyFallbackEnabled,
                emergency_fallback_max_nodes: runtime.emergencyFallbackMaxNodes,
                balancer_load_weight: runtime.balancerLoadWeight,
                balancer_latency_weight: runtime.balancerLatencyWeight,
                balancer_max_latency_ms: runtime.balancerMaxLatencyMs,
                balancer_smoothing_alpha: runtime.balancerSmoothingAlpha,
                balancer_hysteresis_delta: runtime.balancerHysteresisDelta,
                persisted: mutationResult.persisted,
                persist_error: mutationResult.error,
            }));
            return;
        } catch (err) {
            logger.error('admin_groups_update_failed', { request_id: requestId, error: err.message });
            const code = err.message === 'Invalid JSON body' ? 400 : 422;
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', request_id: requestId, message: err.message }));
            return;
        }
    }

    if (pathname === '/ready') {
        const healthyWindowMs = READY_SUCCESS_WINDOW_SEC * 1000;
        const hasRecentUpstream = lastUpstreamSuccessAt > 0 && (Date.now() - lastUpstreamSuccessAt) <= healthyWindowMs;
        const hasCache = subscriptionCache.hasFreshAny();
        const ready = hasRecentUpstream || hasCache;
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: ready ? 'ready' : 'not_ready',
            request_id: requestId,
        }));
        return;
    }

    const adminDebugTokenMatch = pathname.match(/^\/admin\/debug\/token\/([a-zA-Z0-9_-]+)$/);
    const debugTokenValue = adminDebugTokenMatch?.[1] || null;

    if (pathname === '/admin/node-stats') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        if (req.method !== 'GET') {
            sendMethodNotAllowed(res, requestId, ['GET']);
            return;
        }
        const quarantineSet = buildQuarantineSet();
        const protectionManager = ensureNodeProtectionManager();
        const enriched = Object.fromEntries(
            Object.entries(nodeStatsCache).map(([name, stats]) => [
                name,
                {
                    ...stats,
                    quarantined: isNodeQuarantined(name, quarantineSet, stats?.sourceNode),
                    protection: protectionManager.get(stats?.sourceNode || name),
                },
            ]),
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(enriched, null, 2));
        return;
    }

    if (pathname === '/admin/attack-mode') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }

        if (req.method === 'GET') {
            await expireProtectionNodes();
            const manager = ensureNodeProtectionManager();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                request_id: requestId,
                protection_enabled: getRuntimeConfig().protectionEnabled,
                summary: manager.summary(),
                nodes: manager.list({ protectedOnly: true }),
            }));
            return;
        }

        if (req.method !== 'POST') {
            sendMethodNotAllowed(res, requestId, ['GET', 'POST']);
            return;
        }

        try {
            const payload = await readJsonBody(req);
            const nodeName = typeof payload.node === 'string' ? payload.node.trim() : '';
            const reason = typeof payload.reason === 'string' ? payload.reason.trim() : 'manual_ddos';
            const ttlSec = Number.isInteger(payload.ttl_sec)
                ? payload.ttl_sec
                : getRuntimeConfig().protectionIsolationTtlSec;
            if (!nodeName || nodeName.length > 128) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', code: 'INVALID_NODE', request_id: requestId }));
                return;
            }
            if (!reason || reason.length > 256 || ttlSec < 1 || ttlSec > 604800) {
                res.writeHead(422, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', code: 'INVALID_ATTACK_MODE_OPTIONS', request_id: requestId }));
                return;
            }
            if (payload.disconnect === true) {
                res.writeHead(422, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', code: 'REMOTE_DISCONNECT_NOT_CONFIGURED', request_id: requestId }));
                return;
            }

            const manager = ensureNodeProtectionManager();
            const result = manager.isolateManual(nodeName, {
                reason,
                source: 'admin',
                ttlSec,
            });
            const persisted = await syncProtectionTransitions(manager.drainEvents(), requestId);
            res.writeHead(persisted.persisted ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: persisted.persisted ? 'ok' : 'error',
                code: persisted.persisted ? undefined : 'CONFIG_PERSIST_FAILED',
                request_id: requestId,
                node: result.node,
                persisted: persisted.persisted,
                persist_error: persisted.error || null,
            }));
            return;
        } catch (err) {
            const code = err.message === 'Invalid JSON body' ? 400 : 422;
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', request_id: requestId, message: err.message }));
            return;
        }
    }

    const adminAttackDeleteMatch = pathname.match(/^\/admin\/attack-mode\/(.+)$/);
    if (adminAttackDeleteMatch) {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        if (req.method !== 'DELETE') {
            sendMethodNotAllowed(res, requestId, ['DELETE']);
            return;
        }

        let nodeName = '';
        try {
            nodeName = decodeURIComponent(adminAttackDeleteMatch[1] || '').trim();
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'INVALID_PATH_ENCODING', request_id: requestId }));
            return;
        }
        if (!nodeName || nodeName.length > 128) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'INVALID_NODE', request_id: requestId }));
            return;
        }

        const manager = ensureNodeProtectionManager();
        const result = manager.release(nodeName, { reason: 'manual_release', source: 'admin' });
        const persisted = await syncProtectionTransitions(manager.drainEvents(), requestId);
        res.writeHead(persisted.persisted ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: persisted.persisted ? 'ok' : 'error',
            code: persisted.persisted ? undefined : 'CONFIG_PERSIST_FAILED',
            request_id: requestId,
            released: result.released,
            node: result.node,
            persisted: persisted.persisted,
            persist_error: persisted.error || null,
        }));
        return;
    }

    if (pathname === '/admin/quarantine') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }

        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                request_id: requestId,
                quarantine_nodes: QUARANTINE_NODES,
                auto_quarantine_nodes: AUTO_QUARANTINE_NODES,
                quarantine_count: QUARANTINE_NODES.length,
            }));
            return;
        }

        if (req.method !== 'POST') {
            sendMethodNotAllowed(res, requestId, ['GET', 'POST']);
            return;
        }

        try {
            const payload = await readJsonBody(req);
            const nodeRaw = (payload.node || '').toString().trim();
            if (!nodeRaw) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', code: 'NODE_REQUIRED', request_id: requestId }));
                return;
            }
            const result = await upsertQuarantineNode(nodeRaw, requestId);
            if (!result.persisted) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    code: 'CONFIG_PERSIST_FAILED',
                    request_id: requestId,
                    message: result.error,
                }));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                request_id: requestId,
                quarantine_nodes: QUARANTINE_NODES,
                auto_quarantine_nodes: AUTO_QUARANTINE_NODES,
                quarantine_count: QUARANTINE_NODES.length,
                persisted: result.persisted,
                persist_error: result.error,
            }));
            return;
        } catch (err) {
            const code = err.message === 'Invalid JSON body' ? 400 : 422;
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', request_id: requestId, message: err.message }));
            return;
        }
    }

    const adminQuarantineDeleteMatch = pathname.match(/^\/admin\/quarantine\/(.+)$/);
    if (adminQuarantineDeleteMatch) {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        if (req.method !== 'DELETE') {
            sendMethodNotAllowed(res, requestId, ['DELETE']);
            return;
        }

        let nodeRaw = '';
        try {
            nodeRaw = decodeURIComponent(adminQuarantineDeleteMatch[1] || '').trim();
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'INVALID_PATH_ENCODING', request_id: requestId }));
            return;
        }
        const normalized = normalizeNodeName(nodeRaw);
        if (!normalized) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'NODE_REQUIRED', request_id: requestId }));
            return;
        }

        const result = await removeQuarantineNode(nodeRaw, requestId);
        if (!result.persisted) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'error',
                code: 'CONFIG_PERSIST_FAILED',
                request_id: requestId,
                message: result.error,
            }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            request_id: requestId,
            quarantine_nodes: QUARANTINE_NODES,
            auto_quarantine_nodes: AUTO_QUARANTINE_NODES,
            quarantine_count: QUARANTINE_NODES.length,
            persisted: result.persisted,
            persist_error: result.error,
        }));
        return;
    }

    if (pathname === '/admin/refresh-groups') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        if (req.method !== 'POST') {
            sendMethodNotAllowed(res, requestId, ['POST']);
            return;
        }
        if (!API_TOKEN) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'REFRESH_GROUPS_FAILED', request_id: requestId, message: 'API token is missing' }));
            return;
        }
        const refreshed = await refreshGroups({ persist: true, requestId });
        if (!refreshed.ok) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'REFRESH_GROUPS_FAILED', request_id: requestId, message: refreshed.error }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', groups: GROUPS }));
        return;
    }

    if (pathname === '/admin/refresh-stats') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        if (req.method !== 'POST') {
            sendMethodNotAllowed(res, requestId, ['POST']);
            return;
        }
        if (!API_TOKEN) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'REFRESH_STATS_FAILED', request_id: requestId, message: 'API token is missing' }));
            return;
        }
        const refreshed = await fetchNodeStats();
        if (!refreshed.ok) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', code: 'REFRESH_STATS_FAILED', request_id: requestId, message: refreshed.error }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', nodes: nodeStatsCache }));
        return;
    }

    if (pathname === '/admin/debug/stats') {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        if (req.method !== 'GET') {
            sendMethodNotAllowed(res, requestId, ['GET']);
            return;
        }
        const runtime = getRuntimeConfig();
        const currentStickyStore = ensureStickyStore();
        const currentProtectionManager = ensureNodeProtectionManager();
        const cb = circuitBreaker.status();
        const nodeStatsAgeMs = getNodeStatsAgeMs();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            request_id: requestId,
            profile_mode: PROFILE.name,
            strategy: STRATEGY,
            runtime_stats: runtimeStats,
            circuit_breaker: cb,
            groups: Object.keys(GROUPS),
            last_upstream_success_at: toIsoTimestamp(lastUpstreamSuccessAt),
            last_upstream_error: lastUpstreamError,
            last_node_stats_refresh_at: toIsoTimestamp(lastNodeStatsRefreshAt),
            last_node_stats_error: lastNodeStatsError,
            node_stats_fresh: isNodeStatsFresh(),
            node_stats_age_sec: nodeStatsAgeMs === null ? null : Math.round(nodeStatsAgeMs / 1000),
            node_stats_stale_sec: NODE_STATS_STALE_SEC,
            cached_nodes: Object.keys(nodeStatsCache).length,
            subscription_cache: {
                entries: subscriptionCache.size(),
                bytes: subscriptionCache.bytes(),
                max_bytes: CACHE_MAX_BYTES,
            },
            negative_cache: {
                entries: negativeSubscriptionCache.size(),
                bytes: negativeSubscriptionCache.bytes(),
            },
            active_upstream_fetches: activeUpstreamFetches,
            max_upstream_concurrency: MAX_UPSTREAM_CONCURRENCY,
            ip_limiter_size: rateLimiter.size(),
            admin_limiter_size: adminRateLimiter.size(),
            token_limiter_size: tokenRateLimiter.size(),
            quarantine_nodes: QUARANTINE_NODES,
            auto_quarantine_nodes: AUTO_QUARANTINE_NODES,
            quarantine_count: QUARANTINE_NODES.length,
            sticky_enabled: runtime.stickyEnabled,
            sticky: currentStickyStore.summary(),
            protection_enabled: runtime.protectionEnabled,
            protection: currentProtectionManager.summary(),
            protected_nodes: currentProtectionManager.list({ protectedOnly: true }),
        }));
        return;
    }

    if (debugTokenValue) {
        if (!enforceAdminAccess(req, res, requestId, clientIp, pathname)) {
            return;
        }
        if (req.method !== 'GET') {
            sendMethodNotAllowed(res, requestId, ['GET']);
            return;
        }
        const debugToken = debugTokenValue;
        const debugTarget = SUB_PAGE_URL
            ? `${SUB_PAGE_URL}/${debugToken}`
            : `${REMNAWAVE_URL}${REMNAWAVE_SUB_PATH}/${debugToken}`;
        const fallback = getCachedFallback(buildSubscriptionCacheKey(debugToken, { 'user-agent': 'Happ/1.0' }));
        let upstreamType = 'unavailable';
        let upstreamBytes = 0;
        let upstreamStatus = null;
        let upstreamError = null;

        try {
            const upstream = await fetchUrl(debugTarget, {});
            upstreamStatus = upstream.status;
            upstreamBytes = upstream.body.length;
            const classified = classifyUpstreamPayload(upstream.body);
            upstreamType = classified.type;
        } catch (err) {
            upstreamError = err.message;
        }

        const runtime = getRuntimeConfig();
        const currentStickyStore = ensureStickyStore();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            request_id: requestId,
            token: redactTokenPath(`/${debugToken}`).slice(1),
            profile_mode: PROFILE.name,
            upstream: {
                status: upstreamStatus,
                bytes: upstreamBytes,
                type: upstreamType,
                error: upstreamError,
            },
            cache: {
                has_fallback: Boolean(fallback),
                fallback_kind: fallback ? fallback.kind : null,
            },
            settings: {
                cache_ttl_sec: CACHE_TTL_SEC,
                cache_stale_if_error_sec: CACHE_STALE_IF_ERROR_SEC,
                cache_max_entries: CACHE_MAX_ENTRIES,
                rate_limit_per_minute: RATE_LIMIT_PER_MINUTE,
                rate_limit_burst_10s: RATE_LIMIT_BURST_10S,
                token_rate_limit_per_minute: TOKEN_RATE_LIMIT_PER_MINUTE,
                token_rate_limit_burst_10s: TOKEN_RATE_LIMIT_BURST_10S,
            },
            circuit_breaker: circuitBreaker.status(),
            sticky: {
                enabled: runtime.stickyEnabled,
                assigned_nodes: runtime.stickyEnabled
                    ? Object.fromEntries([
                        ['fastest', currentStickyStore.get(buildStickyTokenKey(debugToken, 'fastest'))?.nodeName || null],
                        ...Object.keys(GROUPS).map((groupName) => [
                            groupName,
                            currentStickyStore.get(buildStickyTokenKey(debugToken, `group:${groupName}`))?.nodeName || null,
                        ]),
                    ])
                    : {},
            },
        }));
        return;
    }

    const match = pathname.match(/^(?:\/sub)?\/([a-zA-Z0-9_-]+)$/);
    if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
    }

    const token = match[1];
    const targetUrl = SUB_PAGE_URL
        ? `${SUB_PAGE_URL}/${token}`
        : `${REMNAWAVE_URL}${REMNAWAVE_SUB_PATH}/${token}`;

    applyNoStoreHeaders(res);
    if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' });
        res.end(JSON.stringify({ status: 'error', code: 'METHOD_NOT_ALLOWED', request_id: requestId }));
        return;
    }

    const forwardHeaders = buildForwardHeaders(req, clientIp);
    const cacheKey = buildSubscriptionCacheKey(token, forwardHeaders);
    const cacheGeneration = subscriptionCacheGeneration;
    const safePath = redactTokenPath(pathname);
    runtimeStats.requests_total += 1;
    const guardDecision = requestGuard.evaluate(clientIp, token);
    if (!guardDecision.ok) {
        if (guardDecision.code === 'RATE_LIMITED') {
            logger.warn('rate_limited', { request_id: requestId, ip: clientIp, path: safePath });
        } else if (guardDecision.code === 'TOKEN_RATE_LIMITED') {
            logger.warn('token_rate_limited', { request_id: requestId, path: safePath });
        }

        if (guardDecision.allowFallback) {
            const fallback = getCachedFallback(cacheKey);
            if (fallback) {
                runtimeStats.cache_fallback_total += 1;
                if (fallback.kind === 'stale') runtimeStats.cache_fallback_stale_total += 1;
                logger.warn('cache_fallback_circuit_open', { request_id: requestId, cache_kind: fallback.kind });
                res.writeHead(200, forwardResponseHeaders(fallback.item.headers, 'application/json; charset=utf-8'));
                res.end(fallback.item.body);
                return;
            }
        }

        res.writeHead(guardDecision.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', code: guardDecision.code, request_id: requestId }));
        return;
    }
    logger.info('request_start', { request_id: requestId, method: req.method, path: safePath, ip: clientIp });

    const cachedSubscription = subscriptionCache.get(cacheKey);
    if (cachedSubscription) {
        runtimeStats.cache_hits_total += 1;
        logger.info('cache_hit', { request_id: requestId, token: redactTokenPath(`/${token}`).slice(1) });
        res.writeHead(200, forwardResponseHeaders(cachedSubscription.headers, 'application/json; charset=utf-8'));
        res.end(cachedSubscription.body);
        return;
    }


    const negativeCached = getNegativeCachedResponse(cacheKey);
    if (negativeCached) {
        runtimeStats.negative_cache_hits_total += 1;
        logger.info('negative_cache_hit', { request_id: requestId, token: redactTokenPath(`/${token}`).slice(1) });
        res.writeHead(
            negativeCached.status,
            forwardResponseHeaders(negativeCached.headers || {}, 'text/plain; charset=utf-8')
        );
        res.end(negativeCached.body || 'Not Found');
        return;
    }

    try {
        // Пробрасываем ВСЕ заголовки от клиента, кроме тех что ломают проксирование
        // Дефолтный User-Agent если клиент не прислал
        // Проксирование через subscription page — подставляем правильные заголовки
        const clientMeta = sanitizeClientMetadata(req);
        logger.info('request_meta', {
            request_id: requestId,
            hwid: clientMeta.hwid,
            device: clientMeta.device,
            os: clientMeta.os,
        });

        const upstream = await fetchUpstreamSingleFlight(cacheKey, token, targetUrl, forwardHeaders, requestId);
        logger.info('upstream_response', {
            request_id: requestId,
            status: upstream.status,
            bytes: upstream.body.length,
        });

        if (upstream.status !== 200) {
            if (upstream.status === 404 || upstream.status === 410) {
                setNegativeCachedResponse(cacheKey, upstream);
            }
            if (isServiceFailureStatus(upstream.status)) {
                lastUpstreamError = `upstream_status_${upstream.status}`;
                circuitBreaker.recordFailure();
            }

            if (canFallbackForStatus(upstream.status)) {
                const fallback = getCachedFallback(cacheKey);
                if (fallback) {
                    runtimeStats.cache_fallback_total += 1;
                    if (fallback.kind === 'stale') runtimeStats.cache_fallback_stale_total += 1;
                    logger.warn('cache_fallback_by_status', { request_id: requestId, status: upstream.status, cache_kind: fallback.kind });
                    res.writeHead(200, forwardResponseHeaders(fallback.item.headers, 'application/json; charset=utf-8'));
                    res.end(fallback.item.body);
                    return;
                }
            }
            res.writeHead(upstream.status, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'text/plain'));
            res.end(upstream.body);
            return;
        }

        const classified = classifyUpstreamPayload(upstream.body);
        if (classified.type === 'non_json') {
            runtimeStats.upstream_non_json_total += 1;
            circuitBreaker.recordSuccess();
            lastUpstreamSuccessAt = Date.now();
            lastUpstreamError = null;
            logger.info('upstream_non_json_passthrough', { request_id: requestId });
            res.writeHead(200, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'text/plain'));
            res.end(upstream.body);
            return;
        }

        let configArray = classified.parsed;

        if (configArray.length === 0) {
            lastUpstreamSuccessAt = Date.now();
            lastUpstreamError = null;
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        const baseConfig = configArray[0];

        // Детектируем фейковые конфиги — когда Remnawave возвращает сообщение об ошибке
        // (лимит устройств, истекла подписка и т.д.) вместо реальных серверов.
        // Признак: все прокси-outbound'ы имеют адрес 0.0.0.0 и порт 1.
        if (classified.type === 'fake_config') {
            runtimeStats.fake_config_passthrough_total += 1;
            circuitBreaker.recordSuccess();
            lastUpstreamSuccessAt = Date.now();
            lastUpstreamError = null;
            logger.info('fake_config_passthrough', { request_id: requestId });
            res.writeHead(200, forwardResponseHeaders(upstream.headers, upstream.headers['content-type'] || 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        let allOutbounds = collectAllProxyOutbounds(configArray);
        logger.info('outbounds_collected', { request_id: requestId, count: allOutbounds.length });

        if (allOutbounds.length === 0) {
            res.writeHead(200, forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8'));
            res.end(upstream.body);
            return;
        }

        // ─── Фильтрация и сортировка по нагрузке ───
        const nodeStatsFresh = isNodeStatsFresh();
        if (NODE_STATS_ENABLED && nodeStatsFresh && Object.keys(nodeStatsCache).length > 0) {
            const before = allOutbounds.length;
            const runtime = getRuntimeConfig();
            const excludedGroupSet = buildGroupNameSet(NODE_STATS_EXCLUDE_GROUPS);
            const statsEligible = [];
            const statsExcluded = [];
            for (const outbound of allOutbounds) {
                const groupName = matchGroup(GROUPS, outbound.tag);
                if (groupName && excludedGroupSet.has(normalizeNodeName(groupName))) {
                    statsExcluded.push(outbound);
                } else {
                    statsEligible.push(outbound);
                }
            }

            const sortedEligible = filterAndSortByLoad(statsEligible, nodeStatsCache, {
                drainSet: autoDrainNodes,
                rankState: balancerRankState,
                keepOverloadedWhenDrained: true,
                drainPenalty: runtime.autoDrainScorePenalty,
                loadWeight: runtime.balancerLoadWeight,
                latencyWeight: runtime.balancerLatencyWeight,
                maxLatencyMs: runtime.balancerMaxLatencyMs,
                smoothingAlpha: runtime.balancerSmoothingAlpha,
                hysteresisDelta: runtime.balancerHysteresisDelta,
                strategy: STRATEGY,
            });
            allOutbounds = [...sortedEligible, ...statsExcluded];
            const after = allOutbounds.length;
            if (before !== after) {
                logger.info('outbounds_filtered_by_load', { request_id: requestId, before, after });
            }
        }

        const quarantineSet = buildQuarantineSet();
        if (quarantineSet.size > 0) {
            const before = allOutbounds.length;
            allOutbounds = allOutbounds.filter((ob) => {
                const stats = nodeStatsFresh ? getNodeStats(nodeStatsCache, ob) : null;
                return !isNodeQuarantined(ob.tag, quarantineSet, stats?.sourceNode);
            });
            const removed = before - allOutbounds.length;
            if (removed > 0) {
                runtimeStats.quarantine_filtered_total += removed;
                logger.info('outbounds_filtered_by_quarantine', {
                    request_id: requestId,
                    before,
                    after: allOutbounds.length,
                    quarantine_count: QUARANTINE_NODES.length,
                });
            }
        }

        const protectionSet = buildProtectionSet();
        if (protectionSet.size > 0) {
            const before = allOutbounds.length;
            allOutbounds = allOutbounds.filter((ob) => {
                const stats = nodeStatsFresh ? getNodeStats(nodeStatsCache, ob) : null;
                return !isNodeQuarantined(ob.tag, protectionSet, stats?.sourceNode);
            });
            const removed = before - allOutbounds.length;
            if (removed > 0) {
                runtimeStats.protection_filtered_total += removed;
                logger.warn('outbounds_filtered_by_protection', {
                    request_id: requestId,
                    before,
                    after: allOutbounds.length,
                    protected_count: protectionSet.size,
                });
            }
        }

        const beforeHiddenFilter = allOutbounds.length;
        allOutbounds = filterHiddenOutbounds(allOutbounds, GROUPS, HIDDEN_GROUPS, HIDDEN_NODES);
        const hiddenRemoved = beforeHiddenFilter - allOutbounds.length;
        if (hiddenRemoved > 0) {
            logger.info('outbounds_hidden_by_config', {
                request_id: requestId,
                before: beforeHiddenFilter,
                after: allOutbounds.length,
                hidden_groups: HIDDEN_GROUPS,
                hidden_nodes_count: HIDDEN_NODES.length,
            });
        }

        if (allOutbounds.length === 0) {
            runtimeStats.all_nodes_unavailable_total += 1;
            logger.error('all_outbounds_unavailable', {
                request_id: requestId,
                quarantine_count: QUARANTINE_NODES.length,
                protection_count: protectionSet.size,
            });
            res.writeHead(503, {
                'Content-Type': 'application/json; charset=utf-8',
                'Retry-After': '30',
            });
            res.end(JSON.stringify({
                status: 'error',
                code: 'NO_HEALTHY_NODES',
                request_id: requestId,
            }));
            return;
        }

        // ─── Группируем ───
        const grouped = {};
        const ungrouped = [];
        const configuredGroupOrder = Object.keys(GROUPS);

        // Preserve explicit admin order even if some groups are empty.
        for (const groupName of configuredGroupOrder) {
            grouped[groupName] = [];
        }

        for (const ob of allOutbounds) {
            const group = matchGroup(GROUPS, ob.tag);
            if (group) {
                if (!grouped[group]) grouped[group] = [];
                grouped[group].push(ob);
            } else {
                ungrouped.push(ob);
            }
        }

        if (ungrouped.length > 0) {
            const firstGroup = configuredGroupOrder[0] || Object.keys(grouped)[0];
            if (firstGroup) {
                grouped[firstGroup].push(...ungrouped);
                logger.info('ungrouped_appended', { request_id: requestId, count: ungrouped.length, group: firstGroup });
            } else {
                grouped['🌐 Other'] = ungrouped;
            }
        }

        // Внутригрупповой порядок уже унаследован из allOutbounds после score-based сортировки.

        // ─── Конфиги ───
        const resultConfigs = [];

        // ⚡ Fastest
        const fastestEnabled = config.fastest_group !== false;
        const excludedTags = new Set();
        const fallbackTags = new Set();
        const excludedGroupSet = buildGroupNameSet(FASTEST_EXCLUDE_GROUPS);
        const fallbackGroupSet = buildGroupNameSet(FASTEST_FALLBACK_GROUPS);
        for (const [groupName, outbounds] of Object.entries(grouped)) {
            if (excludedGroupSet.has(normalizeNodeName(groupName))) {
                for (const outbound of outbounds) excludedTags.add(outbound.tag);
            }
            if (fallbackGroupSet.has(normalizeNodeName(groupName))) {
                for (const outbound of outbounds) fallbackTags.add(outbound.tag);
            }
        }
        const fastestOutbounds = allOutbounds.filter((outbound) => !excludedTags.has(outbound.tag) && !fallbackTags.has(outbound.tag));
        const fastestFallbackOutbounds = allOutbounds.filter((outbound) => fallbackTags.has(outbound.tag));
        const fastestSourceOutbounds = fastestOutbounds.length > 0 ? fastestOutbounds : fastestFallbackOutbounds;

        if (fastestEnabled && fastestSourceOutbounds.length > 0) {
            const runtime = getRuntimeConfig();
            const currentStickyStore = ensureStickyStore();
            let selectedFastestOutbounds = fastestSourceOutbounds;
            if (runtime.stickyEnabled && fastestSourceOutbounds.length > 1) {
                const stickySelection = applyStickySelection(token, 'fastest', fastestSourceOutbounds, runtime, currentStickyStore);
                if (stickySelection.selected) {
                    selectedFastestOutbounds = stickySelection.selectedOutbounds;
                    if (stickySelection.changed) {
                        runtimeStats.sticky_assignments_total += 1;
                        logger.info('sticky_assigned', {
                            request_id: requestId,
                            token: redactTokenPath(`/${token}`).slice(1),
                            scope: 'fastest',
                            node: stickySelection.selected.tag,
                            sticky_mode: runtime.stickyMode,
                        });
                    } else {
                        runtimeStats.sticky_hits_total += 1;
                    }
                } else {
                    runtimeStats.sticky_misses_total += 1;
                }
            }
            const fastestGroupName = (config.fastest_group_name || DEFAULT_FASTEST_GROUP_NAME);
            const fastestConfig = buildGroupConfig(baseConfig, fastestGroupName, selectedFastestOutbounds, {
                fallbackOutbounds: fastestOutbounds.length > 0 ? fastestFallbackOutbounds : [],
                probeUrl: runtime.fastestProbeUrl,
                probeInterval: runtime.probeInterval,
                probeSampling: runtime.probeSampling,
                probeTimeout: runtime.probeTimeout,
                probeConnectivity: runtime.probeConnectivityUrl,
                probeHttpMethod: runtime.probeHttpMethod,
                strategy: STRATEGY,
                groupDescription: (GROUP_DESCRIPTIONS && GROUP_DESCRIPTIONS[fastestGroupName]) || '',
            });
            resultConfigs.push(fastestConfig);
            logger.info('group_fastest', {
                request_id: requestId,
                count: selectedFastestOutbounds.length,
                source_count: fastestSourceOutbounds.length,
                sticky_enabled: runtime.stickyEnabled,
                sticky_mode: runtime.stickyMode,
                excluded_groups: FASTEST_EXCLUDE_GROUPS,
                fallback_groups: FASTEST_FALLBACK_GROUPS,
            });
        }

        // Группы по странам
        const publishedGroupEntries = computePublishedGroupEntries(
            grouped,
            configuredGroupOrder,
            EXPAND_GROUPS_TO_NODES
        );
        for (const entry of publishedGroupEntries) {
            const runtime = getRuntimeConfig();
            const currentStickyStore = ensureStickyStore();
            const groupName = entry.groupName;
            const configName = entry.configName;
            const groupOutbounds = entry.outbounds || [];
            if (groupOutbounds.length === 0) continue;

            let selectedGroupOutbounds = groupOutbounds;
            if (entry.kind !== 'node' && runtime.stickyEnabled && groupOutbounds.length > 1) {
                const stickySelection = applyStickySelection(
                    token,
                    `group:${groupName}`,
                    groupOutbounds,
                    runtime,
                    currentStickyStore
                );
                if (stickySelection.selected) {
                    selectedGroupOutbounds = stickySelection.selectedOutbounds;
                    if (stickySelection.changed) {
                        runtimeStats.sticky_assignments_total += 1;
                        logger.info('sticky_assigned', {
                            request_id: requestId,
                            token: redactTokenPath(`/${token}`).slice(1),
                            scope: `group:${groupName}`,
                            node: stickySelection.selected.tag,
                            sticky_mode: runtime.stickyMode,
                        });
                    } else {
                        runtimeStats.sticky_hits_total += 1;
                    }
                } else {
                    runtimeStats.sticky_misses_total += 1;
                }
            }

            const selectedTagSet = new Set(selectedGroupOutbounds.map((outbound) => outbound.tag));
            const emergencyFallbackOutbounds = runtime.emergencyFallbackEnabled && entry.kind !== 'node'
                ? allOutbounds
                    .filter((outbound) => !selectedTagSet.has(outbound.tag))
                    .slice(0, runtime.emergencyFallbackMaxNodes)
                : [];
            const groupConfig = buildGroupConfig(baseConfig, configName, selectedGroupOutbounds, {
                fallbackOutbounds: emergencyFallbackOutbounds,
                probeUrl: PROBE_URL,
                probeInterval: runtime.probeInterval,
                probeSampling: runtime.probeSampling,
                probeTimeout: runtime.probeTimeout,
                probeConnectivity: runtime.probeConnectivityUrl,
                probeHttpMethod: runtime.probeHttpMethod,
                strategy: STRATEGY,
                groupDescription: (GROUP_DESCRIPTIONS && (GROUP_DESCRIPTIONS[configName] || GROUP_DESCRIPTIONS[groupName])) || '',
            });
            resultConfigs.push(groupConfig);

            // Логируем порядок серверов если есть стата
            if (NODE_STATS_ENABLED && nodeStatsFresh && Object.keys(nodeStatsCache).length > 0) {
                const order = selectedGroupOutbounds.map(ob => {
                    const s = getNodeStats(nodeStatsCache, ob);
                    return s ? `${ob.tag}(${s.usersOnline}u/${s.totalRamGb}G/${s.cpuCount}C)` : ob.tag;
                }).join(', ');
                logger.info('group_built', {
                    request_id: requestId,
                    group: groupName,
                    published_as: entry.kind,
                    config_name: configName,
                    count: selectedGroupOutbounds.length,
                    order,
                    sticky_enabled: runtime.stickyEnabled,
                    sticky_mode: runtime.stickyMode,
                });
            } else {
                logger.info('group_built', {
                    request_id: requestId,
                    group: groupName,
                    published_as: entry.kind,
                    config_name: configName,
                    count: selectedGroupOutbounds.length,
                    sticky_enabled: runtime.stickyEnabled,
                    sticky_mode: runtime.stickyMode,
                });
            }
        }

        logger.info('response_built', { request_id: requestId, groups: resultConfigs.length, servers: allOutbounds.length });

        const responseBody = JSON.stringify(resultConfigs, null, 2);
        circuitBreaker.recordSuccess();
        lastUpstreamSuccessAt = Date.now();
        lastUpstreamError = null;
        if (cacheGeneration === subscriptionCacheGeneration) {
            subscriptionCache.set(cacheKey, responseBody, sanitizeHeadersForCache(upstream.headers));
        } else {
            logger.info('subscription_cache_store_skipped_after_invalidation', {
                request_id: requestId,
                cache_generation: cacheGeneration,
                current_generation: subscriptionCacheGeneration,
            });
        }

        const responseHeaders = forwardResponseHeaders(upstream.headers, 'application/json; charset=utf-8');

        res.writeHead(200, responseHeaders);
        res.end(responseBody);

    } catch (err) {
        runtimeStats.request_failures += 1;
        lastUpstreamError = err.message;
        if (err.code !== 'EUPSTREAMBUSY') {
            circuitBreaker.recordFailure();
        }
        logger.error('request_failed', { request_id: requestId, message: err.message });
        const fallback = getCachedFallback(cacheKey);
        if (fallback) {
            runtimeStats.cache_fallback_total += 1;
            if (fallback.kind === 'stale') runtimeStats.cache_fallback_stale_total += 1;
            logger.warn('cache_fallback_by_error', { request_id: requestId, cache_kind: fallback.kind });
            res.writeHead(200, forwardResponseHeaders(fallback.item.headers, 'application/json; charset=utf-8'));
            res.end(fallback.item.body);
            return;
        }
        if (!res.headersSent) {
            if (err.code === 'EUPSTREAMBUSY') {
                res.writeHead(503, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Retry-After': '5',
                });
                res.end(JSON.stringify({ status: 'error', code: 'UPSTREAM_BUSY', request_id: requestId }));
                return;
            }
            if (isSocketHangupError(err)) {
                res.writeHead(404, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store',
                });
                res.end('Not Found');
                return;
            }
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Bad Gateway: ' + err.message);
        }
    }
});

// ─── Graceful shutdown ───

server.headersTimeout = 10000;
server.requestTimeout = Math.max(15000, REQUEST_TIMEOUT_MS + 5000);
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 100;
server.maxRequestsPerSocket = 100;
server.on('clientError', (err, socket) => {
    logger.warn('http_client_error', { code: err.code || null, message: err.message });
    if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
});

function shutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;
    clearBackgroundIntervals();

    console.log(`\n[shutdown] ${signal} — завершаем...`);
    const shutdownTimeoutMs = Math.max(15000, REQUEST_TIMEOUT_MS + 5000);
    const forceExitTimer = setTimeout(() => { process.exit(1); }, shutdownTimeoutMs);
    if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();

    server.close(async () => {
        const backgroundWait = await waitForBackgroundTasks(Math.max(5000, REQUEST_TIMEOUT_MS));
        if (backgroundWait.timedOut) {
            logger.warn('background_tasks_shutdown_timeout', { pending: backgroundWait.pending });
        }
        clearTimeout(forceExitTimer);
        console.log('[shutdown] Готово');
        process.exit(0);
    });
    if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Старт ───

async function start() {
    const persistenceWritable = checkConfigPersistenceWritable();
    if (!persistenceWritable.ok) {
        logger.warn('config_persistence_not_writable', {
            config_path: persistenceWritable.path,
            error: persistenceWritable.error,
        });
    }

    const fastestEnabled = config.fastest_group !== false;

    server.listen(PORT, () => {
        const runtime = getRuntimeConfig();
        ensureStickyStore();
        scheduleStartupTasks();
        console.log(`\n🚀 Xray Balancer Middleware — порт ${PORT}`);
        console.log(`📋 Группы: ${Object.entries(GROUPS).map(([k, v]) => `${k} [${v.join(',')}]`).join(' | ')}`);
        const fastestLabel = config.fastest_group_name || DEFAULT_FASTEST_GROUP_NAME;
        console.log(`🏁 Fastest group (${fastestLabel}): ${fastestEnabled ? '✅' : '❌'}`);
        console.log(`🪂 Fastest fallback groups: ${FASTEST_FALLBACK_GROUPS.length > 0 ? FASTEST_FALLBACK_GROUPS.join(', ') : 'none'}`);
        console.log(`🎯 Стратегия: ${formatStrategyForLog()}`);
        console.log(`🧭 Profile: ${PROFILE.name}`);
        console.log(`📡 Probe: groups=${PROBE_URL} fastest=${runtime.fastestProbeUrl} каждые ${runtime.probeInterval}`);
        console.log(`🧷 Sticky: ${runtime.stickyEnabled ? `✅ (${runtime.stickyMode}, ttl=${runtime.stickyTtlSec}s)` : '❌'}`);
        console.log(`📊 Node stats: ${NODE_STATS_ENABLED ? `✅ (каждые ${NODE_STATS_INTERVAL/1000}с, stale>${NODE_STATS_STALE_SEC}с, макс ${MAX_USERS_PER_GB} u/GB, ${MAX_USERS_PER_CPU} u/CPU)` : '❌'}`);
        console.log(`📊 Node stats exclude: ${NODE_STATS_EXCLUDE_GROUPS.length > 0 ? NODE_STATS_EXCLUDE_GROUPS.join(', ') : 'none'}`);
        console.log(`🗃️ Cache: ttl=${CACHE_TTL_SEC}s stale-if-error=${CACHE_STALE_IF_ERROR_SEC}s max_entries=${CACHE_MAX_ENTRIES}`);
        console.log(`🚦 Rate limit: ${RATE_LIMIT_PER_MINUTE}/min, burst=${RATE_LIMIT_BURST_10S}/10s`);
        console.log(`🎟️ Token rate limit: ${TOKEN_RATE_LIMIT_PER_MINUTE}/min, burst=${TOKEN_RATE_LIMIT_BURST_10S}/10s`);
        console.log(`🔐 Admin rate limit: ${ADMIN_RATE_LIMIT_PER_MINUTE}/min, burst=${ADMIN_RATE_LIMIT_BURST_10S}/10s`);
        console.log(`🌐 Trust X-Forwarded-For: ${TRUST_X_FORWARDED_FOR ? '✅' : '❌'}`);
        console.log(
            `🩺 Auto quarantine: ${runtime.autoQuarantineEnabled ? `✅ (fails=${runtime.autoQuarantineFailures}, release=${runtime.autoQuarantineReleaseSuccesses}, max=${runtime.autoQuarantineMaxNodes})` : '❌'}`
        );
        console.log(
            `💧 Auto drain: ${runtime.autoDrainEnabled ? `✅ (fails=${runtime.autoDrainFailures}, release=${runtime.autoDrainReleaseSuccesses}, threshold=${runtime.autoDrainLoadThreshold}, penalty=${runtime.autoDrainScorePenalty})` : '❌'}`
        );
        console.log(
            `🛡️ Node protection: ${runtime.protectionEnabled ? `✅ (fails=${runtime.protectionFailures}, release=${runtime.protectionReleaseSuccesses}, ttl=${runtime.protectionIsolationTtlSec}s, latency>=${runtime.protectionLatencyThresholdMs}ms, reserve=${runtime.protectionMinAvailableNodes})` : '❌'}; isolated=${ATTACK_NODES.length}`
        );
        console.log(
            `🛟 Emergency fallback: ${runtime.emergencyFallbackEnabled ? `✅ (max=${runtime.emergencyFallbackMaxNodes})` : '❌'}`
        );
        console.log(
            `📈 Score model: load_weight=${runtime.balancerLoadWeight} latency_weight=${runtime.balancerLatencyWeight} max_latency=${runtime.balancerMaxLatencyMs}ms alpha=${runtime.balancerSmoothingAlpha} hysteresis=${runtime.balancerHysteresisDelta}`
        );
        console.log(`⏱️ Upstream: timeout=${REQUEST_TIMEOUT_MS}ms redirects=${MAX_REDIRECTS} concurrency=${MAX_UPSTREAM_CONCURRENCY}`);
        console.log(`🧱 Circuit breaker: fails=${CIRCUIT_BREAKER_FAILURES} open=${CIRCUIT_BREAKER_OPEN_SEC}s`);
        console.log(`🚫 Quarantine: ${QUARANTINE_NODES.length} nodes`);
        console.log(`💾 Runtime config: ${CONFIG_RUNTIME_PATH || CONFIG_PATH}`);
        console.log(`🛡️ Admin routes: ${ADMIN_TOKEN ? '🔒 enabled' : '⚠️ disabled (set ADMIN_TOKEN)'}`);
        console.log(`🔐 Panel cookie: ${PANEL_AUTH_COOKIE ? '✅' : '❌ (не нужен)'}`);
        console.log(`📡 Sub page: ${SUB_PAGE_URL || 'не задан'}`);
        console.log(`🔀 Форвард: все заголовки клиента → upstream, все заголовки upstream → клиент`);
        console.log(`\n   Подписка: http://localhost:${PORT}/{token}`);
        console.log(`   Health:   http://localhost:${PORT}/health`);
        console.log(`   Стата:    http://localhost:${PORT}/admin/node-stats (x-admin-token)\n`);
    });
}

start().catch(err => { console.error('Ошибка:', err); process.exit(1); });
