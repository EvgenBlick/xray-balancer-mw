'use strict';

function normalizeMatchValue(value) {
    return (value || '').toString().trim().toLowerCase();
}

function pushCandidate(candidates, seen, value) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;

    const normalized = normalizeMatchValue(trimmed);
    if (!normalized || seen.has(normalized)) return;

    seen.add(normalized);
    candidates.push(trimmed);
}

function collectOutboundMatchCandidates(outboundOrTag) {
    const candidates = [];
    const seen = new Set();

    if (typeof outboundOrTag === 'string') {
        pushCandidate(candidates, seen, outboundOrTag);
        return candidates;
    }

    if (!outboundOrTag || typeof outboundOrTag !== 'object') {
        return candidates;
    }

    pushCandidate(candidates, seen, outboundOrTag.tag);

    const settings = outboundOrTag.settings || {};
    for (const entry of settings.vnext || []) {
        pushCandidate(candidates, seen, entry?.address);
    }
    for (const entry of settings.servers || []) {
        pushCandidate(candidates, seen, entry?.address);
    }
    pushCandidate(candidates, seen, settings.address);

    const streamSettings = outboundOrTag.streamSettings || {};
    pushCandidate(candidates, seen, streamSettings.realitySettings?.serverName);
    pushCandidate(candidates, seen, streamSettings.tlsSettings?.serverName);
    pushCandidate(candidates, seen, streamSettings.grpcSettings?.authority);

    const wsHost = streamSettings.wsSettings?.headers?.Host;
    if (Array.isArray(wsHost)) {
        for (const value of wsHost) {
            pushCandidate(candidates, seen, value);
        }
    } else {
        pushCandidate(candidates, seen, wsHost);
    }

    return candidates;
}

function matchGroup(groups, outboundTag) {
    const tagLower = outboundTag.toLowerCase();
    let bestGroup = null;
    let bestLen = 0;

    function escapeRegex(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    for (const [groupName, patterns] of Object.entries(groups)) {
        for (const pattern of patterns) {
            const patLower = pattern.toLowerCase();
            if (patLower.length <= 2) {
                const regex = new RegExp(`(?:^|[^a-z])${escapeRegex(patLower)}(?:$|[^a-z])`);
                if (regex.test(tagLower) && patLower.length > bestLen) {
                    bestGroup = groupName;
                    bestLen = patLower.length;
                }
            } else if (tagLower.includes(patLower) && patLower.length > bestLen) {
                bestGroup = groupName;
                bestLen = patLower.length;
            }
        }
    }
    return bestGroup;
}

function filterHiddenOutbounds(outbounds, groups, hiddenGroups = [], hiddenNodes = []) {
    const hiddenGroupSet = new Set(hiddenGroups.map(normalizeMatchValue).filter(Boolean));
    const hiddenNodeSet = new Set(hiddenNodes.map(normalizeMatchValue).filter(Boolean));

    if (hiddenGroupSet.size === 0 && hiddenNodeSet.size === 0) {
        return outbounds;
    }

    return outbounds.filter((outbound) => {
        const tag = typeof outbound?.tag === 'string' ? outbound.tag : '';
        if (hiddenNodeSet.has(normalizeMatchValue(tag))) {
            return false;
        }

        const groupName = matchGroup(groups, tag);
        if (groupName && hiddenGroupSet.has(normalizeMatchValue(groupName))) {
            return false;
        }

        return true;
    });
}

function computePublishedGroupEntries(grouped, configuredGroupOrder = [], expandGroupsToNodes = []) {
    const expandSet = new Set((Array.isArray(expandGroupsToNodes) ? expandGroupsToNodes : [])
        .map(normalizeMatchValue)
        .filter(Boolean));
    const responseGroupOrder = [
        ...configuredGroupOrder,
        ...Object.keys(grouped).filter((name) => !configuredGroupOrder.includes(name)),
    ];
    const entries = [];

    for (const groupName of responseGroupOrder) {
        const groupOutbounds = grouped[groupName] || [];
        if (groupOutbounds.length === 0) continue;

        if (expandSet.has(normalizeMatchValue(groupName))) {
            for (const outbound of groupOutbounds) {
                entries.push({
                    kind: 'node',
                    groupName,
                    configName: outbound.tag,
                    outbounds: [outbound],
                });
            }
            continue;
        }

        entries.push({
            kind: 'group',
            groupName,
            configName: groupName,
            outbounds: groupOutbounds,
        });
    }

    return entries;
}

function isFakeConfig(configArray) {
    const systemProtocols = new Set(['freedom', 'blackhole', 'dns']);
    let proxyCount = 0;
    let fakeCount = 0;

    for (const cfg of configArray) {
        for (const ob of (cfg.outbounds || [])) {
            if (systemProtocols.has(ob.protocol)) continue;
            if (!ob.tag) continue;
            proxyCount++;

            const addr = ob.settings?.vnext?.[0]?.address || ob.settings?.servers?.[0]?.address || '';
            const port = ob.settings?.vnext?.[0]?.port || ob.settings?.servers?.[0]?.port || null;

            if (addr === '0.0.0.0' && port === 1) {
                fakeCount++;
            }
        }
    }

    return proxyCount > 0 && proxyCount === fakeCount;
}

function getNodeStats(nodeStatsCache, outboundOrTag) {
    const candidates = collectOutboundMatchCandidates(outboundOrTag);
    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
        if (nodeStatsCache[candidate]) {
            return nodeStatsCache[candidate];
        }
    }

    const normalizedCandidates = candidates.map(normalizeMatchValue).filter(Boolean);
    let bestExact = null;
    let bestExactLen = 0;
    let bestMatch = null;
    let bestMatchLen = 0;

    for (const [nodeName, stats] of Object.entries(nodeStatsCache)) {
        const nameL = normalizeMatchValue(nodeName);
        if (!nameL) continue;

        if (normalizedCandidates.includes(nameL) && nameL.length > bestExactLen) {
            bestExact = stats;
            bestExactLen = nameL.length;
            continue;
        }

        if (nameL.length < 3) continue;
        if (normalizedCandidates.some((candidate) => candidate.includes(nameL)) && nameL.length > bestMatchLen) {
            bestMatch = stats;
            bestMatchLen = nameL.length;
        }
    }

    return bestExact || bestMatch;
}

function toFiniteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function resolveLatencyMs(stats) {
    if (!stats) return null;
    const latencyCandidates = [
        stats.latency_ms,
        stats.latencyMs,
        stats.latency,
        stats.ping_ms,
        stats.pingMs,
        stats.ping,
        stats.rtt_ms,
        stats.rtt,
    ];
    for (const candidate of latencyCandidates) {
        const num = toFiniteNumber(candidate);
        if (num !== null && num >= 0) return num;
    }
    return null;
}

function normalizeLatency(latencyMs, maxLatencyMs) {
    if (latencyMs === null) return 0.5;
    const cap = Math.max(1, maxLatencyMs);
    const normalized = latencyMs / cap;
    if (normalized < 0) return 0;
    if (normalized > 1) return 1;
    return normalized;
}

function computeNodeScore(stats, opts = {}, isDrained = false, previousSmoothed = null) {
    const loadWeight = Number.isFinite(opts.loadWeight) ? opts.loadWeight : 0.4;
    const latencyWeight = Number.isFinite(opts.latencyWeight) ? opts.latencyWeight : 0.6;
    const maxLatencyMs = Number.isFinite(opts.maxLatencyMs) ? opts.maxLatencyMs : 300;
    const smoothingAlpha = Number.isFinite(opts.smoothingAlpha) ? opts.smoothingAlpha : 0.35;
    const drainPenalty = Number.isFinite(opts.drainPenalty) ? opts.drainPenalty : 0.6;

    const load = stats ? stats.load : 0.5;
    const latencyNorm = normalizeLatency(resolveLatencyMs(stats), maxLatencyMs);

    const jitterNorm = stats?.jitterMs ? Math.min(1, stats.jitterMs / 100) : 0;
    const lossPenalty = stats?.lossPercent ? Math.min(1, stats.lossPercent / 100) * 0.5 : 0;
    const throttledPenalty = stats?.throttled ? 0.4 : 0;
    const partialBlockPenalty = stats?.partialBlock ? 0.5 : 0;

    const raw = (load * loadWeight) + (latencyNorm * latencyWeight) + (jitterNorm * 0.2) + lossPenalty + throttledPenalty + partialBlockPenalty + (isDrained ? drainPenalty : 0);
    const smoothed = previousSmoothed === null
        ? raw
        : ((previousSmoothed * (1 - smoothingAlpha)) + (raw * smoothingAlpha));
    return { raw, smoothed };
}

function filterAndSortByLoad(outbounds, nodeStatsCache, opts = {}) {
    if (Object.keys(nodeStatsCache).length === 0) return outbounds;
    const drainSet = opts.drainSet instanceof Set ? opts.drainSet : new Set();
    const rankState = opts.rankState instanceof Map ? opts.rankState : null;
    const hysteresisDelta = Number.isFinite(opts.hysteresisDelta) ? opts.hysteresisDelta : 0.08;
    const keepOverloadedWhenDrained = opts.keepOverloadedWhenDrained === true;
    let strategy = 'leastLoad';
    if (opts.strategy === 'leastPing') {
        strategy = 'leastPing';
    } else if (opts.strategy === 'random' || opts.strategy === 'roundRobin') {
        strategy = opts.strategy;
    }

    const withStats = outbounds.map(ob => {
        const stats = getNodeStats(nodeStatsCache, ob);
        const normalizedTag = (ob.tag || '').toLowerCase();
        const normalizedSourceNode = (stats?.sourceNode || '').toLowerCase();
        const isDrained = Boolean(
            (normalizedTag && drainSet.has(normalizedTag))
            || (normalizedSourceNode && drainSet.has(normalizedSourceNode))
        );
        const previous = rankState?.get(ob.tag)?.smoothed ?? null;
        const score = computeNodeScore(stats, opts, isDrained, previous);
        const prevRank = rankState?.get(ob.tag)?.rank ?? null;
        return {
            ob,
            stats,
            load: stats ? stats.load : 0.5,
            latencyMs: resolveLatencyMs(stats),
            isDrained,
            scoreRaw: score.raw,
            score: score.smoothed,
            prevRank,
        };
    });

    const filtered = withStats.filter(({ stats }) => {
        if (!stats) return true;
        if (!stats.isConnected || stats.isDisabled) return false;
        if (stats.load > 1.0) {
            if (!keepOverloadedWhenDrained) return false;
            return true;
        }
        return true;
    });

    const sortByLeastPing = (a, b) => {
        if (a.isDrained !== b.isDrained) return a.isDrained ? 1 : -1;
        const aLatency = a.latencyMs === null ? Number.POSITIVE_INFINITY : a.latencyMs;
        const bLatency = b.latencyMs === null ? Number.POSITIVE_INFINITY : b.latencyMs;
        if (aLatency !== bLatency) return aLatency - bLatency;
        return a.load - b.load;
    };

    if (filtered.length === 0) {
        const connected = withStats.filter(({ stats }) => !stats || (stats.isConnected && !stats.isDisabled));
        if (connected.length === 0) return outbounds;
        if (strategy === 'leastPing') {
            connected.sort(sortByLeastPing);
        } else if (strategy === 'leastLoad') {
            connected.sort((a, b) => a.score - b.score);
        }
        return connected.map(({ ob }) => ob);
    }

    if (strategy === 'leastPing') {
        filtered.sort(sortByLeastPing);
    } else if (strategy === 'leastLoad') {
        filtered.sort((a, b) => {
            const diff = a.score - b.score;
            if (Math.abs(diff) > hysteresisDelta) return diff;
            if (a.prevRank !== null && b.prevRank !== null && a.prevRank !== b.prevRank) {
                return a.prevRank - b.prevRank;
            }
            return a.load - b.load;
        });
    }

    if (rankState && (strategy === 'leastLoad' || strategy === 'leastPing')) {
        for (let i = 0; i < filtered.length; i++) {
            rankState.set(filtered[i].ob.tag, { score: filtered[i].scoreRaw, smoothed: filtered[i].score, rank: i });
        }
    }

    return filtered.map(({ ob }) => ob);
}

module.exports = {
    computePublishedGroupEntries,
    computeNodeScore,
    filterHiddenOutbounds,
    filterAndSortByLoad,
    getNodeStats,
    isFakeConfig,
    matchGroup,
};
