'use strict';

function normalizeNodeName(value) {
    return (value || '').toString().trim().toLowerCase();
}

function buildStickyTokenKey(token, scope = 'default') {
    const normalizedToken = (token || '').toString().trim();
    if (!normalizedToken) return '';

    const normalizedScope = (scope || 'default').toString().trim() || 'default';
    return `${normalizedScope}::${normalizedToken}`;
}

function createStickyStore(opts = {}) {
    const ttlMs = (Number.isInteger(opts.ttlSec) && opts.ttlSec > 0 ? opts.ttlSec : 3600) * 1000;
    const maxEntries = Number.isInteger(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : 10000;
    const entries = new Map();

    function touch(token, entry) {
        entries.delete(token);
        entries.set(token, entry);
    }

    function cleanup(now = Date.now()) {
        for (const [token, entry] of entries.entries()) {
            if (entry.expiresAt <= now) {
                entries.delete(token);
            }
        }
    }

    function evictIfNeeded() {
        while (entries.size > maxEntries) {
            const oldest = entries.keys().next().value;
            entries.delete(oldest);
        }
    }

    function get(token, now = Date.now(), opts = {}) {
        if (!token) return null;
        cleanup(now);
        const entry = entries.get(token);
        if (!entry) return null;
        if (entry.expiresAt <= now) {
            entries.delete(token);
            return null;
        }
        if (opts.refreshTtlOnHit === true) {
            entry.expiresAt = now + ttlMs;
        }
        touch(token, entry);
        return {
            token,
            nodeName: entry.nodeName,
            normalizedNode: entry.normalizedNode,
            expiresAt: entry.expiresAt,
        };
    }

    function assign(token, nodeName, now = Date.now()) {
        if (!token || !nodeName) return null;
        cleanup(now);
        const entry = {
            nodeName,
            normalizedNode: normalizeNodeName(nodeName),
            expiresAt: now + ttlMs,
        };
        touch(token, entry);
        evictIfNeeded();
        return get(token, now);
    }

    function release(token) {
        if (!token) return false;
        return entries.delete(token);
    }

    function releaseByNode(nodeName, now = Date.now()) {
        const normalizedNode = normalizeNodeName(nodeName);
        if (!normalizedNode) return 0;
        cleanup(now);

        let released = 0;
        for (const [token, entry] of entries.entries()) {
            if (entry.normalizedNode === normalizedNode) {
                entries.delete(token);
                released += 1;
            }
        }
        return released;
    }

    function choose(token, outbounds, now = Date.now(), opts = {}) {
        cleanup(now);
        if (!token || !Array.isArray(outbounds) || outbounds.length === 0) {
            return { selected: null, sticky: null, changed: false };
        }

        const current = get(token, now, opts);
        if (current) {
            const matched = outbounds.find((outbound) => normalizeNodeName(outbound.tag) === current.normalizedNode);
            if (matched) {
                return { selected: matched, sticky: current, changed: false };
            }
        }

        const selected = outbounds[0] || null;
        if (!selected) {
            if (current) release(token);
            return { selected: null, sticky: null, changed: Boolean(current) };
        }

        const sticky = assign(token, selected.tag, now);
        return { selected, sticky, changed: !current || current.normalizedNode !== sticky.normalizedNode };
    }

    function prefer(token, outbounds, now = Date.now(), opts = {}) {
        const choice = choose(token, outbounds, now, opts);
        if (!choice.selected || !Array.isArray(outbounds) || outbounds.length === 0) {
            return { ...choice, orderedOutbounds: [] };
        }

        const selectedNode = normalizeNodeName(choice.selected.tag);
        const orderedOutbounds = [
            choice.selected,
            ...outbounds.filter((outbound) => normalizeNodeName(outbound.tag) !== selectedNode),
        ];

        return { ...choice, orderedOutbounds };
    }

    function summary(now = Date.now()) {
        cleanup(now);
        return {
            entries: entries.size,
            ttl_sec: Math.round(ttlMs / 1000),
        };
    }

    return {
        assign,
        choose,
        get,
        prefer,
        release,
        releaseByNode,
        summary,
    };
}

module.exports = {
    buildStickyTokenKey,
    createStickyStore,
};
