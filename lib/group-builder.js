'use strict';

function sanitizeTag(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

const MANAGED_FIELDS = new Set(['remarks', 'dns', 'inbounds', 'outbounds', 'routing', 'observatory', 'burstObservatory']);
const NON_INHERITED_FIELDS = new Set(['title', 'ps', 'name', 'remark', 'remarks', 'description', 'serverDescription', 'server_description']);

function buildStrategy(strategy, settings) {
    if (strategy !== 'leastLoad') {
        return { type: strategy };
    }
    return {
        type: strategy,
        settings,
    };
}

function needsObservedFallback(strategy) {
    return strategy === 'leastPing' || strategy === 'leastLoad';
}

function buildGroupConfig(baseConfig, groupName, outbounds, opts) {
    const {
        fallbackOutbounds = [],
        probeConnectivity = '',
        probeHttpMethod = 'HEAD',
        probeUrl,
        probeInterval,
        probeSampling = 1,
        probeTimeout = '3s',
        strategy,
        groupDescription = '',
    } = opts;

    const inherited = {};
    for (const [key, val] of Object.entries(baseConfig)) {
        if (!MANAGED_FIELDS.has(key) && !NON_INHERITED_FIELDS.has(key)) {
            inherited[key] = structuredClone(val);
        }
    }

    if (typeof groupDescription === 'string' && groupDescription.trim().length > 0) {
        inherited.description = groupDescription.trim();
    }

    const inbounds = baseConfig.inbounds ? structuredClone(baseConfig.inbounds) : [
        {
            tag: 'socks', port: 10808, listen: '127.0.0.1', protocol: 'socks',
            settings: { udp: true, auth: 'noauth' },
            sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] },
        },
        {
            tag: 'http', port: 10809, listen: '127.0.0.1', protocol: 'http',
            settings: { allowTransparent: false },
            sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] },
        },
    ];

    const allOutboundsForConfig = fallbackOutbounds.length > 0
        ? [...outbounds, ...fallbackOutbounds]
        : outbounds;

    const tags = outbounds.map((outbound) => outbound.tag);
    const fallbackTags = fallbackOutbounds.map((outbound) => outbound.tag);
    const allTags = [...tags, ...fallbackTags];
    const prefix = sanitizeTag(groupName);
    const hasPreferredAndFallback = tags.length > 0 && fallbackTags.length > 0;
    const usesFallbackBalancer = hasPreferredAndFallback && fallbackTags.length > 1;
    const fallbackBalancerTag = `${prefix}-fallback-balancer`;
    const fallbackDispatchTag = `${prefix}-fallback-dispatch`;
    const fallbackInboundTag = `${prefix}-fallback-in`;

    const proxyOutbound = structuredClone(allOutboundsForConfig[0]);
    proxyOutbound.tag = 'proxy';
    delete proxyOutbound.title;
    delete proxyOutbound.ps;
    delete proxyOutbound.description;
    delete proxyOutbound.serverDescription;
    delete proxyOutbound.server_description;

    const cfg = {
        ...inherited,
        remarks: groupName,
        dns: baseConfig.dns ? structuredClone(baseConfig.dns) : {
            servers: ['1.1.1.1', '1.0.0.1'],
            queryStrategy: 'UseIP',
        },
        inbounds,
        outbounds: [
            proxyOutbound,
            ...allOutboundsForConfig.map((outbound) => ({ ...outbound })),
            ...(usesFallbackBalancer ? [{
                tag: fallbackDispatchTag,
                protocol: 'loopback',
                settings: { inboundTag: fallbackInboundTag },
            }] : []),
            { tag: 'direct', protocol: 'freedom' },
            { tag: 'block', protocol: 'blackhole' },
        ],
    };

    cfg.burstObservatory = {
        subjectSelector: allTags,
        pingConfig: {
            destination: probeUrl,
            connectivity: probeConnectivity,
            interval: probeInterval,
            sampling: probeSampling,
            timeout: probeTimeout,
            httpMethod: probeHttpMethod,
        },
    };

    const selector = tags.length > 0 ? tags : fallbackTags;
    const balancer = {
        tag: `${prefix}-balancer`,
        selector,
        strategy: buildStrategy(strategy, hasPreferredAndFallback ? {
            expected: 1,
            baselines: ['1500ms'],
            tolerance: 0.5,
        } : {
            expected: 1,
            baselines: ['1s'],
            tolerance: 0.8,
        }),
    };

    if (hasPreferredAndFallback) {
        balancer.fallbackTag = usesFallbackBalancer ? fallbackDispatchTag : fallbackTags[0];
    } else if (needsObservedFallback(strategy)) {
        // Xray fallbackTag accepts an outbound tag, not another balancer tag.
        balancer.fallbackTag = selector[0];
    }

    const balancers = [balancer];
    if (usesFallbackBalancer) {
        const fallbackBalancer = {
            tag: fallbackBalancerTag,
            selector: fallbackTags,
            strategy: buildStrategy(strategy, {
                expected: 1,
                baselines: ['4s'],
                tolerance: 0.8,
            }),
        };
        if (needsObservedFallback(strategy)) {
            fallbackBalancer.fallbackTag = fallbackTags[0];
        }
        balancers.push(fallbackBalancer);
    }

    cfg.routing = {
        domainStrategy: 'IPIfNonMatch',
        balancers,
        rules: [
            ...(usesFallbackBalancer ? [{
                type: 'field',
                inboundTag: [fallbackInboundTag],
                balancerTag: fallbackBalancerTag,
            }] : []),
            { type: 'field', network: 'udp', port: '443', outboundTag: 'block' },
            { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
            {
                type: 'field',
                domain: [
                    'localhost',
                    'localhost.localdomain',
                    'local',
                    '*.local',
                    '*.localdomain',
                    '*.lan',
                    '*.internal',
                ],
                outboundTag: 'direct',
            },
            {
                type: 'field',
                ip: [
                    '127.0.0.0/8',
                    '10.0.0.0/8',
                    '172.16.0.0/12',
                    '192.168.0.0/16',
                    '169.254.0.0/16',
                    '::1/128',
                    'fc00::/7',
                    'fe80::/10',
                ],
                outboundTag: 'direct',
            },
            { type: 'field', network: 'tcp,udp', balancerTag: `${prefix}-balancer` },
        ],
    };

    return cfg;
}

module.exports = {
    buildGroupConfig,
};
