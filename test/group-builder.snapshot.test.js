'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildGroupConfig, mergeProfileBaseConfigs } = require('../lib/group-builder');

test('buildGroupConfig output matches snapshot fixture', () => {
    const base = {
        remarks: 'base',
        dns: { servers: ['1.1.1.1'] },
        inbounds: [{ tag: 'socks', protocol: 'socks' }],
        extraField: { x: 1 },
    };
    const outbounds = [
        { tag: 'Germany-1', protocol: 'vless' },
        { tag: 'USA-1', protocol: 'vless' },
    ];

    const out = buildGroupConfig(base, '🇪🇺 Europe', outbounds, {
        probeUrl: 'https://example.com/ping',
        probeInterval: '3m',
        strategy: 'leastLoad',
    });

    const snapPath = path.join(__dirname, 'fixtures', 'group_snapshot.json');
    const expected = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    assert.deepEqual(out, expected);
});

test('buildGroupConfig exposes a Happ-compatible proxy outbound and preserves the fallback pool', () => {
    const base = {
        inbounds: [
            { tag: 'socks', port: 10808, protocol: 'socks' },
            { tag: 'http', port: 10809, protocol: 'http' },
        ],
    };

    const out = buildGroupConfig(base, '🏁 Fastest', [{ tag: 'Main-1', protocol: 'vless' }], {
        fallbackOutbounds: [
            { tag: 'LTE-1', protocol: 'vless' },
            { tag: 'LTE-2', protocol: 'vless' },
        ],
        probeUrl: 'https://example.com/ping',
        probeInterval: '1m',
        strategy: 'leastLoad',
    });

    assert.deepEqual(out.inbounds.map((inbound) => inbound.port), [10808, 10809]);
    assert.equal(out.outbounds[0].tag, 'proxy');
    assert.equal(out.outbounds[0].protocol, 'vless');
    assert.equal(out.outbounds[1].tag, '__xrb_01__:Main-1');
    assert.deepEqual(out.burstObservatory.subjectSelector, [
        '__xrb_01__:Main-1',
        '__xrb_02__:LTE-1',
        '__xrb_03__:LTE-2',
    ]);
    assert.equal(out.burstObservatory.pingConfig.sampling, 1);
    assert.equal(out.burstObservatory.pingConfig.timeout, '3s');
    assert.equal(out.burstObservatory.pingConfig.connectivity, '');
    assert.equal(out.burstObservatory.pingConfig.httpMethod, 'HEAD');
    assert.equal(out.routing.balancers.length, 2);
    assert.equal(out.routing.balancers[0].fallbackTag, '_Fastest-fallback-dispatch');
    assert.equal(out.routing.balancers[1].fallbackTag, '__xrb_02__:LTE-1');
    assert.deepEqual(out.routing.balancers[1].selector, ['__xrb_02__:LTE-1', '__xrb_03__:LTE-2']);
    assert.deepEqual(
        out.outbounds.find((outbound) => outbound.tag === '_Fastest-fallback-dispatch'),
        {
            tag: '_Fastest-fallback-dispatch',
            protocol: 'loopback',
            settings: { inboundTag: '_Fastest-fallback-in' },
        },
    );
    assert.deepEqual(out.routing.rules[0], {
        type: 'field',
        inboundTag: ['_Fastest-fallback-in'],
        balancerTag: '_Fastest-fallback-balancer',
    });
});

test('buildGroupConfig preserves panel routing rules and remaps proxy to the generated balancer', () => {
    const base = {
        routing: {
            domainStrategy: 'AsIs',
            domainMatcher: 'hybrid',
            rules: [
                { type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' },
                { type: 'field', domain: ['geosite:ru'], ip: ['geoip:ru'], outboundTag: 'direct' },
                { type: 'field', network: 'udp', port: '53', outboundTag: 'dns-out' },
                { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' },
                { type: 'field', domain: ['example.invalid'], outboundTag: 'missing-outbound' },
                { type: 'field', network: 'tcp', balancerTag: 'old-balancer' },
            ],
        },
        outbounds: [
            { tag: 'proxy', protocol: 'vless', settings: { transport: 'xhttp' } },
            { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIPv4' } },
            { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } },
            { tag: 'dns-out', protocol: 'dns' },
        ],
    };

    const out = buildGroupConfig(base, 'Europe', [{ tag: 'Germany-1', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '1m',
        strategy: 'leastPing',
    });

    assert.equal(out.routing.domainStrategy, 'AsIs');
    assert.equal(out.routing.domainMatcher, 'hybrid');
    assert.deepEqual(out.outbounds[0], {
        tag: 'proxy',
        protocol: 'vless',
    });
    assert.deepEqual(out.outbounds.find((outbound) => outbound.tag === 'direct').settings, {
        domainStrategy: 'UseIPv4',
    });
    assert.ok(out.outbounds.some((outbound) => outbound.tag === 'dns-out' && outbound.protocol === 'dns'));
    assert.ok(out.routing.rules.some((rule) => rule.domain?.includes('geosite:category-ads-all') && rule.outboundTag === 'block'));
    assert.ok(out.routing.rules.some((rule) => rule.domain?.includes('geosite:ru') && rule.outboundTag === 'direct'));
    assert.ok(out.routing.rules.some((rule) => rule.port === '53' && rule.outboundTag === 'dns-out'));
    assert.ok(out.routing.rules.some((rule) => rule.network === 'tcp,udp' && rule.balancerTag === 'Europe-balancer'));
    assert.equal(out.routing.rules.some((rule) => rule.outboundTag === 'missing-outbound'), false);
    assert.equal(out.routing.rules.some((rule) => rule.balancerTag === 'old-balancer'), false);
});

test('buildGroupConfig emits prefix-safe node selectors and keeps system tags reserved', () => {
    const out = buildGroupConfig({}, 'Reserved tags', [
        { tag: 'node', protocol: 'vless' },
        { tag: 'node-backup', protocol: 'vless' },
        { tag: 'direct', protocol: 'vless' },
        { tag: 'block', protocol: 'vless' },
    ], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '1m',
        strategy: 'leastPing',
    });

    const selectors = out.routing.balancers[0].selector;
    const outboundTags = out.outbounds.map((outbound) => outbound.tag);
    for (const selector of selectors) {
        assert.deepEqual(outboundTags.filter((tag) => tag.startsWith(selector)), [selector]);
    }
    assert.equal(out.outbounds.find((item) => item.tag === 'direct').protocol, 'freedom');
    assert.equal(out.outbounds.find((item) => item.tag === 'block').protocol, 'blackhole');
    assert.equal(out.outbounds.find((item) => item.tag === 'proxy').protocol, 'vless');
});

test('buildGroupConfig moves a panel catch-all behind specialized routing rules', () => {
    const out = buildGroupConfig({
        routing: {
            rules: [
                { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' },
                { type: 'field', domain: ['geosite:ru'], outboundTag: 'direct' },
            ],
        },
    }, 'Routing order', [{ tag: 'node', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '1m',
        strategy: 'leastPing',
    });

    const ruIndex = out.routing.rules.findIndex((rule) => rule.domain?.includes('geosite:ru'));
    const catchAllIndex = out.routing.rules.findIndex((rule) => (
        rule.network === 'tcp,udp' && rule.balancerTag === 'Routing_order-balancer'
    ));
    assert.ok(ruIndex >= 0);
    assert.ok(catchAllIndex > ruIndex);
});

test('buildGroupConfig removes only redundant direct private geo rules', () => {
    const out = buildGroupConfig({
        routing: {
            rules: [
                { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
                { type: 'field', domain: ['geosite:private'], outboundTag: 'direct' },
                { type: 'field', domain: ['geosite:private'], outboundTag: 'block' },
                { type: 'field', domain: ['geosite:private', 'geosite:ru'], outboundTag: 'direct' },
            ],
        },
    }, 'Geo compatibility', [{ tag: 'node', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '1m',
        strategy: 'leastPing',
    });

    const serializedRules = JSON.stringify(out.routing.rules);
    assert.equal(out.routing.rules.some((rule) => (
        rule.outboundTag === 'direct' && rule.ip?.length === 1 && rule.ip[0] === 'geoip:private'
    )), false);
    assert.equal(out.routing.rules.some((rule) => (
        rule.outboundTag === 'direct' && rule.domain?.length === 1 && rule.domain[0] === 'geosite:private'
    )), false);
    assert.ok(out.routing.rules.some((rule) => (
        rule.outboundTag === 'block' && rule.domain?.includes('geosite:private')
    )));
    assert.ok(out.routing.rules.some((rule) => (
        rule.outboundTag === 'direct'
        && rule.domain?.includes('geosite:private')
        && rule.domain?.includes('geosite:ru')
    )));
    assert.match(serializedRules, /geosite:private/);
});

test('mergeProfileBaseConfigs merges DNS and routing policy from every upstream profile', () => {
    const merged = mergeProfileBaseConfigs([
        {
            routing: {
                domainStrategy: 'IPIfNonMatch',
                rules: [{ type: 'field', domain: ['geosite:ru'], outboundTag: 'direct' }],
            },
            outbounds: [{ tag: 'direct', protocol: 'freedom' }],
        },
        {
            dns: {
                servers: ['https://1.1.1.1/dns-query', { address: '8.8.8.8', domains: ['geosite:ru'] }],
                hosts: { 'domain:example.com': '127.0.0.1' },
                queryStrategy: 'UseIPv4',
            },
            routing: {
                rules: [{ type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' }],
            },
            outbounds: [
                { tag: 'block', protocol: 'blackhole' },
                { tag: 'dns-out', protocol: 'dns' },
            ],
        },
        {
            dns: {
                servers: ['https://1.1.1.1/dns-query', 'localhost'],
                hosts: { 'domain:internal.example': '10.0.0.1' },
                queryStrategy: 'UseIPv4',
            },
        },
    ]);

    assert.deepEqual(merged.dns.servers, [
        'https://1.1.1.1/dns-query',
        { address: '8.8.8.8', domains: ['geosite:ru'] },
        'localhost',
    ]);
    assert.deepEqual(merged.dns.hosts, {
        'domain:example.com': '127.0.0.1',
        'domain:internal.example': '10.0.0.1',
    });
    assert.equal(merged.routing.rules.length, 2);
    assert.deepEqual(merged.outbounds.map((outbound) => outbound.tag), ['direct', 'block', 'dns-out']);
});

test('mergeProfileBaseConfigs does not mix DNS servers with incompatible global policy', () => {
    const merged = mergeProfileBaseConfigs([
        { dns: { servers: ['1.1.1.1'], queryStrategy: 'UseIPv4' } },
        { dns: { servers: ['2001:4860:4860::8888'], queryStrategy: 'UseIPv6' } },
    ]);

    assert.deepEqual(merged.dns, {
        servers: ['1.1.1.1'],
        queryStrategy: 'UseIPv4',
    });
});

test('buildGroupConfig accepts custom burst observatory ping options', () => {
    const out = buildGroupConfig({}, 'Fastest', [{ tag: 'Main-1', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeConnectivity: 'https://example.com/connectivity',
        probeInterval: '30s',
        probeSampling: 3,
        probeTimeout: '5s',
        probeHttpMethod: 'GET',
        strategy: 'leastPing',
    });

    assert.deepEqual(out.burstObservatory.pingConfig, {
        destination: 'https://example.com/ping',
        connectivity: 'https://example.com/connectivity',
        interval: '30s',
        sampling: 3,
        timeout: '5s',
        httpMethod: 'GET',
    });
});

test('every observed balancer fallback resolves to a safe outbound', () => {
    for (const strategy of ['leastPing', 'leastLoad']) {
        for (const fallbackOutbounds of [
            [],
            [{ tag: 'Reserve-1', protocol: 'vless' }],
            [
                { tag: 'Reserve-1', protocol: 'vless' },
                { tag: 'Reserve-2', protocol: 'vless' },
            ],
        ]) {
            const out = buildGroupConfig({}, `${strategy}-group`, [
                { tag: 'Main-1', protocol: 'vless' },
                { tag: 'Main-2', protocol: 'vless' },
            ], {
                fallbackOutbounds,
                probeUrl: 'https://example.com/ping',
                probeInterval: '1m',
                strategy,
            });
            const outboundTags = new Set(out.outbounds.map((outbound) => outbound.tag));
            const outboundsByTag = new Map(out.outbounds.map((outbound) => [outbound.tag, outbound]));
            const balancerTags = new Set(out.routing.balancers.map((balancer) => balancer.tag));

            for (const balancer of out.routing.balancers) {
                assert.ok(balancer.fallbackTag, `${strategy} balancer must have fallbackTag`);
                assert.ok(outboundTags.has(balancer.fallbackTag), 'fallbackTag must resolve to an outbound');
                assert.equal(balancerTags.has(balancer.fallbackTag), false, 'fallbackTag must not resolve to a balancer');
                assert.notEqual(balancer.fallbackTag, 'direct', 'fallback must not leak traffic directly');
                assert.notEqual(balancer.fallbackTag, 'block', 'fallback must not silently block traffic');
                assert.notEqual(balancer.fallbackTag, out.outbounds[0].tag, 'fallback must resolve explicitly');
                assert.notEqual(outboundsByTag.get(balancer.fallbackTag).protocol, 'freedom');
                assert.notEqual(outboundsByTag.get(balancer.fallbackTag).protocol, 'blackhole');
            }
        }
    }
});

test('buildGroupConfig emits leastPing strategy without leastLoad settings', () => {
    const out = buildGroupConfig({}, 'Fastest ping', [
        { tag: 'Germany-1', protocol: 'vless' },
        { tag: 'Germany-2', protocol: 'vless' },
    ], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '1m',
        strategy: 'leastPing',
    });

    assert.deepEqual(out.burstObservatory.subjectSelector, ['__xrb_01__:Germany-1', '__xrb_02__:Germany-2']);
    assert.deepEqual(out.routing.balancers[0].strategy, { type: 'leastPing' });
    assert.equal(out.routing.balancers[0].fallbackTag, '__xrb_01__:Germany-1');
});

test('buildGroupConfig does not inherit per-server title/description fields from base config', () => {
    const base = {
        remarks: 'base',
        title: 'node-1 title',
        ps: 'node-1 ps',
        name: 'node-1 name',
        remark: 'node-1 remark',
        description: 'node-specific description',
        serverDescription: 'node-specific server description',
        server_description: 'node specific snake case description',
        extraField: { x: 1 },
    };

    const out = buildGroupConfig(base, '🇪🇺 Europe', [{ tag: 'Germany-1', protocol: 'vless', title: 'Germany-1 Title' }], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '3m',
        strategy: 'leastLoad',
    });

    assert.equal(out.title, undefined);
    assert.equal(out.ps, undefined);
    assert.equal(out.name, undefined);
    assert.equal(out.remark, undefined);
    assert.equal(out.description, undefined);
    assert.equal(out.serverDescription, undefined);
    assert.equal(out.server_description, undefined);
    assert.deepEqual(out.extraField, { x: 1 });
    assert.equal(out.outbounds[0].tag, 'proxy');
    assert.equal(out.outbounds[0].title, 'Germany-1 Title');
    assert.equal(out.outbounds[1].tag, '__xrb_01__:Germany-1');
});

test('buildGroupConfig applies custom groupDescription when provided in options', () => {
    const base = { remarks: 'base', description: 'node-specific description' };
    const out = buildGroupConfig(base, '🇪🇺 Europe', [{ tag: 'Germany-1', protocol: 'vless' }], {
        groupDescription: 'Кастомное описание группы Европа',
    });
    assert.equal(out.description, 'Кастомное описание группы Европа');
});

test('buildGroupConfig does not inherit stale observatory from base config', () => {
    const out = buildGroupConfig({
        observatory: { subjectSelector: ['old-node'] },
        burstObservatory: { subjectSelector: ['old-burst-node'] },
    }, 'Europe', [{ tag: 'Germany-1', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '3m',
        strategy: 'leastLoad',
    });

    assert.equal(out.observatory, undefined);
    assert.deepEqual(out.burstObservatory.subjectSelector, ['__xrb_01__:Germany-1']);
});

test('private destinations go direct before the QUIC block', () => {
    const out = buildGroupConfig({}, 'Group', [{ tag: 'Node-1', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '2m',
        strategy: 'leastPing',
    });
    const rules = out.routing.rules;
    const domainRule = rules.findIndex((rule) => rule.domain?.includes('domain:lan'));
    const ipRule = rules.findIndex((rule) => rule.ip?.includes('100.64.0.0/10'));
    const quicBlock = rules.findIndex((rule) => rule.network === 'udp' && rule.port === '443');
    assert.ok(domainRule >= 0 && ipRule >= 0 && quicBlock >= 0);
    assert.ok(domainRule < quicBlock && ipRule < quicBlock);
    for (const rule of rules) {
        for (const domain of rule.domain || []) assert.ok(!domain.includes('*'), `glob in ${domain}`);
    }
});

test('node DNS scoping trims unused node hosts only when configured', () => {
    const base = {
        dns: {
            hosts: {
                'a.nodes.example.com': '192.0.2.1',
                'b.nodes.example.com': '192.0.2.2',
                'sub.nodes.example.com': '192.0.2.3',
            },
        },
    };
    const outbounds = [{ tag: 'A', protocol: 'vless', settings: { vnext: [{ address: 'a.nodes.example.com', port: 443 }] } }];
    const opts = { probeUrl: 'https://example.com/ping', probeInterval: '2m', strategy: 'leastPing' };

    const untouched = buildGroupConfig(base, 'Group', outbounds, opts);
    assert.deepEqual(Object.keys(untouched.dns.hosts).sort(), Object.keys(base.dns.hosts).sort());

    const scoped = buildGroupConfig(base, 'Group', outbounds, {
        ...opts,
        nodeDnsScope: { serviceHostnames: ['SUB.nodes.example.com'], nodeDomainSuffixes: ['.nodes.example.com'] },
    });
    assert.deepEqual(Object.keys(scoped.dns.hosts).sort(), ['a.nodes.example.com', 'sub.nodes.example.com']);
});

test('Auto group defaults to leastLoad probing every two minutes', () => {
    const { applyFastestStability } = require('../lib/fastest-stability');
    const cfg = buildGroupConfig({}, 'Auto', [{ tag: 'A', protocol: 'vless' }, { tag: 'B', protocol: 'vless' }], {
        probeUrl: 'https://example.com/ping',
        probeInterval: '30s',
        strategy: 'leastPing',
    });
    applyFastestStability(cfg);
    assert.equal(cfg.burstObservatory.pingConfig.interval, '2m');
    assert.equal(cfg.routing.balancers[0].strategy.type, 'leastLoad');
});
