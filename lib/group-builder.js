'use strict';

function sanitizeTag(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

const MANAGED_FIELDS = new Set(['remarks', 'dns', 'inbounds', 'outbounds', 'routing', 'observatory', 'burstObservatory']);
const NON_INHERITED_FIELDS = new Set(['title', 'ps', 'name', 'remark', 'remarks', 'description', 'serverDescription', 'server_description']);
const SYSTEM_OUTBOUND_PROTOCOLS = new Set(['freedom', 'blackhole', 'dns', 'loopback']);
const REDUNDANT_PRIVATE_GEO_SELECTORS = new Set(['geoip:private', 'geosite:private']);

function stableValueKey(value) {
    return JSON.stringify(value);
}

function mergeUniqueValues(values) {
    const seen = new Set();
    const merged = [];
    for (const value of values) {
        const key = stableValueKey(value);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(structuredClone(value));
    }
    return merged;
}

function mergeDnsConfigs(configs) {
    const dnsConfigs = configs.map((config) => config?.dns).filter((dns) => dns !== undefined);
    if (dnsConfigs.length === 0) return undefined;

    const firstDns = structuredClone(dnsConfigs[0]);
    if (!firstDns || typeof firstDns !== 'object' || Array.isArray(firstDns)) {
        return firstDns;
    }

    const objectConfigs = dnsConfigs.filter((dns) => dns && typeof dns === 'object' && !Array.isArray(dns));
    const policyKey = (dns) => JSON.stringify(Object.fromEntries(
        Object.keys(dns)
            .filter((key) => key !== 'servers' && key !== 'hosts')
            .sort()
            .map((key) => [key, dns[key]])
    ));
    const firstPolicyKey = policyKey(firstDns);
    const compatibleConfigs = objectConfigs.filter((dns) => policyKey(dns) === firstPolicyKey);
    const servers = compatibleConfigs.flatMap((dns) => Array.isArray(dns.servers) ? dns.servers : []);
    if (servers.length > 0) firstDns.servers = mergeUniqueValues(servers);

    const hosts = Object.assign({}, ...compatibleConfigs.map((dns) => (
        dns.hosts && typeof dns.hosts === 'object' && !Array.isArray(dns.hosts) ? dns.hosts : {}
    )).reverse());
    if (Object.keys(hosts).length > 0) firstDns.hosts = hosts;
    return firstDns;
}

function mergeRoutingConfigs(configs) {
    const routingConfigs = configs.map((config) => config?.routing)
        .filter((routing) => routing && typeof routing === 'object' && !Array.isArray(routing));
    if (routingConfigs.length === 0) return undefined;

    const merged = {};
    for (const [key, value] of Object.entries(routingConfigs[0])) {
        if (key !== 'rules' && key !== 'balancers') merged[key] = structuredClone(value);
    }
    merged.rules = mergeUniqueValues(routingConfigs.flatMap((routing) => (
        Array.isArray(routing.rules) ? routing.rules : []
    )));
    return merged;
}

function mergeProfileBaseConfigs(configs) {
    const validConfigs = configs.filter((config) => config && typeof config === 'object' && !Array.isArray(config));
    if (validConfigs.length === 0) return {};

    const merged = structuredClone(validConfigs[0]);
    const mergedOutbounds = Array.isArray(merged.outbounds) ? merged.outbounds : [];
    const seenOutboundTags = new Set(mergedOutbounds.map((outbound) => outbound?.tag).filter(Boolean));
    for (const config of validConfigs.slice(1)) {
        for (const outbound of config.outbounds || []) {
            if (!outbound?.tag || !SYSTEM_OUTBOUND_PROTOCOLS.has(outbound.protocol) || seenOutboundTags.has(outbound.tag)) continue;
            mergedOutbounds.push(structuredClone(outbound));
            seenOutboundTags.add(outbound.tag);
        }
    }
    if (mergedOutbounds.length > 0) merged.outbounds = mergedOutbounds;
    const dns = mergeDnsConfigs(validConfigs);
    const routing = mergeRoutingConfigs(validConfigs);
    if (dns === undefined) delete merged.dns;
    else merged.dns = dns;
    if (routing === undefined) delete merged.routing;
    else merged.routing = routing;
    return merged;
}

function buildSystemOutbounds(baseConfig, reservedTags) {
    const systemOutbounds = [];
    const seenTags = new Set(reservedTags);
    for (const outbound of baseConfig.outbounds || []) {
        if (!outbound?.tag || !SYSTEM_OUTBOUND_PROTOCOLS.has(outbound.protocol) || seenTags.has(outbound.tag)) continue;
        systemOutbounds.push(structuredClone(outbound));
        seenTags.add(outbound.tag);
    }
    if (!seenTags.has('direct')) {
        systemOutbounds.push({ tag: 'direct', protocol: 'freedom' });
        seenTags.add('direct');
    }
    if (!seenTags.has('block')) {
        systemOutbounds.push({ tag: 'block', protocol: 'blackhole' });
    }
    return systemOutbounds;
}

function remapOutboundReferences(outbound, tagMap) {
    const proxyTag = outbound.proxySettings?.tag;
    if (typeof proxyTag === 'string' && tagMap.has(proxyTag)) {
        outbound.proxySettings.tag = tagMap.get(proxyTag);
    }

    const dialerProxy = outbound.streamSettings?.sockopt?.dialerProxy;
    if (typeof dialerProxy === 'string' && tagMap.has(dialerProxy)) {
        outbound.streamSettings.sockopt.dialerProxy = tagMap.get(dialerProxy);
    }
}

function cloneOutboundsWithPrefixSafeTags(outbounds, reservedTags) {
    const width = Math.max(2, String(outbounds.length).length);
    const tagMap = new Map();
    const generatedTags = [];

    for (let index = 0; index < outbounds.length; index += 1) {
        const originalTag = outbounds[index].tag;
        let candidate = `__xrb_${String(index + 1).padStart(width, '0')}__:${originalTag}`;
        while ([...reservedTags].some((tag) => tag.startsWith(candidate))) {
            candidate = `_${candidate}`;
        }
        tagMap.set(originalTag, candidate);
        generatedTags.push(candidate);
    }

    return outbounds.map((outbound, index) => {
        const cloned = structuredClone(outbound);
        cloned.tag = generatedTags[index];
        remapOutboundReferences(cloned, tagMap);
        return cloned;
    });
}

function normalizeProfileRules(rules, availableOutboundTags, balancerTag) {
    const normalized = [];
    for (const sourceRule of rules || []) {
        if (!sourceRule || typeof sourceRule !== 'object' || Array.isArray(sourceRule)) continue;
        const locationSelectors = [
            ...(Array.isArray(sourceRule.domain) ? sourceRule.domain : []),
            ...(Array.isArray(sourceRule.ip) ? sourceRule.ip : []),
        ];
        if (
            sourceRule.outboundTag === 'direct'
            && locationSelectors.length > 0
            && locationSelectors.every((selector) => REDUNDANT_PRIVATE_GEO_SELECTORS.has(selector))
        ) {
            continue;
        }
        const rule = structuredClone(sourceRule);
        if (rule.outboundTag === 'proxy') {
            delete rule.outboundTag;
            rule.balancerTag = balancerTag;
        } else if (typeof rule.outboundTag === 'string') {
            if (!availableOutboundTags.has(rule.outboundTag)) continue;
        } else if (rule.balancerTag !== undefined) {
            continue;
        } else {
            continue;
        }
        normalized.push(rule);
    }
    return mergeUniqueValues(normalized);
}

function isCatchAllRule(rule) {
    const conditionKeys = [
        'domain', 'ip', 'port', 'sourcePort', 'protocol', 'inboundTag', 'source', 'user', 'attrs',
    ];
    if (conditionKeys.some((key) => rule[key] !== undefined)) return false;
    if (rule.network === undefined) return true;
    if (typeof rule.network !== 'string') return false;
    const networks = new Set(rule.network.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
    return networks.has('tcp') && networks.has('udp');
}

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
    return ['leastPing', 'leastLoad', 'random', 'roundRobin'].includes(strategy);
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
        nodeDnsScope = {},
    } = opts;

    const inherited = {};
    for (const [key, val] of Object.entries(baseConfig)) {
        if (!MANAGED_FIELDS.has(key) && !NON_INHERITED_FIELDS.has(key)) {
            inherited[key] = structuredClone(val);
        }
    }

    if (inherited.meta) {
        inherited.meta = structuredClone(inherited.meta);
        delete inherited.meta.serverDescription;
    }

    if (typeof groupDescription === 'string' && groupDescription.trim().length > 0) {
        inherited.description = groupDescription.trim();
        if (!inherited.meta) inherited.meta = {};
        inherited.meta.serverDescription = groupDescription.trim();
    } else {
        delete inherited.description;
        delete inherited.serverDescription;
        delete inherited.server_description;
        if (inherited.meta) {
            delete inherited.meta.serverDescription;
            if (Object.keys(inherited.meta).length === 0) delete inherited.meta;
        }
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

    const prefix = sanitizeTag(groupName);
    const balancerTag = `${prefix}-balancer`;
    const hasPreferredAndFallback = outbounds.length > 0 && fallbackOutbounds.length > 0;
    const usesFallbackBalancer = hasPreferredAndFallback && fallbackOutbounds.length > 1;
    const fallbackBalancerTag = `${prefix}-fallback-balancer`;
    const fallbackDispatchTag = `${prefix}-fallback-dispatch`;
    const fallbackInboundTag = `${prefix}-fallback-in`;
    const reservedTags = new Set(['proxy', 'direct', 'block', fallbackDispatchTag]);
    for (const outbound of baseConfig.outbounds || []) {
        if (outbound?.tag && SYSTEM_OUTBOUND_PROTOCOLS.has(outbound.protocol)) {
            reservedTags.add(outbound.tag);
        }
    }
    const allOutboundsForConfig = cloneOutboundsWithPrefixSafeTags(
        [...outbounds, ...fallbackOutbounds],
        reservedTags,
    );
    const safeOutbounds = allOutboundsForConfig.slice(0, outbounds.length);
    const safeFallbackOutbounds = allOutboundsForConfig.slice(outbounds.length);
    const tags = safeOutbounds.map((outbound) => outbound.tag);
    const fallbackTags = safeFallbackOutbounds.map((outbound) => outbound.tag);
    const allTags = [...tags, ...fallbackTags];
    const occupiedTags = new Set(['proxy', ...allTags, ...(usesFallbackBalancer ? [fallbackDispatchTag] : [])]);
    const systemOutbounds = buildSystemOutbounds(baseConfig, occupiedTags);
    const proxyOutbound = structuredClone(allOutboundsForConfig[0]);
    proxyOutbound.tag = 'proxy';

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
            ...systemOutbounds,
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
        tag: balancerTag,
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

    const routingBase = {};
    for (const [key, value] of Object.entries(baseConfig.routing || {})) {
        if (key !== 'rules' && key !== 'balancers') routingBase[key] = structuredClone(value);
    }
    const availableOutboundTags = new Set(cfg.outbounds.map((outbound) => outbound.tag));
    const profileRules = normalizeProfileRules(baseConfig.routing?.rules, availableOutboundTags, balancerTag);
    const profileSpecificRules = profileRules.filter((rule) => !isCatchAllRule(rule));
    const profileCatchAllRules = profileRules.filter(isCatchAllRule);
    // Private destinations go first so the QUIC block below never hits the LAN.
    // Xray domain syntax: a bare string is a substring match and globs are not supported.
    const managedSpecificRules = [
        {
            type: 'field',
            domain: [
                'full:localhost',
                'domain:local',
                'domain:localdomain',
                'domain:lan',
                'domain:internal',
                'domain:home.arpa',
            ],
            outboundTag: 'direct',
        },
        {
            // Literal CIDRs instead of geoip:private: no dependency on the client's geoip.dat.
            type: 'field',
            ip: [
                '0.0.0.0/8',
                '10.0.0.0/8',
                '100.64.0.0/10',
                '127.0.0.0/8',
                '169.254.0.0/16',
                '172.16.0.0/12',
                '192.168.0.0/16',
                '224.0.0.0/4',
                '255.255.255.255/32',
                '::1/128',
                'fc00::/7',
                'fe80::/10',
                'ff00::/8',
            ],
            outboundTag: 'direct',
        },
        { type: 'field', network: 'udp', port: '443', outboundTag: 'block' },
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
    ];
    const managedCatchAllRule = { type: 'field', network: 'tcp,udp', balancerTag };

    cfg.routing = {
        ...routingBase,
        domainStrategy: routingBase.domainStrategy || 'IPIfNonMatch',
        balancers,
        rules: mergeUniqueValues([
            ...(usesFallbackBalancer ? [{
                type: 'field',
                inboundTag: [fallbackInboundTag],
                balancerTag: fallbackBalancerTag,
            }] : []),
            ...profileSpecificRules,
            ...managedSpecificRules,
            ...profileCatchAllRules,
            managedCatchAllRule,
        ]),
    };

    return scopeNodeDns(cfg, nodeDnsOptions(cfg, nodeDnsScope || {}));
}

// config.node_dns_scope: dns.hosts entries of node domains (matched by suffix) are kept only in profiles whose
// outbounds use them. Service hostnames are never touched; profiles that only use excluded endpoints stay unchanged.
// Empty by default, which leaves dns.hosts exactly as the panel sent it.
function nodeDnsOptions(config, scope = {}) {
    const serviceHostnames = new Set((scope.serviceHostnames || []).map((host) => host.toLowerCase()));
    const suffixes = (scope.nodeDomainSuffixes || []).map((suffix) => suffix.toLowerCase());
    return {
        managedNodeDomains: Object.keys(config.dns?.hosts || {})
            .map((host) => host.toLowerCase())
            .filter((host) => !serviceHostnames.has(host) && suffixes.some((suffix) => host.endsWith(suffix))),
        excludedNodeDomains: (scope.excludedEndpoints || []).map((host) => host.toLowerCase()),
    };
}

// Drops dns.hosts entries for node domains this profile does not use. Transport settings and credentials stay exact.
function scopeNodeDns(config, options) {
    const managed = new Set(options.managedNodeDomains);
    const excluded = new Set(options.excludedNodeDomains || []);
    const used = new Set();
    const scan = (value) => {
        if (typeof value === 'string') {
            const name = value.toLowerCase().replace(/:\d+$/, '');
            if (managed.has(name) || excluded.has(name)) used.add(name);
            try {
                const host = new URL(value).hostname;
                if (managed.has(host) || excluded.has(host)) used.add(host);
            } catch {}
        } else if (Array.isArray(value)) value.forEach(scan);
        else if (value && typeof value === 'object') Object.values(value).forEach(scan);
    };
    scan(config.outbounds || []);
    if (used.size && [...used].every((host) => excluded.has(host))) return structuredClone(config);
    const result = structuredClone(config);
    if (!result.dns || !result.dns.hosts || Array.isArray(result.dns.hosts)) return result;
    for (const host of Object.keys(result.dns.hosts)) {
        const key = host.toLowerCase();
        if (managed.has(key) && !used.has(key)) delete result.dns.hosts[host];
    }
    return result;
}

module.exports = {
    buildGroupConfig,
    mergeProfileBaseConfigs,
};
