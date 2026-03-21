# Setup Guide

## 0. Актуальная схема

Сейчас проект устроен так:

- GitHub Pages frontend читает только публичные exporter endpoint-ы;
- exporter публикуется на одном домене `api.squad.leo-land.ru` с path-prefix:
  - `/squadjs1/v1/autoseed`
  - `/squadjs2/v1/autoseed`
- exporter не отдаёт policy;
- policy живёт только во frontend runtime-config;
- текущая BSS policy:
  - ночью `nightPreferredServerId=2`
  - днём приоритет `2 -> 1`
  - лимит `maxSeedPlayers=80`
  - `switchDelta=10`

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
    "nightPreferredServerId": 2,
    "maxSeedPlayers": 80,
    "priorityOrder": [2, 1],
    "switchDelta": 10,
    "cooldownMs": 600000
  },
  "exporters": [
    {
      "name": "squadjs1",
      "baseUrl": "https://api.squad.leo-land.ru/squadjs1/v1/autoseed"
    },
    {
      "name": "squadjs2",
      "baseUrl": "https://api.squad.leo-land.ru/squadjs2/v1/autoseed"
    }
  ]
}
```

Если сайт публикуется не из корня домена, добавьте repository variable `VITE_BASE_PATH`, например `/autoseed/`.

`testSequenceServerIds` и `testSequenceDelayMs` опциональны. Они нужны только для ручного end-to-end теста, когда нужно принудительно прогнать последовательность переходов, например `2 -> 1`, даже если обычная policy сейчас не выбрала бы такой сценарий.

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
  "pathPrefix": "/squadjs1/v1/autoseed",
  "serverId": 1,
  "serverCode": "squadjs1",
  "isSeedCandidate": true,
  "publicConnectHost": "${SQUAD_PUBLIC_HOST}",
  "publicConnectPort": "${SQUAD_PUBLIC_PORT}",
  "joinLinkTemplate": "https://p.sqstat.ru/c/109775243470969105/76561199152953122",
  "corsOrigins": ["*"],
  "snapshotRefreshIntervalMs": 20000,
  "staleAfterMs": 90000,
  "rateLimitWindowMs": 60000,
  "rateLimitMaxRequests": 120
}
```

Если SquadJS запускается через текущий `docker-entrypoint.sh`, то `config/$INSTANCE_NAME.json` проходит через `envsubst`. Для exporter-а удобно держать отдельно:

- `SQUAD_HOST`: адрес, куда сам SquadJS ходит за A2S/RCON.
- `SQUAD_PUBLIC_HOST`: публичный IP/домен, который пойдёт в `steam://connect/...`.
- `SQUAD_PUBLIC_PORT`: публичный connect-port сервера Squad.

Если удобнее использовать уже готовый внешний redirect, `joinLinkTemplate` можно задать фиксированной HTTPS-ссылкой без `{host}` и `{port}`. Тогда exporter будет отдавать её как есть, а `publicConnectHost/publicConnectPort` останутся резервным вариантом для прямого `steam://connect/...`.

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
- `pathPrefix`
- `publicConnectHost`
- `publicConnectPort`
- `joinLinkTemplate`
- `corsOrigins`

## 4. Текущие значения BSS

На текущий момент для BSS публичные connect-адреса такие:

- `squadjs1` / `[RU] МирДружбаЖвачка ★ BSS ★ [КЛАССИКА]` -> `80.242.59.123:7800`
- `squadjs2` / `[RU] МирДружбаЖвачка ★ BSS ★ [SPEC OPS]` -> `80.242.59.123:7801`

При этом в SquadJS-конфигах `queryPort` остаётся `7810` и `7811`. Это нормально: `queryPort` и публичный connect-port могут не совпадать, поэтому `joinLink` должен собираться именно из `SQUAD_PUBLIC_HOST` и `SQUAD_PUBLIC_PORT`.

Для BSS сейчас удобнее использовать фиксированные `sqstat` redirect-ссылки через `joinLinkTemplate`, а `SQUAD_PUBLIC_HOST/SQUAD_PUBLIC_PORT` оставить как запасной путь.

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

Если использовать один HTTPS-домен и path-based routing, secret можно положить в таком виде:

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
    "nightPreferredServerId": 2,
    "maxSeedPlayers": 80,
    "priorityOrder": [2, 1],
    "switchDelta": 10,
    "cooldownMs": 600000
  },
  "exporters": [
    {
      "name": "squadjs1",
      "baseUrl": "https://api.squad.leo-land.ru/squadjs1/v1/autoseed"
    },
    {
      "name": "squadjs2",
      "baseUrl": "https://api.squad.leo-land.ru/squadjs2/v1/autoseed"
    }
  ]
}
```

В этом JSON потом меняется только host, если потребуется другой публичный домен. Пути остаются фиксированными.

### Инфраструктурная схема reverse proxy

Нужно опубликовать два внутренних HTTP exporter-сервиса SquadJS наружу по HTTPS через один reverse proxy и один публичный домен.

Технически это выглядит так:

- `squadjs1` внутри машины слушает exporter на `localhost:32080` контейнера
- `squadjs2` внутри машины слушает exporter на `localhost:32080` контейнера
- reverse proxy должен принять HTTPS на одном домене и проксировать разные path-prefix во внутренние exporter-порты соответствующих контейнеров

Ожидаемая схема:

- `https://api.squad.leo-land.ru/squadjs1/v1/autoseed` -> `squadjs1:32080`
- `https://api.squad.leo-land.ru/squadjs2/v1/autoseed` -> `squadjs2:32080`

Что требуется от инфраструктуры:

- выдать один публичный домен под exporter API
- поднять для него TLS
- настроить path-based routing:
  - `/squadjs1` -> `squadjs1:32080`
  - `/squadjs2` -> `squadjs2:32080`
- path не переписывать, потому что exporter уже сконфигурирован с собственным `pathPrefix`
- не публиковать `32080` наружу напрямую, если используется reverse proxy

Что не требуется:

- отдельный backend
- авторизация
- запись в БД
- websocket

Exporter read-only и нужен только для `GET {baseUrl}/healthz` и `GET {baseUrl}/snapshot` из браузера GitHub Pages.

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
- `api.squad.leo-land.ru/squadjs1/v1/autoseed` -> exporter `squadjs1`
- `api.squad.leo-land.ru/squadjs2/v1/autoseed` -> exporter `squadjs2`

## 8. Быстрый тест после деплоя

### Проверка exporter

```bash
curl -s https://api.squad.leo-land.ru/squadjs1/v1/autoseed/healthz | jq
curl -s https://api.squad.leo-land.ru/squadjs1/v1/autoseed/snapshot | jq
curl -s https://api.squad.leo-land.ru/squadjs2/v1/autoseed/healthz | jq
curl -s https://api.squad.leo-land.ru/squadjs2/v1/autoseed/snapshot | jq
```

### Проверка GitHub Pages

1. Обновить secret `AUTOSEED_RUNTIME_CONFIG_JSON`.
2. Убедиться, что workflow `Deploy Pages` завершился успешно.
3. Открыть опубликованный frontend.
4. Нажать локальную проверку разрешений.
5. Оставить Steam и Squad запущенными, Squad в главном меню.
6. Включить автоконнектор и дождаться нового snapshot.
