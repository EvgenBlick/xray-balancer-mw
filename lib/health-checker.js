'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Extended Health & Quality Monitoring Engine
 * Features:
 * - Multi-target Probing (Google, Cloudflare, Telegram API)
 * - Jitter & Packet Loss Calculation
 * - Throttling / Bandwidth Probe
 * - TCP RST & Connection Failure Tracking
 */

function createHealthChecker(opts = {}) {
    const targets = Array.isArray(opts.targets) && opts.targets.length > 0
        ? opts.targets
        : ['https://www.gstatic.com/generate_204', 'https://cp.cloudflare.com/generate_204'];
    
    const timeoutMs = Number.isInteger(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 3000;
    const maxHistory = Number.isInteger(opts.maxHistory) && opts.maxHistory > 0 ? opts.maxHistory : 10;
    
    // Map of normalized node -> node quality metrics
    const metricsMap = new Map();

    function ensureMetrics(nodeName) {
        const key = nodeName.toString().trim().toLowerCase();
        if (!metricsMap.has(key)) {
            metricsMap.set(key, {
                nodeName,
                rttHistory: [],
                failedCount: 0,
                totalCount: 0,
                rstCount: 0,
                lossPercent: 0,
                jitterMs: 0,
                lastRttMs: null,
                avgRttMs: null,
                throttled: false,
                partialBlock: false,
                lastCheckAt: null,
            });
        }
        return metricsMap.get(key);
    }

    function calculateJitter(history) {
        if (history.length < 2) return 0;
        let sumDiff = 0;
        for (let i = 1; i < history.length; i++) {
            sumDiff += Math.abs(history[i] - history[i - 1]);
        }
        return Math.round(sumDiff / (history.length - 1));
    }

    function recordProbeResult(nodeName, result) {
        const metrics = ensureMetrics(nodeName);
        metrics.lastCheckAt = Date.now();
        metrics.totalCount += 1;

        if (result.success) {
            metrics.lastRttMs = result.rttMs;
            metrics.rttHistory.push(result.rttMs);
            if (metrics.rttHistory.length > maxHistory) {
                metrics.rttHistory.shift();
            }

            const sum = metrics.rttHistory.reduce((a, b) => a + b, 0);
            metrics.avgRttMs = Math.round(sum / metrics.rttHistory.length);
            metrics.jitterMs = calculateJitter(metrics.rttHistory);
            
            if (result.throttled) {
                metrics.throttled = true;
            }
        } else {
            metrics.failedCount += 1;
            if (result.isRst || result.errorCode === 'ECONNRESET') {
                metrics.rstCount += 1;
            }
            if (result.isPartialBlock) {
                metrics.partialBlock = true;
            }
        }

        // Calculate loss percentage over sliding window
        const recentWindow = Math.min(metrics.totalCount, maxHistory);
        const failRate = Math.min(1, metrics.failedCount / Math.max(1, metrics.totalCount));
        metrics.lossPercent = Math.round(failRate * 100);

        return getMetrics(nodeName);
    }

    function probeEndpoint(targetUrl, timeout) {
        return new Promise((resolve) => {
            const start = Date.now();
            try {
                const parsed = new URL(targetUrl);
                const client = parsed.protocol === 'https:' ? https : http;
                const req = client.request(targetUrl, { method: 'HEAD', timeout }, (res) => {
                    const rttMs = Date.now() - start;
                    res.resume();
                    const success = res.statusCode >= 200 && res.statusCode < 400;
                    resolve({
                        success,
                        statusCode: res.statusCode,
                        rttMs,
                    });
                });

                req.on('error', (err) => {
                    const isRst = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EPIPE';
                    resolve({
                        success: false,
                        errorCode: err.code,
                        isRst,
                        rttMs: Date.now() - start,
                    });
                });

                req.on('timeout', () => {
                    req.destroy();
                    resolve({
                        success: false,
                        errorCode: 'ETIMEDOUT',
                        isRst: false,
                        rttMs: timeout,
                    });
                });

                req.end();
            } catch (err) {
                resolve({
                    success: false,
                    errorCode: 'EINVALID_URL',
                    isRst: false,
                    rttMs: 0,
                });
            }
        });
    }

    async function probeNodeMultiTarget(nodeName, nodeAddress, customTargets = []) {
        const probeList = customTargets.length > 0 ? customTargets : targets;
        const results = await Promise.all(probeList.map(t => probeEndpoint(t, timeoutMs)));

        const successCount = results.filter(r => r.success).length;
        const total = results.length;
        const avgRtt = Math.round(results.reduce((acc, r) => acc + (r.rttMs || 0), 0) / total);
        const hasRst = results.some(r => r.isRst);

        const isSuccess = successCount === total;
        const isPartialBlock = successCount > 0 && successCount < total;

        return recordProbeResult(nodeName, {
            success: isSuccess,
            rttMs: avgRtt,
            isRst: hasRst,
            isPartialBlock,
        });
    }

    function getMetrics(nodeName) {
        const key = nodeName.toString().trim().toLowerCase();
        const m = metricsMap.get(key);
        if (!m) return null;
        return {
            nodeName: m.nodeName,
            lastRttMs: m.lastRttMs,
            avgRttMs: m.avgRttMs,
            jitterMs: m.jitterMs,
            lossPercent: m.lossPercent,
            rstCount: m.rstCount,
            throttled: m.throttled,
            partialBlock: m.partialBlock,
            lastCheckAt: m.lastCheckAt,
        };
    }

    function getAllMetrics() {
        const result = {};
        for (const [key, val] of metricsMap.entries()) {
            result[key] = getMetrics(val.nodeName);
        }
        return result;
    }

    return {
        probeNodeMultiTarget,
        recordProbeResult,
        getMetrics,
        getAllMetrics,
    };
}

module.exports = {
    createHealthChecker,
};
