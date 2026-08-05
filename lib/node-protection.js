'use strict';

const NODE_STATES = Object.freeze({
    HEALTHY: 'healthy',
    SUSPECT: 'suspect',
    ISOLATED: 'isolated',
    RECOVERING: 'recovering',
});

function normalizeNodeName(value) {
    return (value || '').toString().trim().toLowerCase();
}

function positiveInteger(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function createNodeProtectionManager(opts = {}) {
    const failureThreshold = positiveInteger(opts.failureThreshold, 3);
    const recoverySuccessThreshold = positiveInteger(opts.recoverySuccessThreshold, 3);
    const isolationTtlSec = positiveInteger(opts.isolationTtlSec, 300);
    const clock = typeof opts.now === 'function' ? opts.now : Date.now;
    const nodes = new Map();
    const eventQueue = [];
    let nextEventId = 1;

    function resolveTimestamp(at) {
        const value = at === undefined ? clock() : at;
        if (!Number.isFinite(value)) {
            throw new TypeError('timestamp must be a finite number');
        }
        return value;
    }

    function requireNodeName(nodeName) {
        const normalizedNode = normalizeNodeName(nodeName);
        if (!normalizedNode) {
            throw new TypeError('nodeName must be a non-empty value');
        }
        return normalizedNode;
    }

    function textOr(value, fallback) {
        if (typeof value !== 'string') return fallback;
        return value.trim() || fallback;
    }

    function ttlMs(details = {}) {
        return positiveInteger(details.ttlSec, isolationTtlSec) * 1000;
    }

    function createRecord(nodeName, normalizedNode, at) {
        return {
            nodeName: nodeName.toString().trim(),
            normalizedNode,
            state: NODE_STATES.HEALTHY,
            failureCount: 0,
            recoverySuccessCount: 0,
            lastFailureAt: null,
            lastSuccessAt: null,
            isolation: null,
            updatedAt: at,
        };
    }

    function ensureRecord(nodeName, at) {
        const normalizedNode = requireNodeName(nodeName);
        let record = nodes.get(normalizedNode);
        if (!record) {
            record = createRecord(nodeName, normalizedNode, at);
            nodes.set(normalizedNode, record);
        }
        return record;
    }

    function cloneIsolation(isolation) {
        return isolation ? { ...isolation } : null;
    }

    function snapshot(record) {
        if (!record) return null;
        return {
            nodeName: record.nodeName,
            normalizedNode: record.normalizedNode,
            state: record.state,
            failureCount: record.failureCount,
            recoverySuccessCount: record.recoverySuccessCount,
            lastFailureAt: record.lastFailureAt,
            lastSuccessAt: record.lastSuccessAt,
            isolation: cloneIsolation(record.isolation),
            updatedAt: record.updatedAt,
        };
    }

    function cloneEvent(event) {
        return { ...event };
    }

    function emit(type, record, from, to, details, at) {
        const event = {
            id: nextEventId,
            type,
            nodeName: record.nodeName,
            normalizedNode: record.normalizedNode,
            from,
            to,
            reason: details.reason,
            source: details.source,
            mode: record.isolation?.mode || details.mode || null,
            at,
            expiresAt: record.isolation?.expiresAt ?? null,
        };
        nextEventId += 1;
        eventQueue.push(event);
        return event;
    }

    function transition(record, nextState, details, at) {
        const previousState = record.state;
        record.state = nextState;
        record.updatedAt = at;
        return emit('state_transition', record, previousState, nextState, details, at);
    }

    function releaseRecord(record, details, at) {
        const previousIsolation = record.isolation;
        const eventDetails = {
            reason: textOr(details.reason, 'released'),
            source: textOr(details.source, 'system'),
            mode: previousIsolation?.mode || null,
        };
        record.isolation = null;
        record.failureCount = 0;
        record.recoverySuccessCount = 0;
        return transition(record, NODE_STATES.HEALTHY, eventDetails, at);
    }

    function processExpirations(at) {
        const events = [];
        for (const record of nodes.values()) {
            const isolation = record.isolation;
            if (!isolation || isolation.expiresAt > at) continue;

            if (isolation.mode === 'manual') {
                events.push(releaseRecord(record, {
                    reason: 'manual_isolation_expired',
                    source: 'expiry',
                }, at));
                continue;
            }

            if (record.recoverySuccessCount >= recoverySuccessThreshold) {
                events.push(releaseRecord(record, {
                    reason: 'automatic_isolation_recovered',
                    source: 'health_check',
                }, at));
            }
        }
        return events;
    }

    function operationResult(record, events, extra = {}) {
        return {
            ...extra,
            node: snapshot(record),
            events: events.map(cloneEvent),
        };
    }

    function isolate(record, mode, details, at) {
        const reason = textOr(details.reason, mode === 'manual' ? 'manual_isolation' : 'automatic_isolation');
        const source = textOr(details.source, mode === 'manual' ? 'admin' : 'health_check');
        const expiresAt = at + ttlMs(details);
        const wasProtected = record.state === NODE_STATES.ISOLATED || record.state === NODE_STATES.RECOVERING;

        if (record.isolation?.mode === 'manual' && mode === 'automatic') {
            return [];
        }

        record.failureCount = mode === 'automatic' ? Math.max(record.failureCount, failureThreshold) : 0;
        record.recoverySuccessCount = 0;
        record.isolation = {
            mode,
            reason,
            source,
            isolatedAt: at,
            expiresAt,
        };
        record.updatedAt = at;

        const eventDetails = { reason, source, mode };
        if (wasProtected) {
            const previousState = record.state;
            record.state = NODE_STATES.ISOLATED;
            return [emit('isolation_updated', record, previousState, NODE_STATES.ISOLATED, eventDetails, at)];
        }
        return [transition(record, NODE_STATES.ISOLATED, eventDetails, at)];
    }

    function isolateManual(nodeName, details = {}, at) {
        const timestamp = resolveTimestamp(at);
        const expiryEvents = processExpirations(timestamp);
        const record = ensureRecord(nodeName, timestamp);
        const events = [...expiryEvents, ...isolate(record, 'manual', details, timestamp)];
        return operationResult(record, events, { isolated: true });
    }

    function isolateAutomatic(nodeName, details = {}, at) {
        const timestamp = resolveTimestamp(at);
        const expiryEvents = processExpirations(timestamp);
        const record = ensureRecord(nodeName, timestamp);
        const events = [...expiryEvents, ...isolate(record, 'automatic', details, timestamp)];
        const isolated = record.state === NODE_STATES.ISOLATED || record.state === NODE_STATES.RECOVERING;
        return operationResult(record, events, { isolated });
    }

    function recordFailure(nodeName, details = {}, at) {
        const timestamp = resolveTimestamp(at);
        const events = processExpirations(timestamp);
        const record = ensureRecord(nodeName, timestamp);
        record.lastFailureAt = timestamp;
        record.updatedAt = timestamp;

        if (record.isolation?.mode === 'manual') {
            return operationResult(record, events, { isolated: true });
        }

        record.failureCount += 1;
        record.recoverySuccessCount = 0;

        if (record.state === NODE_STATES.RECOVERING) {
            const reason = textOr(details.reason, 'health_check_failed');
            const source = textOr(details.source, 'health_check');
            record.isolation.reason = reason;
            record.isolation.source = source;
            record.isolation.expiresAt = Math.max(record.isolation.expiresAt, timestamp + ttlMs(details));
            events.push(transition(record, NODE_STATES.ISOLATED, {
                reason,
                source,
                mode: 'automatic',
            }, timestamp));
        } else if (record.state === NODE_STATES.ISOLATED) {
            record.isolation.expiresAt = Math.max(record.isolation.expiresAt, timestamp + ttlMs(details));
        } else if (record.failureCount >= failureThreshold) {
            events.push(...isolate(record, 'automatic', details, timestamp));
        } else if (record.state === NODE_STATES.HEALTHY) {
            events.push(transition(record, NODE_STATES.SUSPECT, {
                reason: textOr(details.reason, 'health_check_failed'),
                source: textOr(details.source, 'health_check'),
                mode: null,
            }, timestamp));
        }

        const isolated = record.state === NODE_STATES.ISOLATED || record.state === NODE_STATES.RECOVERING;
        return operationResult(record, events, { isolated });
    }

    function recordSuccess(nodeName, details = {}, at) {
        const timestamp = resolveTimestamp(at);
        const events = processExpirations(timestamp);
        const record = ensureRecord(nodeName, timestamp);
        record.lastSuccessAt = timestamp;
        record.updatedAt = timestamp;

        if (record.isolation?.mode === 'manual') {
            return operationResult(record, events, { isolated: true });
        }

        if (record.state === NODE_STATES.HEALTHY) {
            record.failureCount = 0;
        } else if (record.state === NODE_STATES.SUSPECT) {
            record.failureCount = 0;
            events.push(transition(record, NODE_STATES.HEALTHY, {
                reason: textOr(details.reason, 'health_check_recovered'),
                source: textOr(details.source, 'health_check'),
                mode: null,
            }, timestamp));
        } else {
            record.failureCount = 0;
            record.recoverySuccessCount += 1;
            if (record.state === NODE_STATES.ISOLATED) {
                events.push(transition(record, NODE_STATES.RECOVERING, {
                    reason: textOr(details.reason, 'recovery_started'),
                    source: textOr(details.source, 'health_check'),
                    mode: 'automatic',
                }, timestamp));
            }
            if (record.recoverySuccessCount >= recoverySuccessThreshold
                && record.isolation.expiresAt <= timestamp) {
                events.push(releaseRecord(record, {
                    reason: textOr(details.reason, 'automatic_isolation_recovered'),
                    source: textOr(details.source, 'health_check'),
                }, timestamp));
            }
        }

        const isolated = record.state === NODE_STATES.ISOLATED || record.state === NODE_STATES.RECOVERING;
        return operationResult(record, events, { isolated });
    }

    function release(nodeName, details = {}, at) {
        const timestamp = resolveTimestamp(at);
        const events = processExpirations(timestamp);
        const normalizedNode = requireNodeName(nodeName);
        const record = nodes.get(normalizedNode);
        if (!record || (record.state !== NODE_STATES.ISOLATED && record.state !== NODE_STATES.RECOVERING)) {
            return operationResult(record, events, { released: false });
        }
        events.push(releaseRecord(record, {
            reason: textOr(details.reason, 'released'),
            source: textOr(details.source, 'admin'),
        }, timestamp));
        return operationResult(record, events, { released: true });
    }

    function expire(at) {
        const timestamp = resolveTimestamp(at);
        const events = processExpirations(timestamp);
        return {
            expired: events.map((event) => event.normalizedNode),
            events: events.map(cloneEvent),
        };
    }

    function get(nodeName, at) {
        const timestamp = resolveTimestamp(at);
        processExpirations(timestamp);
        return snapshot(nodes.get(requireNodeName(nodeName)));
    }

    function isIsolated(nodeName, at) {
        const record = get(nodeName, at);
        return record?.state === NODE_STATES.ISOLATED || record?.state === NODE_STATES.RECOVERING;
    }

    function list(options = {}, at) {
        const timestamp = resolveTimestamp(at);
        processExpirations(timestamp);
        const protectedOnly = options.protectedOnly === true;
        return [...nodes.values()]
            .filter((record) => !protectedOnly
                || record.state === NODE_STATES.ISOLATED
                || record.state === NODE_STATES.RECOVERING)
            .map(snapshot)
            .sort((a, b) => a.normalizedNode.localeCompare(b.normalizedNode));
    }

    function summary(at) {
        const timestamp = resolveTimestamp(at);
        processExpirations(timestamp);
        const result = {
            total: nodes.size,
            protected: 0,
            healthy: 0,
            suspect: 0,
            isolated: 0,
            recovering: 0,
            manual: 0,
            automatic: 0,
        };
        for (const record of nodes.values()) {
            result[record.state] += 1;
            if (record.state === NODE_STATES.ISOLATED || record.state === NODE_STATES.RECOVERING) {
                result.protected += 1;
                result[record.isolation.mode] += 1;
            }
        }
        return result;
    }

    function peekEvents() {
        return eventQueue.map(cloneEvent);
    }

    function drainEvents() {
        const events = peekEvents();
        eventQueue.length = 0;
        return events;
    }

    return {
        drainEvents,
        expire,
        get,
        isIsolated,
        isolateAutomatic,
        isolateManual,
        list,
        peekEvents,
        recordFailure,
        recordSuccess,
        release,
        summary,
    };
}

module.exports = {
    NODE_STATES,
    createNodeProtectionManager,
    normalizeNodeName,
};
