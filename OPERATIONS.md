# Operations Runbook

## Readiness
- `GET /ready` returns `ready` when recent upstream success exists or cache has fresh data.
- A fresh restart can return `503 not_ready` until the first successful subscription request or warmup token succeeds. Use `/health` for liveness checks.
- If `not_ready`: check upstream connectivity, API token, and configure `warmup_tokens` for known critical subscriptions.

## Admin Endpoints
All endpoints below require `x-admin-token` header:
- `GET /admin/node-stats`
- `POST /admin/refresh-stats`
- `POST /admin/refresh-groups`
- `GET /admin/debug/stats`
- `GET /admin/debug/token/{token}`
- `/admin/groups` (`GET` current runtime groups, `PUT` update/persist groups and mutable settings)
- `/admin/quarantine` (`GET` list, `POST` add `{ "node": "name" }`)
- `/admin/quarantine/{node}` (`DELETE` remove)
- `/admin/attack-mode` (`GET` state, `POST` isolate `{ "node": "name", "reason": "ddos", "ttl_sec": 1800 }`)
- `/admin/attack-mode/{node}` (`DELETE` release)

Admin endpoints are also rate-limited (`admin_rate_limit_per_minute`, `admin_rate_limit_burst_10s`).

## Runtime Persistence
- Keep base `config.json` mounted read-only.
- Persist admin UI changes (`groups`, `fastest_*`, `quarantine_nodes`) into `CONFIG_RUNTIME_PATH`.
- Recommended compose mount:
  - `CONFIG_RUNTIME_PATH=/app/runtime/config.runtime.json`
  - named volume `xray-balancer-runtime:/app/runtime`
- If you use a bind mount such as `./runtime:/app/runtime`, ensure it is writable by the container `node` user. Otherwise admin changes apply only until restart or fail with `CONFIG_PERSIST_FAILED`.
- Runtime patch values override base `config.json` on restart. Before migrations, inspect and backup `runtime/config.runtime.json`; update stale keys through the admin API or remove them intentionally.

## Token Rotation
1. Generate a new token.
2. Update `admin_token` in `config.json`.
3. Restart middleware container.
4. Verify `/admin/debug/stats` with new token.

## Common Incidents
### Frequent 502 or upstream timeouts
- Check `/admin/debug/stats` for circuit status.
- Increase `request_timeout_ms` in config.
- Ensure `profile_mode` is not too aggressive.

### Users are flapping between nodes in fastest-group
- Enable `sticky_enabled: true`.
- Start with `sticky_ttl_sec: 1800` or `3600`.
- Check `/admin/debug/token/{token}` to see `sticky.assigned_node`.
- Check `/admin/debug/stats` for `sticky_assignments_total` and `sticky_hits_total`.

### Massive request bursts
- Tighten `rate_limit_per_minute` and `token_rate_limit_per_minute`.
- Check logs for `rate_limited` and `token_rate_limited` events.
- For admin abuse/bruteforce, lower `admin_rate_limit_per_minute`.

### All clients appear as one IP behind proxy
- Set `trust_x_forwarded_for: true` only when middleware is behind your trusted reverse proxy.
- X-Forwarded-For is accepted only from loopback/private reverse-proxy addresses. If middleware is exposed directly, keep `trust_x_forwarded_for: false`.
- For nginx, prefer `proxy_set_header X-Forwarded-For $remote_addr;` instead of appending `$proxy_add_x_forwarded_for`; the middleware resolves proxy chains from right to left, but replacing the header avoids preserving spoofed client prefixes.

### Wrong grouping or fallback to `Other`
- Adjust `groups` patterns.
- Use `/admin/debug/token/{token}` to inspect payload type and cache behavior.

### Need to isolate a broken node quickly
- Add node to quarantine via `/admin/quarantine`.
- Verify `quarantine_count` in `/admin/quarantine` or `/admin/debug/stats`.
- Remove when node is healthy again.

### Node is under attack
- Prefer `/admin/attack-mode` over permanent quarantine: it records a reason and expiry.
- Isolation immediately clears subscription cache and sticky assignments for the node.
- Existing client connections are not migrated; after disconnect, Xray selects an observed reserve outbound.
- If every outbound is unavailable, middleware returns `503 NO_HEALTHY_NODES` and does not fail open to the raw subscription.
- Keep `sticky_mode: prefer`; `pin` removes client-side reserve outbounds.

## DDoS Boundary
- Middleware provides failover and control-plane load shedding, not packet scrubbing.
- Put the HTTPS subscription domain behind a CDN/WAF and restrict the origin where possible.
- Use provider L3/L4 anti-DDoS for Reality/TCP/UDP node addresses.
- Keep reserve nodes in a different provider or ASN and verify spare capacity before enabling automatic isolation.

## Safe Defaults
- `profile_mode: stable`
- `cache_ttl_sec: 600`
- `cache_stale_if_error_sec: 3600`
- `admin_token` set and rotated periodically
