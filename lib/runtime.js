'use strict';

function createTokenCache(ttlSec, maxEntries = 1000, opts = {}) {
    const options = (maxEntries && typeof maxEntries === 'object') ? maxEntries : opts;
    const entryLimit = (maxEntries && typeof maxEntries === 'object')
        ? (Number.isInteger(options.maxEntries) && options.maxEntries >= 0 ? options.maxEntries : 1000)
        : (Number.isInteger(maxEntries) && maxEntries >= 0 ? maxEntries : 1000);
    const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes >= 0
        ? options.maxBytes
        : Infinity;
    const maxItemBytes = Number.isInteger(options.maxItemBytes) && options.maxItemBytes >= 0
        ? options.maxItemBytes
        : Infinity;
    const ttlMs = ttlSec * 1000;
    const map = new Map();
    let totalBytes = 0;

    function valueBytes(value) {
        if (Buffer.isBuffer(value)) return value.length;
        if (typeof value === 'string') return Buffer.byteLength(value);
        let serialized;
        try {
            serialized = JSON.stringify(value);
        } catch {
            serialized = String(value);
        }
        return Buffer.byteLength(serialized === undefined ? String(value) : serialized);
    }

    function itemBytes(body, headers) {
        return valueBytes(body) + valueBytes(headers);
    }

    function deleteEntry(key) {
        const entry = map.get(key);
        if (!entry) return false;
        totalBytes -= entry.bytes;
        map.delete(key);
        return true;
    }

    function touch(key, entry) {
        map.delete(key);
        map.set(key, entry);
    }

    function evictIfNeeded() {
        while (map.size > entryLimit || totalBytes > maxBytes) {
            const oldest = map.keys().next().value;
            deleteEntry(oldest);
        }
    }

    function set(token, body, headers = {}) {
        const bytes = itemBytes(body, headers);
        deleteEntry(token);
        if (bytes > maxItemBytes || bytes > maxBytes || entryLimit <= 0) {
            return;
        }

        const entry = {
            value: {
                body,
                headers,
                updatedAt: Date.now(),
            },
            bytes,
        };
        map.set(token, entry);
        totalBytes += bytes;
        evictIfNeeded();
    }

    function get(token) {
        const entry = map.get(token);
        if (!entry) return null;
        if ((Date.now() - entry.value.updatedAt) > ttlMs) {
            return null;
        }
        touch(token, entry);
        return entry.value;
    }

    function getStale(token, staleSec) {
        const entry = map.get(token);
        if (!entry) return null;
        if ((Date.now() - entry.value.updatedAt) > (staleSec * 1000)) {
            deleteEntry(token);
            return null;
        }
        return entry.value;
    }

    function hasFreshAny() {
        const now = Date.now();
        for (const entry of map.values()) {
            if ((now - entry.value.updatedAt) <= ttlMs) return true;
        }
        return false;
    }

    function clear() {
        const size = map.size;
        map.clear();
        totalBytes = 0;
        return size;
    }

    function size() {
        return map.size;
    }

    function bytes() {
        return totalBytes;
    }

    return { set, get, getStale, hasFreshAny, clear, size, bytes };
}

function createRateLimiter(limitPerMinute, burst10s, opts = {}) {
    const options = (typeof opts === 'number') ? { cleanupIntervalMs: opts } : opts;
    const idleMs = Number.isInteger(options.idleMs) && options.idleMs > 0 ? options.idleMs : 120000;
    const cleanupBatch = Number.isInteger(options.cleanupBatch) && options.cleanupBatch > 0 ? options.cleanupBatch : 200;
    const cleanupIntervalMs = Number.isInteger(options.cleanupIntervalMs) && options.cleanupIntervalMs > 0
        ? options.cleanupIntervalMs
        : 10000;
    const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries >= 0
        ? options.maxEntries
        : Infinity;
    const ipMap = new Map();
    let lastCleanupAt = 0;
    let cleanupCursor = ipMap.entries();

    function nextCleanupEntry() {
        let next = cleanupCursor.next();
        if (next.done) {
            cleanupCursor = ipMap.entries();
            next = cleanupCursor.next();
        }
        return next;
    }

    function cleanup(now) {
        if ((now - lastCleanupAt) < cleanupIntervalMs) return;
        lastCleanupAt = now;
        let scanned = 0;
        while (scanned < cleanupBatch && ipMap.size > 0) {
            const next = nextCleanupEntry();
            if (next.done) break;
            const [ip, entry] = next.value;
            if ((now - entry.lastSeen) > idleMs) {
                ipMap.delete(ip);
            }
            scanned += 1;
        }
    }

    function allow(ip, now = Date.now()) {
        cleanup(now);

        let entry = ipMap.get(ip);
        if (!entry) {
            if (maxEntries <= 0) return false;
            while (ipMap.size >= maxEntries) {
                const oldest = ipMap.keys().next().value;
                ipMap.delete(oldest);
            }
            entry = { minHits: [], burstHits: [], lastSeen: now };
        }
        entry.lastSeen = now;

        entry.minHits = entry.minHits.filter(ts => (now - ts) < 60000);
        entry.burstHits = entry.burstHits.filter(ts => (now - ts) < 10000);

        if (entry.minHits.length >= limitPerMinute || entry.burstHits.length >= burst10s) {
            ipMap.set(ip, entry);
            return false;
        }

        entry.minHits.push(now);
        entry.burstHits.push(now);
        ipMap.set(ip, entry);
        return true;
    }

    function size() {
        return ipMap.size;
    }

    return { allow, size };
}

function createCircuitBreaker(failuresThreshold, openSec) {
    let failures = 0;
    let openUntil = 0;

    function now() {
        return Date.now();
    }

    function allowRequest() {
        return now() >= openUntil;
    }

    function recordSuccess() {
        failures = 0;
        openUntil = 0;
    }

    function recordFailure() {
        failures += 1;
        if (failures >= failuresThreshold) {
            openUntil = now() + (openSec * 1000);
            failures = 0;
        }
    }

    function status() {
        const current = now();
        return {
            open: current < openUntil,
            open_until_ms: openUntil,
            remaining_open_ms: Math.max(0, openUntil - current),
        };
    }

    return {
        allowRequest,
        recordSuccess,
        recordFailure,
        status,
    };
}

function createKeyedRateLimiter(limitPerMinute, burst10s, opts = {}) {
    const options = (typeof opts === 'number') ? { idleMs: opts } : opts;
    const idleMs = Number.isInteger(options.idleMs) && options.idleMs > 0 ? options.idleMs : 120000;
    const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 5000;
    const cleanupBatch = Number.isInteger(options.cleanupBatch) && options.cleanupBatch > 0 ? options.cleanupBatch : 200;
    const cleanupIntervalMs = Number.isInteger(options.cleanupIntervalMs) && options.cleanupIntervalMs > 0
        ? options.cleanupIntervalMs
        : 10000;
    const limiters = new Map();
    let lastCleanupAt = 0;
    let cleanupCursor = limiters.entries();

    function nextCleanupEntry() {
        let next = cleanupCursor.next();
        if (next.done) {
            cleanupCursor = limiters.entries();
            next = cleanupCursor.next();
        }
        return next;
    }

    function cleanup(now) {
        if ((now - lastCleanupAt) < cleanupIntervalMs) return;
        lastCleanupAt = now;
        let scanned = 0;
        while (scanned < cleanupBatch && limiters.size > 0) {
            const next = nextCleanupEntry();
            if (next.done) break;
            const [key, item] = next.value;
            if ((now - item.lastSeen) > idleMs) {
                limiters.delete(key);
            }
            scanned += 1;
        }
    }

    function allow(key, now = Date.now()) {
        cleanup(now);
        let entry = limiters.get(key);
        if (!entry) {
            if (limiters.size >= maxEntries) {
                const oldest = limiters.keys().next().value;
                limiters.delete(oldest);
            }
            entry = { limiter: createRateLimiter(limitPerMinute, burst10s), lastSeen: now };
            limiters.set(key, entry);
        }
        entry.lastSeen = now;
        return entry.limiter.allow(key, now);
    }

    function size() {
        return limiters.size;
    }

    return { allow, size };
}

module.exports = {
    createCircuitBreaker,
    createKeyedRateLimiter,
    createRateLimiter,
    createTokenCache,
};
