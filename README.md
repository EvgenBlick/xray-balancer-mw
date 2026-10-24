# Xray Balancer Middleware

Middleware для Remnawave, который превращает длинный список XRAY-JSON или MIHOMO YAML серверов в удобные группы и добавляет автоматический выбор лучших нод внутри каждой группы.

## Что делает

- Группирует сервера по странам или категориям.
- Создаёт группу `🏁 Самые быстрые` из доступных нод.
- Применяет названия групп из кабинета к MIHOMO-подпискам вместо исходных названий нод Remnawave.
- Может исключать группы из fastest-group.
- Может полностью скрывать группы или отдельные ноды из итоговой подписки.
- Может учитывать нагрузку нод из панели и убирать проблемные серверы.
- Поддерживает sticky-маршрутизацию, чтобы клиент не прыгал между нодами.
- Может автоматически изолировать недоступную ноду и выдать клиенту резервную.
- Поддерживает ручной режим «нода под атакой» с TTL.
- Не ломает заголовки subscription-page: `profile-title`, `announce`, `support-url` и другие заголовки Happ приходят клиенту как обычно.

## Что получает пользователь

Вместо такого списка:

```text
Germany 1, Germany 2, Germany 3, USA 1, USA 2, Finland 1...
```

Клиент видит:

```text
🏁 Самые быстрые
🇩🇪 Germany
🇺🇸 USA
🇫🇮 Finland
```

Каждая группа уже содержит пул серверов с балансировкой внутри.

Для MIHOMO middleware создаёт нативные `proxy-groups`. При стратегии `leastPing` группы используют `url-test`, а ноды, не совпавшие ни с одним шаблоном, помещаются в `🌐 Другие серверы`. Короткие шаблоны вроде `RU` проверяются только по видимому имени ноды, поэтому домен в зоне `.ru` не приводит к ошибочной группировке.

## Установка

### 1. Клонируй репозиторий

```bash
git clone https://github.com/PEDZEO/xray-balancer-mw.git
cd xray-balancer-mw
```

### 2. Создай `.env`

```bash
cp .env.example .env
```

Заполни минимум эти значения:

```env
REMNAWAVE_URL=https://panel.example.com
SUB_PAGE_URL=http://subscription-page:3010
SUB_DOMAIN=sub.example.com
API_TOKEN=your_api_token
ADMIN_TOKEN=change_this_admin_token
```

### 3. Создай `config.json`

```bash
cp config.json.example config.json
```

Минимальный пример:

```json
{
  "port": 4100,
  "strategy": "leastPing",
  "probe_interval": "30s",
  "probe_sampling": 1,
  "probe_timeout": "3s",
  "probe_url": "https://www.gstatic.com/generate_204",
  "fastest_probe_url": "https://ya.ru",
  "fastest_group": true,
  "fastest_group_name": "🏁 Самые быстрые",
  "fastest_exclude_groups": [],
  "fastest_fallback": [],
  "node_stats_exclude": [],
  "expand_groups_to_nodes": [],
  "hidden_groups": [],
  "hidden_nodes": [],
  "node_stats": true,
  "groups": {
    "🇩🇪 Germany": ["Germany", "German"],
    "🇺🇸 USA": ["USA", "United States"],
    "🇫🇮 Finland": ["Finland"]
  }
}
```

### 4. Запусти

```bash
docker compose up -d --build
```

## Резерв для fastest-группы (Xray)

Если часть нод предназначена для резервного доступа через другого оператора или маршрут, добавьте в их названия уникальный маркер, например `MOBILE-RESERVE`, и укажите соответствующую группу в `fastest_fallback`:

```json
{
  "strategy": "leastPing",
  "probe_interval": "30s",
  "probe_timeout": "3s",
  "fastest_group": true,
  "fastest_fallback": ["📱 LTE Reserve"],
  "groups": {
    "🇩🇪 Germany": ["Germany"],
    "📱 LTE Reserve": ["MOBILE-RESERVE"]
  }
}
```

Например, нода `Germany MOBILE-RESERVE #1` попадёт в резерв, а обычные Germany-ноды останутся в основном пуле. В профиле `🏁 Самые быстрые` Xray использует резерв через `fallbackTag`, только когда `burstObservatory` признает все основные ноды недоступными.

Основной пул fastest-профиля балансируется через `leastLoad`: по умолчанию ноды проверяются раз в 2 минуты (`probe_interval: "2m"`), `probe_timeout: "4s"`, `max_rtt: "1500ms"`, `tolerance: 0.25`. Эти значения задаются блоком `fastest_stability` (через `PUT /admin/groups` вместе с `settings_revision`) и не зависят от `strategy`/`probe_interval` обычных групп.

Это проверка доступности, а не определение типа сети устройства. Переключение зависит от `probe_interval`, `probe_timeout` и результатов проверки; существующим соединениям может потребоваться переподключение. Настройка применяется к выдаваемому middleware XRAY-JSON. Для нативных Sing-box-профилей нужен отдельный шаблон Sing-box.

## Reverse Proxy и шаблоны Remnawave

### Как проходит запрос

```text
Клиент -> Caddy/nginx -> xray-balancer-mw:4100 -> Remnawave subscription-page:3010
                    \-> subscription-page:3010 напрямую для браузера и других форматов
```

- Happ, Incy и другие Xray-клиенты должны получить `XRAY_JSON` через middleware.
- Mihomo-совместимые клиенты должны получить `MIHOMO` YAML через middleware.
- Браузер, Stash, Sing-box и неизвестные клиенты идут напрямую в subscription-page.
- Публичный путь подписки должен оставаться `https://sub.example.com/TOKEN`. Не добавляйте к нему `/json`, `/mihomo` или другой суффикс: middleware принимает `/TOKEN` и `/sub/TOKEN`.
- `/admin/*` нельзя публиковать наружу. Кабинет должен обращаться к нему по Docker-сети с `x-admin-token`.

### Docker-сеть и доверенный proxy

Caddy/nginx, middleware и subscription-page должны находиться в одной Docker-сети, например `remnawave-network`. Узнать её CIDR:

```bash
docker network inspect remnawave-network \
  --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

Для сети `172.18.0.0/16` настройте `.env` так:

```env
SUB_PAGE_URL=http://remnawave-subscription-page:3010
SUB_DOMAIN=sub.example.com
TRUST_X_FORWARDED_FOR=true
TRUSTED_PROXY_CIDRS=172.18.0.0/16
```

`TRUSTED_PROXY_CIDRS` содержит адрес или CIDR **непосредственного reverse proxy**, а не адреса клиентов. Не используйте `0.0.0.0/0`, `::/0` или все приватные сети сразу. Строгий вариант — назначить контейнеру proxy статический IP и доверять только ему через `/32`; практичный вариант для отдельной Docker-сети — доверять CIDR этой сети.

Если `TRUST_X_FORWARDED_FOR=false`, подписки продолжат работать, но IP rate limiter будет видеть всех пользователей как один адрес reverse proxy.

### Готовый Caddyfile

Полная версия находится в [`examples/Caddyfile`](./examples/Caddyfile). Минимальная рабочая конфигурация:

```caddyfile
{
    servers {
        protocols h1 h2 h3
    }
}

https://sub.example.com {
    encode zstd gzip

    @admin path /admin /admin/*
    handle @admin {
        respond "Not Found" 404
    }

    handle /mw-health {
        rewrite * /health
        reverse_proxy xray-balancer-mw:4100
    }

    @balanced_client {
        header_regexp User-Agent (?i)^(happ|incy|v2plus|streisand|foxray|v2box|v2rayn|v2raytun|invisibleman|xray|flclash|flowvy|clash-verge|koala-clash|clash-?meta|murge|clashx[[:space:]]meta|mihomo|clash-nyanpasu|clash[.]meta|prizrak-box)
    }

    handle @balanced_client {
        reverse_proxy xray-balancer-mw:4100 {
            header_up Host {host}
            header_up X-Real-IP {client_ip}
            header_up X-Forwarded-For {client_ip}
            transport http {
                dial_timeout 3s
                response_header_timeout 15s
            }
        }
    }

    handle {
        reverse_proxy remnawave-subscription-page:3010 {
            header_up Host {host}
            header_up X-Real-IP {client_ip}
            header_up X-Forwarded-For {client_ip}
        }
    }
}
```

Caddy по умолчанию защищает `X-Forwarded-*` от прямой подмены клиентом. Если перед Caddy стоит CDN, задайте его актуальные CIDR через глобальный `servers.trusted_proxies`, включите `trusted_proxies_strict` и только после этого используйте `{client_ip}`. Подробнее: [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) и [trusted_proxies](https://caddyserver.com/docs/caddyfile/options#trusted-proxies).

Проверка и reload:

```bash
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

### Готовый nginx.conf

Полная версия находится в [`examples/nginx.conf`](./examples/nginx.conf). Блоки `upstream` и `map` размещаются внутри `http {}`, а `server` — рядом с остальными virtual hosts:

```nginx
upstream remnawave_subscription_page {
    server remnawave-subscription-page:3010;
}

upstream xray_balancer_mw {
    server xray-balancer-mw:4100;
}

map $http_user_agent $subscription_upstream {
    default remnawave_subscription_page;
    ~*^(?:happ|incy|v2plus|streisand|foxray|v2box|v2rayn|v2raytun|invisibleman|xray) xray_balancer_mw;
    ~*^(?:flclash|flowvy|clash-verge|koala-clash|clash-?meta|murge|clashx[[:space:]]meta|mihomo|clash-nyanpasu|clash\.meta|prizrak-box) xray_balancer_mw;
}

server {
    listen 443 ssl;
    http2 on;
    server_name sub.example.com;

    location = /admin { return 404; }
    location ^~ /admin/ { return 404; }

    location = /mw-health {
        proxy_pass http://xray_balancer_mw/health;
    }

    location / {
        proxy_http_version 1.1;
        proxy_pass http://$subscription_upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host $host;
        proxy_connect_timeout 3s;
        proxy_send_timeout 15s;
        proxy_read_timeout 15s;
    }

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
}
```

Здесь `X-Forwarded-For` заменяется значением `$remote_addr`, а не дополняется через `$proxy_add_x_forwarded_for`, поэтому клиент не может передать поддельный префикс. Если перед nginx есть CDN, сначала настройте `real_ip_header` и `set_real_ip_from` только для официальных CIDR провайдера. Подробнее: [nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

Проверка и reload:

```bash
docker exec nginx nginx -t
docker exec nginx nginx -s reload
```

### Subscription Response Rules

Правила Remnawave проверяются сверху вниз и обработка прекращается на первом совпадении. Готовый файл для импорта: [`examples/response-rules.json`](./examples/response-rules.json).

Порядок должен быть таким:

1. `Browser Subscription` -> `BROWSER`.
2. Mihomo-клиенты -> `MIHOMO`.
3. Stash -> `STASH`.
4. Sing-box -> `SINGBOX`.
5. Happ / Incy / Xray-клиенты -> `XRAY_JSON`.
6. Старый Clash Core -> `CLASH`.
7. Пустой fallback без условий -> `XRAY_BASE64`.

Критические правила для middleware:

```json
{
  "name": "Mihomo Clients",
  "enabled": true,
  "operator": "AND",
  "conditions": [
    {
      "headerName": "user-agent",
      "operator": "REGEX",
      "value": "^(?:FlClashX?|Flowvy|Murge|Mihomo|prizrak-box|Koala-Clash|Clash(?:-Verge|-Nyanpasu|X Meta|[-.]?Meta))",
      "caseSensitive": false
    }
  ],
  "responseType": "MIHOMO"
}
```

```json
{
  "name": "Happ / Incy / Xray JSON Clients",
  "enabled": true,
  "operator": "AND",
  "conditions": [
    {
      "headerName": "user-agent",
      "operator": "REGEX",
      "value": "^(?:Happ|Incy|v2plus|Streisand|FoXray|V2Box|V2rayN|V2RayTUN|InvisibleMan|Xray)",
      "caseSensitive": false
    }
  ],
  "responseType": "XRAY_JSON"
}
```

Если нужно принудительно выбрать конкретный шаблон, добавьте в правило имя, которое **точно совпадает** с именем шаблона в панели:

```json
"responseModifications": {
  "subscriptionTemplate": "Balancer Xray"
}
```

Без этого поля Remnawave использует шаблон хоста или шаблон по умолчанию. Не включайте `ignoreHostXrayJsonTemplate`, если хосты используют разные transport-параметры. Официальное описание: [Remnawave Response Rules](https://docs.rw/learn-en/routing-rules/).

### Что требуется от шаблонов

**XRAY_JSON:** используйте обычный рабочий Xray JSON template Remnawave. Сгенерированный ответ должен быть JSON-массивом конфигов, а каждый конфиг должен содержать хотя бы один реальный proxy outbound. `dns`, специализированные `routing.rules`, `direct`, `block` и DNS outbound можно оставить: middleware объединяет совместимые DNS-настройки и правила всех конфигов, а общий proxy/catch-all перенаправляет в созданный balancer. Привязка групп выполняется по UUID хоста из панели и не зависит от его отображаемого имени.

**MIHOMO:** используйте штатный Mihomo template, который выдаёт YAML с массивами `proxies` и `proxy-groups`. Специальные группы балансировщика в шаблон добавлять не нужно: middleware создаст `url-test`, `fallback` или `load-balance` группы сам и сохранит остальные route-группы и rules. Sing-box JSON этим middleware пока не перестраивается, поэтому Sing-box должен идти напрямую в subscription-page.

Подробнее о форматах: [Remnawave Templates](https://docs.rw/learn-en/templates/).

### Reality и `minClientVer`

Если Reality-нода работает в Xray-клиентах, но даёт `timeout` в Mihomo, проверьте **server-side Config Profile ноды**. Для совместимости можно явно добавить `minClientVer: "0"` в `streamSettings.realitySettings` каждого Reality inbound:

```json
{
  "streamSettings": {
    "security": "reality",
    "realitySettings": {
      "target": "example.com:443",
      "privateKey": "REPLACE_ME",
      "serverNames": ["example.com"],
      "shortIds": ["REPLACE_ME"],
      "minClientVer": "0"
    }
  }
}
```

Это поле добавляется не в Mihomo/Xray subscription template, а в профиль Xray на сервере. В актуальном Xray значение по умолчанию ограничивает минимальную версию Xray-клиента; снижение до `0` разрешает не-Xray реализации Reality, но ослабляет эту проверку и может менять заметность TLS fingerprint. Применяйте настройку только к нодам с подтверждённой несовместимостью. См. [Xray REALITY](https://xtls.github.io/en/config/transports/reality.html).

### Проверка всей цепочки

```bash
# Middleware жив и доступен reverse proxy
curl -fsS https://sub.example.com/mw-health

# Xray JSON: ответ должен начинаться с JSON-массива
curl -fsS -A 'Happ/3.10.0' https://sub.example.com/YOUR_TOKEN | jq 'type'

# Mihomo: в ответе должны быть proxies и proxy-groups
curl -fsS -A 'Mihomo/1.19.0' https://sub.example.com/YOUR_TOKEN \
  | grep -E '^(proxies|proxy-groups):'

# Браузер должен получить HTML subscription-page, а не JSON/YAML
curl -fsS -A 'Mozilla/5.0' -H 'Accept: text/html' \
  https://sub.example.com/YOUR_TOKEN | head
```

Название профиля в Happ задаётся на стороне Remnawave через `profile-title`. Middleware не заменяет служебные заголовки subscription-page, а пробрасывает их клиенту.

## Полезные настройки

### Исключить группу только из fastest-group

```json
{
  "fastest_exclude_groups": ["🇷🇺 YouTube / Instagram"]
}
```

### Полностью скрыть группу из подписки

```json
{
  "hidden_groups": ["🇺🇸 USA"]
}
```

### Использовать группу как fallback для fastest-group

```json
{
  "fastest_fallback": ["📱 LTE Reserve"]
}
```

### Не фильтровать группу через node_stats

```json
{
  "node_stats_exclude": ["📱 LTE Reserve"]
}
```

### Показывать серверы группы отдельно

```json
{
  "expand_groups_to_nodes": ["🇩🇪 Germany"]
}
```

### Полностью скрыть конкретную ноду

```json
{
  "hidden_nodes": ["Germany-3"]
}
```

### Привязать DNS-записи нод к профилям

Если в шаблоне есть `dns.hosts` для доменов нод, каждый профиль может получать только записи тех нод, которые в нём используются. Сервисные домены не трогаются, а профили, где есть только исключённые адреса (например, LTE/CDN-мосты), остаются без изменений. По умолчанию выключено.

```json
{
  "node_dns_scope": {
    "service_hostnames": ["sub.example.com", "panel.example.com"],
    "node_domain_suffixes": [".example.com"],
    "excluded_endpoints": ["lte.example.net"]
  }
}
```

### Включить sticky

```json
{
  "sticky_enabled": true,
  "sticky_mode": "prefer",
  "sticky_ttl_sec": 300
}
```

### Включить защитный failover

```json
{
  "node_stats": true,
  "node_stats_interval_sec": 30,
  "protection_enabled": true,
  "protection_failures": 2,
  "protection_release_successes": 3,
  "protection_isolation_ttl_sec": 300,
  "protection_latency_threshold_ms": 1500,
  "protection_min_available_nodes": 1,
  "emergency_fallback_enabled": true,
  "emergency_fallback_max_nodes": 1,
  "sticky_enabled": true,
  "sticky_mode": "prefer"
}
```

Высокая задержка сама по себе не доказывает DDoS. Автоматическая защита использует несколько последовательных проверок, сохраняет минимум одну доступную ноду и возвращает изолированную ноду только после TTL и успешного восстановления.

Ручная изоляция на 30 минут:

```bash
curl -X POST http://xray-balancer-mw:4100/admin/attack-mode \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  --data '{"node":"Germany-1","reason":"ddos","ttl_sec":1800}'
```

Обычные HTTP CDN защищают домен подписки, но не произвольный Reality/TCP/UDP-трафик. Для IP VPN-нод всё равно требуется anti-DDoS со стороны хостинг-провайдера.

## Проверка

```bash
docker compose exec xray-balancer-mw wget -qO- http://localhost:4100/health
docker compose exec xray-balancer-mw wget -qO- http://localhost:4100/ready
```

## Happ Headers

Если в Remnawave / subscription-page у тебя настроены Happ-заголовки, middleware их не ломает.

Сюда относятся:
- `profile-title`
- `announce`
- `support-url`
- другие заголовки Happ из subscription-page

То есть название профиля, ссылки и служебные поля для Happ нужно задавать в панели или subscription-page, а не в `config.json` балансера.

Если хочешь посмотреть, что реально получает клиент:

```bash
curl -s -H "User-Agent: Happ/3.10.0" https://sub.example.com/YOUR_TOKEN | jq '.[].remarks'
```

## Файлы проекта

- `.env` — секреты и адреса сервисов
- `config.json` — основные настройки middleware
- `runtime/config.runtime.json` — runtime-изменения, если меняешь группы через admin API

## Лицензия

См. [LICENSE](./LICENSE).
