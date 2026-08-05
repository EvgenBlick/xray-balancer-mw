'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

function listenOnRandomPort(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(server.address().port);
        });
    });
}

async function getFreePort() {
    const server = net.createServer();
    const port = await listenOnRandomPort(server);
    await closeServer(server);
    return port;
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 50) {
    const deadline = Date.now() + timeoutMs;
    let lastValue = null;
    while (Date.now() < deadline) {
        lastValue = await predicate();
        if (lastValue) return lastValue;
        await wait(intervalMs);
    }
    throw new Error(`condition not met before timeout; last value: ${JSON.stringify(lastValue)}`);
}

async function waitForHealth(port, childState, getOutput) {
    const deadline = Date.now() + 5000;
    let lastError = null;
    while (Date.now() < deadline) {
        if (childState.exited) {
            throw new Error(`server exited early: ${childState.exitInfo}\n${getOutput()}`);
        }
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.status === 200) return;
        } catch (err) {
            lastError = err;
        }
        await wait(50);
    }
    throw new Error(`server did not become healthy: ${lastError ? lastError.message : 'timeout'}\n${getOutput()}`);
}

async function startBalancer(t, configOverrides = {}, envOverrides = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-balancer-'));
    const port = await getFreePort();
    const configPath = path.join(tempDir, 'config.json');
    const config = {
        port,
        sub_page_url: `http://127.0.0.1:${configOverrides.upstreamPort || 9}`,
        groups: { Germany: ['Germany'] },
        fastest_group: false,
        node_stats: false,
        cache_ttl_sec: 30,
        cache_stale_if_error_sec: 30,
        cache_max_entries: 100,
        rate_limit_per_minute: 1000,
        rate_limit_burst_10s: 1000,
        token_rate_limit_per_minute: 1000,
        token_rate_limit_burst_10s: 1000,
        admin_rate_limit_per_minute: 1000,
        admin_rate_limit_burst_10s: 1000,
        request_timeout_ms: 1000,
        ...configOverrides,
    };
    delete config.upstreamPort;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    let output = '';
    const childState = { exited: false, exitInfo: '' };
    const child = spawn(process.execPath, ['server.js'], {
        cwd: repoRoot,
        env: {
            ...process.env,
            CONFIG_PATH: configPath,
            CONFIG_RUNTIME_PATH: '',
            PORT: String(port),
            REMNAWAVE_URL: '',
            SUB_PAGE_URL: '',
            SUB_DOMAIN: '',
            PANEL_AUTH_COOKIE: '',
            NODE_STATS: 'false',
            API_TOKEN: '',
            ADMIN_TOKEN: 'integration-admin-token',
            CACHE_TTL_SEC: '',
            CACHE_STALE_IF_ERROR_SEC: '',
            CACHE_MAX_ENTRIES: '',
            RATE_LIMIT_PER_MINUTE: '',
            RATE_LIMIT_BURST_10S: '',
            TOKEN_RATE_LIMIT_PER_MINUTE: '',
            TOKEN_RATE_LIMIT_BURST_10S: '',
            REQUEST_TIMEOUT_MS: '',
            MAX_REDIRECTS: '',
            ...envOverrides,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    const collect = (chunk) => {
        output += chunk.toString();
        if (output.length > 20000) output = output.slice(-20000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('exit', (code, signal) => {
        childState.exited = true;
        childState.exitInfo = `code=${code} signal=${signal}`;
    });

    t.after(async () => {
        if (!childState.exited) {
            child.kill('SIGTERM');
            await Promise.race([
                new Promise((resolve) => child.once('exit', resolve)),
                wait(2000).then(() => child.kill('SIGKILL')),
            ]);
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    await waitForHealth(port, childState, () => output);
    return { port, baseUrl: `http://127.0.0.1:${port}`, output: () => output };
}

function validXrayPayload() {
    return JSON.stringify([
        {
            remarks: 'valid',
            outbounds: [
                {
                    protocol: 'vless',
                    tag: 'Germany-1',
                    settings: {
                        vnext: [
                            { address: 'node.example.com', port: 443 },
                        ],
                    },
                },
            ],
        },
    ]);
}

function rawRequest(port, payload) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(payload));
        let response = '';
        socket.setTimeout(5000, () => {
            socket.destroy();
            reject(new Error('raw request timed out'));
        });
        socket.on('data', (chunk) => {
            response += chunk.toString('latin1');
        });
        socket.on('end', () => resolve(response));
        socket.on('error', reject);
    });
}

test('health endpoint ignores malformed Host header', async (t) => {
    const balancer = await startBalancer(t);
    const response = await rawRequest(
        balancer.port,
        'GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n'
    );

    assert.match(response, /^HTTP\/1\.1 200 /);
    assert.match(response, /"status":"ok"/);
});

test('subscription endpoint uses single-flight fetch and fresh read-through cache', async (t) => {
    let upstreamHits = 0;
    let capturedHeaders = null;
    const upstream = http.createServer(async (req, res) => {
        upstreamHits += 1;
        capturedHeaders = req.headers;
        await wait(150);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': 'session=should-not-leak',
            'X-Upstream-Test': 'present',
        });
        res.end(validXrayPayload());
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const balancer = await startBalancer(t, { upstreamPort });
    const headers = {
        Authorization: 'Bearer secret',
        Cookie: 'sid=secret',
        'X-Admin-Token': 'secret-admin-token',
        'User-Agent': 'Happ/1.0',
    };

    const responses = await Promise.all([
        fetch(`${balancer.baseUrl}/tok123`, { headers }),
        fetch(`${balancer.baseUrl}/tok123`, { headers }),
        fetch(`${balancer.baseUrl}/tok123`, { headers }),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.text()));

    assert.equal(upstreamHits, 1);
    for (const response of responses) {
        assert.equal(response.status, 200);
        assert.match(response.headers.get('cache-control'), /no-store/);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(response.headers.get('x-upstream-test'), 'present');
    }
    assert.equal(JSON.parse(bodies[0]).length, 1);
    assert.equal(capturedHeaders.authorization, undefined);
    assert.equal(capturedHeaders.cookie, undefined);
    assert.equal(capturedHeaders['x-admin-token'], undefined);

    const cached = await fetch(`${balancer.baseUrl}/tok123`, { headers });
    assert.equal(cached.status, 200);
    assert.match(cached.headers.get('cache-control'), /no-store/);
    assert.equal(cached.headers.get('set-cookie'), null);
    assert.equal(upstreamHits, 1);

    const ready = await fetch(`${balancer.baseUrl}/ready`);
    assert.equal(ready.status, 200);
});

test('subscription cache and single-flight are isolated by client variant headers', async (t) => {
    let upstreamHits = 0;
    const upstream = http.createServer(async (req, res) => {
        upstreamHits += 1;
        await wait(50);
        const variant = req.headers['x-hwid'] || 'missing';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
            {
                remarks: 'valid',
                outbounds: [
                    {
                        protocol: 'vless',
                        tag: `Germany-${variant}`,
                        settings: { vnext: [{ address: 'node.example.com', port: 443 }] },
                    },
                ],
            },
        ]));
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const balancer = await startBalancer(t, { upstreamPort });
    const [firstA, firstB] = await Promise.all([
        fetch(`${balancer.baseUrl}/same-token`, { headers: { 'User-Agent': 'Happ/1.0', 'X-HWID': 'A' } }),
        fetch(`${balancer.baseUrl}/same-token`, { headers: { 'User-Agent': 'Happ/1.0', 'X-HWID': 'B' } }),
    ]);
    const bodyA = await firstA.text();
    const bodyB = await firstB.text();

    assert.equal(firstA.status, 200);
    assert.equal(firstB.status, 200);
    assert.match(bodyA, /Germany-A/);
    assert.match(bodyB, /Germany-B/);
    assert.equal(upstreamHits, 2);

    const secondA = await fetch(`${balancer.baseUrl}/same-token`, {
        headers: { 'User-Agent': 'Happ/1.0', 'X-HWID': 'A' },
    });
    assert.match(await secondA.text(), /Germany-A/);
    assert.equal(upstreamHits, 2);

    const noisyA = await fetch(`${balancer.baseUrl}/same-token`, {
        headers: {
            'User-Agent': 'Happ/1.0',
            'X-HWID': 'A',
            'Accept-Language': 'ru',
            'Sec-Fetch-Site': 'same-origin',
        },
    });
    assert.match(await noisyA.text(), /Germany-A/);
    assert.equal(upstreamHits, 2);
});

test('subscription endpoint rejects non-GET methods without hitting upstream', async (t) => {
    let upstreamHits = 0;
    const upstream = http.createServer((req, res) => {
        upstreamHits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(validXrayPayload());
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const balancer = await startBalancer(t, { upstreamPort });
    const response = await fetch(`${balancer.baseUrl}/tok123`, { method: 'POST' });
    const body = await response.json();

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(body.code, 'METHOD_NOT_ALLOWED');
    assert.equal(upstreamHits, 0);
});

test('trusted proxy client IP resolution ignores spoofed X-Forwarded-For prefix', async (t) => {
    let upstreamHits = 0;
    const upstream = http.createServer((req, res) => {
        upstreamHits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(validXrayPayload());
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const balancer = await startBalancer(
        t,
        {
            upstreamPort,
            rate_limit_per_minute: 100,
            rate_limit_burst_10s: 1,
        },
        { TRUST_X_FORWARDED_FOR: 'true' }
    );

    const first = await fetch(`${balancer.baseUrl}/xff-a`, {
        headers: { 'X-Forwarded-For': '1.1.1.1, 8.8.8.8' },
    });
    const second = await fetch(`${balancer.baseUrl}/xff-b`, {
        headers: { 'X-Forwarded-For': '2.2.2.2, 8.8.8.8' },
    });
    const secondBody = await second.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(secondBody.code, 'RATE_LIMITED');
    assert.equal(upstreamHits, 1);
});

test('admin groups can switch strategy at runtime and responses are no-store', async (t) => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(validXrayPayload());
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const balancer = await startBalancer(t, { upstreamPort, strategy: 'leastLoad' });
    const update = await fetch(`${balancer.baseUrl}/admin/groups`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': 'integration-admin-token',
        },
        body: JSON.stringify({ strategy: 'leastping' }),
    });
    const updateBody = await update.json();

    assert.equal(update.status, 200);
    assert.match(update.headers.get('cache-control'), /no-store/);
    assert.equal(updateBody.strategy, 'leastPing');

    const response = await fetch(`${balancer.baseUrl}/tok-strategy`, {
        headers: { 'User-Agent': 'Happ/1.0' },
    });
    const subscription = await response.json();

    assert.equal(response.status, 200);
    assert.equal(subscription[0].routing.balancers[0].strategy.type, 'leastPing');
    assert.equal(subscription[0].routing.balancers[0].strategy.settings, undefined);
});

test('admin endpoints enforce explicit method allow lists', async (t) => {
    let hostRequests = 0;
    const panel = http.createServer((req, res) => {
        if (req.url === '/api/hosts/') {
            hostRequests += 1;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                response: [
                    { remark: 'Germany Berlin 1', isDisabled: false },
                ],
            }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    });
    const panelPort = await listenOnRandomPort(panel);
    t.after(() => closeServer(panel));

    const balancer = await startBalancer(
        t,
        { remnawave_url: `http://127.0.0.1:${panelPort}` },
        { API_TOKEN: 'integration-api-token' }
    );
    const headers = { 'X-Admin-Token': 'integration-admin-token' };

    const refreshGet = await fetch(`${balancer.baseUrl}/admin/refresh-groups`, { headers });
    const refreshGetBody = await refreshGet.json();

    assert.equal(refreshGet.status, 405);
    assert.equal(refreshGet.headers.get('allow'), 'POST');
    assert.equal(refreshGetBody.code, 'METHOD_NOT_ALLOWED');
    assert.equal(hostRequests, 0);

    const debugPost = await fetch(`${balancer.baseUrl}/admin/debug/stats`, {
        method: 'POST',
        headers,
    });
    const debugPostBody = await debugPost.json();

    assert.equal(debugPost.status, 405);
    assert.equal(debugPost.headers.get('allow'), 'GET');
    assert.equal(debugPostBody.code, 'METHOD_NOT_ALLOWED');

    const refreshPost = await fetch(`${balancer.baseUrl}/admin/refresh-groups`, {
        method: 'POST',
        headers,
    });
    const refreshPostBody = await refreshPost.json();

    assert.equal(refreshPost.status, 200);
    assert.equal(refreshPostBody.status, 'ok');
    assert.equal(hostRequests, 1);
});

test('admin groups update invalidates subscription cache immediately', async (t) => {
    let upstreamHits = 0;
    const upstream = http.createServer((req, res) => {
        upstreamHits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(validXrayPayload());
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const balancer = await startBalancer(t, {
        upstreamPort,
        fastest_group: false,
        groups: { Germany: ['Germany'] },
        cache_ttl_sec: 300,
    });

    const headers = { 'User-Agent': 'Happ/1.0' };
    const first = await fetch(`${balancer.baseUrl}/tok-cache`, { headers });
    const firstBody = await first.json();

    assert.equal(first.status, 200);
    assert.equal(firstBody[0].remarks, 'Germany');
    assert.equal(upstreamHits, 1);

    const cachedBeforeUpdate = await fetch(`${balancer.baseUrl}/tok-cache`, { headers });
    const cachedBeforeUpdateBody = await cachedBeforeUpdate.json();

    assert.equal(cachedBeforeUpdate.status, 200);
    assert.equal(cachedBeforeUpdateBody[0].remarks, 'Germany');
    assert.equal(upstreamHits, 1);

    const update = await fetch(`${balancer.baseUrl}/admin/groups`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': 'integration-admin-token',
        },
        body: JSON.stringify({ groups: { France: ['Germany'] } }),
    });
    const updateBody = await update.json();

    assert.equal(update.status, 200);
    assert.deepEqual(Object.keys(updateBody.groups), ['France']);

    const afterUpdate = await fetch(`${balancer.baseUrl}/tok-cache`, { headers });
    const afterUpdateBody = await afterUpdate.json();

    assert.equal(afterUpdate.status, 200);
    assert.equal(afterUpdateBody[0].remarks, 'France');
    assert.equal(upstreamHits, 2);
});

test('warmup tokens cache processed subscription output', async (t) => {
    let upstreamHits = 0;
    const upstream = http.createServer((req, res) => {
        upstreamHits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(validXrayPayload());
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const balancer = await startBalancer(t, {
        upstreamPort,
        warmup_tokens: ['warm-token'],
        groups: { Germany: ['Germany'] },
        fastest_group: false,
        cache_ttl_sec: 300,
    });

    await waitFor(async () => {
        const ready = await fetch(`${balancer.baseUrl}/ready`);
        return ready.status === 200 && upstreamHits >= 1;
    }, 3000);

    const response = await fetch(`${balancer.baseUrl}/warm-token`, {
        headers: { 'User-Agent': 'Happ/1.0' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(upstreamHits, 1);
    assert.equal(body[0].remarks, 'Germany');
});

test('subscription endpoint enforces total upstream deadline', async (t) => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const chunks = [
            '[{"remarks":"slow","outbounds":[',
            '{"protocol":"vless","tag":"Germany-1","settings":{"vnext":[{"address":"node.example.com","port":443}]}}',
            ']}]',
        ];
        let index = 0;
        const timer = setInterval(() => {
            if (index >= chunks.length) {
                clearInterval(timer);
                res.end();
                return;
            }
            res.write(chunks[index]);
            index += 1;
        }, 70);
        res.on('close', () => clearInterval(timer));
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const balancer = await startBalancer(t, {
        upstreamPort,
        request_timeout_ms: 150,
        cache_ttl_sec: 1,
    });

    const started = Date.now();
    const response = await fetch(`${balancer.baseUrl}/slowtoken`);
    const body = await response.text();

    assert.equal(response.status, 502);
    assert.match(body, /Timeout/);
    assert.ok(Date.now() - started < 1000);
});

test('socket retry shares the original upstream deadline', async (t) => {
    let upstreamHits = 0;
    const upstream = http.createServer((req, res) => {
        upstreamHits += 1;
        if (upstreamHits === 1) {
            setTimeout(() => req.socket.destroy(), 150);
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        const timer = setTimeout(() => res.end(validXrayPayload()), 700);
        res.on('close', () => clearTimeout(timer));
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const balancer = await startBalancer(t, {
        upstreamPort,
        request_timeout_ms: 800,
        cache_ttl_sec: 1,
    });

    const started = Date.now();
    const response = await fetch(`${balancer.baseUrl}/retry-deadline`);
    const body = await response.text();

    assert.equal(response.status, 502);
    assert.match(body, /Timeout/);
    assert.equal(upstreamHits, 2);
    assert.ok(Date.now() - started < 1500);
});

test('background refresh loop skips overlapping auto-groups runs', async (t) => {
    let hostRequests = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const panel = http.createServer(async (req, res) => {
        if (req.url !== '/api/hosts/') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }

        hostRequests += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await wait(hostRequests === 1 ? 10 : 1500);
        inFlight -= 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            response: [
                { remark: 'Germany Berlin 1', isDisabled: false },
            ],
        }));
    });
    const panelPort = await listenOnRandomPort(panel);
    t.after(() => closeServer(panel));

    const balancer = await startBalancer(
        t,
        {
            remnawave_url: `http://127.0.0.1:${panelPort}`,
            auto_groups: true,
            auto_groups_interval_sec: 1,
            request_timeout_ms: 3000,
        },
        { API_TOKEN: 'integration-api-token' }
    );

    await wait(2600);
    const response = await fetch(`${balancer.baseUrl}/admin/debug/stats`, {
        headers: { 'X-Admin-Token': 'integration-admin-token' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.ok(body.runtime_stats.background_overlap_skipped_total >= 1);
    assert.equal(maxInFlight, 1);
});

test('startup health is not blocked by slow initial auto-groups refresh', async (t) => {
    let hostRequests = 0;
    const panel = http.createServer(async (req, res) => {
        if (req.url !== '/api/hosts/') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }

        hostRequests += 1;
        await wait(1500);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            response: [
                { remark: 'Germany Berlin 1', isDisabled: false },
            ],
        }));
    });
    const panelPort = await listenOnRandomPort(panel);
    t.after(() => closeServer(panel));

    const started = Date.now();
    const balancer = await startBalancer(
        t,
        {
            remnawave_url: `http://127.0.0.1:${panelPort}`,
            auto_groups: true,
            auto_groups_interval_sec: 30,
            request_timeout_ms: 3000,
        },
        { API_TOKEN: 'integration-api-token' }
    );
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 1200, `startup took ${elapsed}ms`);
    await waitFor(() => hostRequests >= 1, 1000);

    const health = await fetch(`${balancer.baseUrl}/health`);
    assert.equal(health.status, 200);
});

test('leastPing uses latency fields from panel node stats', async (t) => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
            {
                remarks: 'valid',
                outbounds: [
                    {
                        protocol: 'vless',
                        tag: 'Germany-A',
                        settings: { vnext: [{ address: 'a.example.com', port: 443 }] },
                    },
                    {
                        protocol: 'vless',
                        tag: 'Germany-B',
                        settings: { vnext: [{ address: 'b.example.com', port: 443 }] },
                    },
                ],
            },
        ]));
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const panel = http.createServer((req, res) => {
        if (req.url !== '/api/nodes/') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            response: [
                {
                    name: 'Germany-A',
                    address: 'a.example.com',
                    usersOnline: 0,
                    totalRam: '1GB',
                    cpuCount: 1,
                    ping_ms: 180,
                    isConnected: true,
                    isDisabled: false,
                },
                {
                    name: 'Germany-B',
                    address: 'b.example.com',
                    usersOnline: 20,
                    totalRam: '1GB',
                    cpuCount: 1,
                    ping_ms: 20,
                    isConnected: true,
                    isDisabled: false,
                },
            ],
        }));
    });
    const panelPort = await listenOnRandomPort(panel);
    t.after(() => closeServer(panel));

    const balancer = await startBalancer(
        t,
        {
            upstreamPort,
            remnawave_url: `http://127.0.0.1:${panelPort}`,
            strategy: 'leastPing',
            node_stats: true,
            node_stats_interval_sec: 30,
            request_timeout_ms: 1000,
        },
        {
            API_TOKEN: 'integration-api-token',
            NODE_STATS: 'true',
        }
    );

    await waitFor(async () => {
        const response = await fetch(`${balancer.baseUrl}/admin/debug/stats`, {
            headers: { 'X-Admin-Token': 'integration-admin-token' },
        });
        const body = await response.json();
        return body.cached_nodes >= 2 && body.node_stats_fresh ? body : null;
    }, 3000);

    const response = await fetch(`${balancer.baseUrl}/least-ping-token`, {
        headers: { 'User-Agent': 'Happ/1.0' },
    });
    const body = await response.json();
    const tags = body[0].outbounds
        .filter((outbound) => outbound.protocol === 'vless' && outbound.tag !== 'proxy')
        .map((outbound) => outbound.tag);

    assert.equal(response.status, 200);
    assert.deepEqual(tags, ['Germany-B', 'Germany-A']);
});

test('stale node stats do not influence subscription ordering', async (t) => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
            {
                remarks: 'valid',
                outbounds: [
                    {
                        protocol: 'vless',
                        tag: 'Germany-A',
                        settings: { vnext: [{ address: 'a.example.com', port: 443 }] },
                    },
                    {
                        protocol: 'vless',
                        tag: 'Germany-B',
                        settings: { vnext: [{ address: 'b.example.com', port: 443 }] },
                    },
                ],
            },
        ]));
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const panel = http.createServer((req, res) => {
        if (req.url !== '/api/nodes/') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            response: [
                {
                    name: 'Germany-A',
                    address: 'a.example.com',
                    usersOnline: 20,
                    totalRam: '1GB',
                    cpuCount: 1,
                    isConnected: true,
                    isDisabled: false,
                },
                {
                    name: 'Germany-B',
                    address: 'b.example.com',
                    usersOnline: 0,
                    totalRam: '1GB',
                    cpuCount: 1,
                    isConnected: true,
                    isDisabled: false,
                },
            ],
        }));
    });
    const panelPort = await listenOnRandomPort(panel);
    t.after(() => closeServer(panel));

    const balancer = await startBalancer(
        t,
        {
            upstreamPort,
            remnawave_url: `http://127.0.0.1:${panelPort}`,
            node_stats: true,
            node_stats_interval_sec: 30,
            node_stats_stale_sec: 1,
            request_timeout_ms: 1000,
        },
        {
            API_TOKEN: 'integration-api-token',
            NODE_STATS: 'true',
        }
    );

    await waitFor(async () => {
        const response = await fetch(`${balancer.baseUrl}/admin/debug/stats`, {
            headers: { 'X-Admin-Token': 'integration-admin-token' },
        });
        const body = await response.json();
        return body.cached_nodes >= 2 && body.node_stats_fresh ? body : null;
    }, 3000);

    await wait(1200);
    const debug = await fetch(`${balancer.baseUrl}/admin/debug/stats`, {
        headers: { 'X-Admin-Token': 'integration-admin-token' },
    });
    const debugBody = await debug.json();
    assert.equal(debug.status, 200);
    assert.equal(debugBody.node_stats_fresh, false);

    const response = await fetch(`${balancer.baseUrl}/stale-token`, {
        headers: { 'User-Agent': 'Happ/1.0' },
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.ok(body.indexOf('Germany-A') !== -1);
    assert.ok(body.indexOf('Germany-B') !== -1);
    assert.ok(body.indexOf('Germany-A') < body.indexOf('Germany-B'));
});

test('concurrent admin stats refreshes share one upstream request', async (t) => {
    let nodeRequests = 0;
    const panel = http.createServer(async (req, res) => {
        if (req.url !== '/api/nodes/') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }

        nodeRequests += 1;
        await wait(150);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            response: [
                {
                    name: 'Germany-A',
                    address: 'a.example.com',
                    usersOnline: 0,
                    totalRam: '1GB',
                    cpuCount: 1,
                    isConnected: true,
                    isDisabled: false,
                },
            ],
        }));
    });
    const panelPort = await listenOnRandomPort(panel);
    t.after(() => closeServer(panel));

    const balancer = await startBalancer(
        t,
        {
            remnawave_url: `http://127.0.0.1:${panelPort}`,
            request_timeout_ms: 1000,
        },
        { API_TOKEN: 'integration-api-token' }
    );

    const headers = { 'X-Admin-Token': 'integration-admin-token' };
    const [first, second] = await Promise.all([
        fetch(`${balancer.baseUrl}/admin/refresh-stats`, { method: 'POST', headers }),
        fetch(`${balancer.baseUrl}/admin/refresh-stats`, { method: 'POST', headers }),
    ]);
    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(firstBody.status, 'ok');
    assert.equal(secondBody.status, 'ok');
    assert.equal(nodeRequests, 1);
});

test('invalid NODE_STATS_STALE_SEC env falls back to positive default', async (t) => {
    const balancer = await startBalancer(
        t,
        { node_stats_interval_sec: 10 },
        { NODE_STATS_STALE_SEC: '-1' }
    );

    const response = await fetch(`${balancer.baseUrl}/admin/debug/stats`, {
        headers: { 'X-Admin-Token': 'integration-admin-token' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.node_stats_stale_sec, 300);
});

test('parallel quarantine updates are serialized without losing nodes', async (t) => {
    const balancer = await startBalancer(t);
    const headers = {
        'Content-Type': 'application/json',
        'X-Admin-Token': 'integration-admin-token',
    };

    const [first, second] = await Promise.all([
        fetch(`${balancer.baseUrl}/admin/quarantine`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ node: 'Node-A' }),
        }),
        fetch(`${balancer.baseUrl}/admin/quarantine`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ node: 'Node-B' }),
        }),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const response = await fetch(`${balancer.baseUrl}/admin/quarantine`, {
        headers: { 'X-Admin-Token': 'integration-admin-token' },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual([...body.quarantine_nodes].sort(), ['Node-A', 'Node-B']);
});

test('manual attack mode immediately excludes and restores a node', async (t) => {
    let upstreamHits = 0;
    const upstream = http.createServer((req, res) => {
        upstreamHits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{
            remarks: 'nodes',
            outbounds: [
                { tag: 'Germany-1', protocol: 'vless', settings: { vnext: [{ address: 'de1.example.com', port: 443 }] } },
                { tag: 'Germany-2', protocol: 'vless', settings: { vnext: [{ address: 'de2.example.com', port: 443 }] } },
            ],
        }]));
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));

    const balancer = await startBalancer(t, {
        upstreamPort,
        groups: { Germany: ['Germany'] },
        strategy: 'leastPing',
        sticky_enabled: true,
        sticky_mode: 'prefer',
        cache_ttl_sec: 60,
    });

    const first = await fetch(`${balancer.baseUrl}/attack-token`);
    assert.equal(first.status, 200);
    assert.match(await first.text(), /Germany-1/);

    const isolate = await fetch(`${balancer.baseUrl}/admin/attack-mode`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-admin-token': 'integration-admin-token',
        },
        body: JSON.stringify({ node: 'Germany-1', reason: 'ddos', ttl_sec: 300 }),
    });
    assert.equal(isolate.status, 200);
    const isolateBody = await isolate.json();
    assert.equal(isolateBody.node.state, 'isolated');
    assert.equal(isolateBody.node.isolation.reason, 'ddos');

    const protectedResponse = await fetch(`${balancer.baseUrl}/attack-token`);
    assert.equal(protectedResponse.status, 200);
    const protectedBody = await protectedResponse.text();
    assert.doesNotMatch(protectedBody, /Germany-1/);
    assert.match(protectedBody, /Germany-2/);
    assert.equal(upstreamHits, 2, 'attack transition must invalidate the subscription cache');

    const status = await fetch(`${balancer.baseUrl}/admin/attack-mode`, {
        headers: { 'x-admin-token': 'integration-admin-token' },
    });
    const statusBody = await status.json();
    assert.equal(statusBody.summary.protected, 1);
    assert.equal(statusBody.nodes[0].normalizedNode, 'germany-1');

    const release = await fetch(`${balancer.baseUrl}/admin/attack-mode/${encodeURIComponent('Germany-1')}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': 'integration-admin-token' },
    });
    assert.equal(release.status, 200);
    assert.equal((await release.json()).released, true);

    const restoredResponse = await fetch(`${balancer.baseUrl}/attack-token`);
    assert.equal(restoredResponse.status, 200);
    assert.match(await restoredResponse.text(), /Germany-1/);
    assert.equal(upstreamHits, 3);
});

test('subscription fails closed when every outbound is isolated', async (t) => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(validXrayPayload());
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));
    const balancer = await startBalancer(t, { upstreamPort });

    const isolate = await fetch(`${balancer.baseUrl}/admin/attack-mode`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-admin-token': 'integration-admin-token',
        },
        body: JSON.stringify({ node: 'Germany-1', ttl_sec: 300 }),
    });
    assert.equal(isolate.status, 200);

    const response = await fetch(`${balancer.baseUrl}/all-isolated`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'NO_HEALTHY_NODES');
});

test('automatic protection isolates a repeatedly disconnected node but preserves reserve capacity', async (t) => {
    const upstream = http.createServer((req, res) => {
        if (req.url === '/api/nodes/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ response: [
                { name: 'Germany-1', isConnected: false, isDisabled: false, usersOnline: 0, totalRam: '2 GB', cpuCount: 1 },
                { name: 'Germany-2', isConnected: true, isDisabled: false, usersOnline: 1, totalRam: '2 GB', cpuCount: 1 },
            ] }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{
            remarks: 'nodes',
            outbounds: [
                { tag: 'Germany-1', protocol: 'vless', settings: { vnext: [{ address: 'de1.example.com', port: 443 }] } },
                { tag: 'Germany-2', protocol: 'vless', settings: { vnext: [{ address: 'de2.example.com', port: 443 }] } },
            ],
        }]));
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));
    const balancer = await startBalancer(t, {
        upstreamPort,
        remnawave_url: `http://127.0.0.1:${upstreamPort}`,
        node_stats: true,
        node_stats_interval_sec: 30,
        protection_enabled: true,
        protection_failures: 2,
        protection_release_successes: 2,
        protection_isolation_ttl_sec: 60,
        protection_min_available_nodes: 1,
    }, {
        NODE_STATS: 'true',
        API_TOKEN: 'panel-token',
    });

    for (let i = 0; i < 2; i += 1) {
        const refresh = await fetch(`${balancer.baseUrl}/admin/refresh-stats`, {
            method: 'POST',
            headers: { 'x-admin-token': 'integration-admin-token' },
        });
        assert.equal(refresh.status, 200);
    }

    const attackStatus = await fetch(`${balancer.baseUrl}/admin/attack-mode`, {
        headers: { 'x-admin-token': 'integration-admin-token' },
    });
    const attackBody = await attackStatus.json();
    assert.equal(attackBody.summary.automatic, 1);
    assert.equal(attackBody.nodes[0].normalizedNode, 'germany-1');

    const response = await fetch(`${balancer.baseUrl}/auto-protection-token`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.doesNotMatch(body, /Germany-1/);
    assert.match(body, /Germany-2/);
});

test('normal groups receive a cross-group emergency fallback', async (t) => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{
            remarks: 'nodes',
            outbounds: [
                { tag: 'Germany-1', protocol: 'vless', settings: { vnext: [{ address: 'de.example.com', port: 443 }] } },
                { tag: 'Finland-1', protocol: 'vless', settings: { vnext: [{ address: 'fi.example.com', port: 443 }] } },
            ],
        }]));
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));
    const balancer = await startBalancer(t, {
        upstreamPort,
        strategy: 'leastPing',
        groups: { Germany: ['Germany'], Finland: ['Finland'] },
        emergency_fallback_enabled: true,
        emergency_fallback_max_nodes: 1,
    });

    const response = await fetch(`${balancer.baseUrl}/fallback-token`);
    assert.equal(response.status, 200);
    const configs = await response.json();
    const germany = configs.find((item) => item.remarks === 'Germany');
    assert.ok(germany);
    assert.equal(germany.routing.balancers[0].fallbackTag, 'Finland-1');
    assert.ok(germany.outbounds.some((outbound) => outbound.tag === 'Finland-1'));
});

test('negative subscription responses are cached briefly', async (t) => {
    let upstreamHits = 0;
    const upstream = http.createServer((req, res) => {
        upstreamHits += 1;
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('missing');
    });
    const upstreamPort = await listenOnRandomPort(upstream);
    t.after(() => closeServer(upstream));
    const balancer = await startBalancer(t, { upstreamPort, negative_cache_ttl_sec: 30 });

    const first = await fetch(`${balancer.baseUrl}/missing-token`);
    const second = await fetch(`${balancer.baseUrl}/missing-token`);
    assert.equal(first.status, 404);
    assert.equal(second.status, 404);
    assert.equal(await second.text(), 'missing');
    assert.equal(upstreamHits, 1);
});
