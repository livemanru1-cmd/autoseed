# Setup Guide

## 1. Frontend: GitHub Pages

### GitHub secret

Создайте в репозитории secret `AUTOSEED_RUNTIME_CONFIG_JSON` со значением:

```json
{
  "app": {
    "title": "BSS AutoConnect",
    "pollIntervalMs": 180000,
    "debugLogLimit": 80
  },
  "policy": {
    "timezone": "Europe/Moscow",
    "nightWindowStart": "23:00",
    "nightWindowEnd": "08:00",
    "nightPreferredServerId": 1,
    "maxSeedPlayers": 80,
    "priorityOrder": [1, 2, 4],
    "switchDelta": 10,
    "cooldownMs": 600000
  },
  "exporters": [
    {
      "name": "classic",
      "baseUrl": "https://classic-autoseed.example.com"
    },
    {
      "name": "specops",
      "baseUrl": "https://specops-autoseed.example.com"
    }
  ]
}
```

Если сайт публикуется не из корня домена, добавьте repository variable `VITE_BASE_PATH`, например `/autoseed/`.

### Важно

Этот JSON попадает в публичный frontend bundle. Никаких приватных ключей, auth token и SSH-данных туда класть нельзя.

## 2. SquadJS: пример exporter-плагина

Теперь exporter не должен поднимать auth routes и не должен знать ничего о конкретном пользователе.

Пример блока в `config.json`:

```json
{
  "plugin": "AutoseedExporter",
  "enabled": true,
  "listenHost": "0.0.0.0",
  "listenPort": 32080,
  "pathPrefix": "/v1/autoseed",
  "serverId": 1,
  "serverCode": "srv-1",
  "isSeedCandidate": true,
  "publicConnectHost": "${SQUAD_PUBLIC_HOST}",
  "publicConnectPort": "${SQUAD_PUBLIC_PORT}",
  "corsOrigins": ["*"],
  "snapshotRefreshIntervalMs": 20000,
  "staleAfterMs": 90000,
  "rateLimitWindowMs": 60000,
  "rateLimitMaxRequests": 120,
  "timezone": "Europe/Moscow",
  "nightWindowStart": "23:00",
  "nightWindowEnd": "08:00",
  "nightPreferredServerId": 1,
  "priorityOrder": [1, 2, 4],
  "maxSeedPlayers": 80,
  "switchDelta": 10
}
```

Если SquadJS запускается через текущий `docker-entrypoint.sh`, то `config/$INSTANCE_NAME.json` проходит через `envsubst`. Для exporter-а удобно держать отдельно:

- `SQUAD_HOST`: адрес, куда сам SquadJS ходит за A2S/RCON.
- `SQUAD_PUBLIC_HOST`: публичный IP/домен, который пойдёт в `steam://connect/...`.
- `SQUAD_PUBLIC_PORT`: публичный connect-port сервера Squad.

## 3. Что менять при переносе на другие IP и серверы

### Меняется во frontend secret

- `exporters[].baseUrl`
- `policy.priorityOrder`
- `policy.nightPreferredServerId`
- `policy.maxSeedPlayers`
- `policy.switchDelta`
- `policy.cooldownMs`

### Меняется на каждом сервере SquadJS

- `serverId`
- `serverCode`
- `publicConnectHost`
- `publicConnectPort`
- `corsOrigins`
- `timezone`
- `nightWindowStart`
- `nightWindowEnd`
- `nightPreferredServerId`
- `priorityOrder`
- `maxSeedPlayers`
- `switchDelta`

## 4. Текущие значения BSS

На текущий момент для BSS публичные connect-адреса такие:

- `squadjs1` / `[RU] МирДружбаЖвачка ★ BSS ★ [КЛАССИКА]` -> `80.242.59.123:7800`
- `squadjs2` / `[RU] МирДружбаЖвачка ★ BSS ★ [SPEC OPS]` -> `80.242.59.123:7801`

При этом в SquadJS-конфигах `queryPort` остаётся `7810` и `7811`. Это нормально: `queryPort` и публичный connect-port могут не совпадать, поэтому `joinLink` должен собираться именно из `SQUAD_PUBLIC_HOST` и `SQUAD_PUBLIC_PORT`.

## 5. Готовые сервисы для Dokploy

Ниже готовый compose-совместимый пример, построенный по вашему текущему шаблону.

### Вариант через reverse proxy Dokploy

```yaml
services:
  squadjs1:
    image: ghcr.io/breaking-squad/squadjs:master
    pull_policy: always
    restart: unless-stopped
    volumes:
      - /opt/squad1/SquadGame/Saved/Logs:/data/logs:ro
      - /opt/configs/squad1:/data/configs:ro
    networks:
      - dokploy-network
    environment:
      INSTANCE_NAME: squad1
      SQUADJS_DISCORD_TOKEN: ${SQUADJS_DISCORD_TOKEN}
      SQUAD_HOST: ${SQUAD1_HOST}
      SQUAD_PUBLIC_HOST: 80.242.59.123
      SQUAD_PUBLIC_PORT: 7800
      SQUAD_RCON_PASSWORD: ${SQUAD1_RCON_PASSWORD}
      MYSQL_HOST: ${MYSQL_HOST}
      MYSQL_PORT: ${MYSQL_PORT}
      MYSQL_USERNAME: ${MYSQL_USERNAME}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
      MYSQL_DATABASE: ${MYSQL_DATABASE}
      MONGO_URI: ${MONGO_URI}

  squadjs2:
    image: ghcr.io/breaking-squad/squadjs:master
    pull_policy: always
    restart: unless-stopped
    volumes:
      - /opt/squad2/SquadGame/Saved/Logs:/data/logs:ro
      - /opt/configs/squad2:/data/configs:ro
    networks:
      - dokploy-network
    environment:
      INSTANCE_NAME: squad2
      SQUADJS_DISCORD_TOKEN: ${SQUADJS_DISCORD_TOKEN}
      SQUAD_HOST: ${SQUAD2_HOST}
      SQUAD_PUBLIC_HOST: 80.242.59.123
      SQUAD_PUBLIC_PORT: 7801
      SQUAD_RCON_PASSWORD: ${SQUAD2_RCON_PASSWORD}
      MYSQL_HOST: ${MYSQL_HOST}
      MYSQL_PORT: ${MYSQL_PORT}
      MYSQL_USERNAME: ${MYSQL_USERNAME}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
      MYSQL_DATABASE: ${MYSQL_DATABASE}
      MONGO_URI: ${MONGO_URI}

networks:
  dokploy-network:
    external: true
```

В этом варианте сами контейнеры слушают exporter внутри на `32080/tcp`, а наружу вы публикуете только `443/tcp` через Dokploy reverse proxy и в настройке домена/роута указываете target port `32080`.

### Готовый `AUTOSEED_RUNTIME_CONFIG_JSON` для GitHub secret

Если у вас будет два exporter-домена, secret можно положить в таком виде:

```json
{
  "app": {
    "title": "BSS AutoConnect",
    "pollIntervalMs": 180000,
    "debugLogLimit": 80
  },
  "policy": {
    "timezone": "Europe/Moscow",
    "nightWindowStart": "23:00",
    "nightWindowEnd": "08:00",
    "nightPreferredServerId": 1,
    "maxSeedPlayers": 80,
    "priorityOrder": [1, 2, 4],
    "switchDelta": 10,
    "cooldownMs": 600000
  },
  "exporters": [
    {
      "name": "classic",
      "baseUrl": "https://classic-autoseed.example.com"
    },
    {
      "name": "specops",
      "baseUrl": "https://specops-autoseed.example.com"
    }
  ]
}
```

В этом JSON потом меняются только два `baseUrl` на реальные публичные URL exporter-ов.

### Постановка задачи для владельца Dokploy

Нужно опубликовать два внутренних HTTP exporter-сервиса SquadJS наружу по HTTPS через reverse proxy.

Технически это выглядит так:

- `squadjs1` внутри машины слушает exporter на `localhost:32080` контейнера
- `squadjs2` внутри машины слушает exporter на `localhost:32080` контейнера
- reverse proxy Dokploy должен принять HTTPS на двух отдельных поддоменах и проксировать запросы во внутренние exporter-порты соответствующих контейнеров

Ожидаемая схема:

- `https://classic-autoseed.squad.leo-land.ru` -> `squadjs1:32080`
- `https://specops-autoseed.squad.leo-land.ru` -> `squadjs2:32080`

Что требуется от инфраструктуры:

- выдать два поддомена под exporter-ы
- поднять для них TLS
- настроить reverse proxy на target port `32080` для каждого сервиса
- не публиковать `32080` наружу напрямую, если используется reverse proxy

Что не требуется:

- отдельный backend
- авторизация
- запись в БД
- websocket

Exporter read-only и нужен только для `GET /healthz` и `GET /v1/autoseed/snapshot` из браузера GitHub Pages.

### Вариант без reverse proxy

Если exporter хотите открыть наружу напрямую, добавьте `ports`:

```yaml
services:
  squadjs1:
    ports:
      - "32081:32080"

  squadjs2:
    ports:
      - "32082:32080"
```

Тогда GitHub Pages должен ходить на `http(s)://HOST:32081` и `http(s)://HOST:32082`, а на firewall надо открыть `32081/tcp` и `32082/tcp`.

## 6. Какие порты прокидывать наружу

Минимально для AutoConnect:

- `443/tcp` на reverse proxy, который проксирует в локальный `32080/tcp` exporter-плагина в контейнере SquadJS.

Если reverse proxy не используете, можно публиковать exporter напрямую с разными host-port для каждого контейнера, например:

- `32081 -> 32080/tcp` для `squadjs1`
- `32082 -> 32080/tcp` для `squadjs2`

Для самого подключения по `steam://connect/...` должен быть открыт публичный `SQUAD_PUBLIC_PORT` каждого Squad-сервера.

Для текущего BSS это:

- `7800/udp` для `[КЛАССИКА]`
- `7801/udp` для `[SPEC OPS]`

Если используете отдельные query-порты для листинга/мониторинга, они у вас сейчас `7810/udp` и `7811/udp`.

## 7. Рекомендуемая схема доменов

- `autoseed.example.com` -> GitHub Pages frontend
- `classic-autoseed.example.com` -> exporter `[КЛАССИКА]`
- `specops-autoseed.example.com` -> exporter `[SPEC OPS]`
