# Xray Balancer Middleware

Middleware для Remnawave, который превращает длинный список XRAY-JSON серверов в удобные группы и добавляет автоматический выбор лучших нод внутри каждой группы.

## Что делает

- Группирует сервера по странам или категориям.
- Создаёт группу `🏁 Самые быстрые` из доступных нод.
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

## Автопереключение Wi-Fi / LTE (Fallback)

Если у вас есть отдельный хост или группа нод под мобильные сети (LTE), укажите эту группу в `fastest_fallback`:

```json
{
  "fastest_group": true,
  "fastest_fallback": ["📱 LTE Special"],
  "groups": {
    "🇩🇪 Germany": ["Germany"],
    "📱 LTE Special": ["LTE"]
  }
}
```

Клиент в группе `🏁 Самые быстрые` будет использовать основные ноды (Wi-Fi). При смене сети на LTE или при блокировке Wi-Fi нод провайдером ядро Xray/Sing-box на устройстве клиента мгновенно переключает трафик на fallback-ноды из группы `📱 LTE Special` через встроенный `fallbackTag` и `burstObservatory`.

## Reverse Proxy

Обычно middleware ставят перед subscription-page и отправляют в него только xray-клиентов.

Важно: название профиля в Happ задаётся на стороне Remnawave subscription-page или панели через `profile-title`. Middleware эти заголовки не заменяет, а просто пробрасывает клиенту.

Пример для Caddy:

```caddyfile
https://sub.example.com {
    @xray_client {
        header_regexp User-Agent (?i)(happ|incy|v2plus|streisand|v2ray|v2raytun|neko|foxray|v2box|xray|invisibleman)
    }

    handle @xray_client {
        reverse_proxy xray-balancer-mw:4100
    }

    handle /* {
        reverse_proxy subscription-page:3010
    }
}
```

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
  "fastest_fallback": ["🇪🇺 Europe LTE"]
}
```

### Не фильтровать группу через node_stats

```json
{
  "node_stats_exclude": ["🇪🇺 Europe LTE"]
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
