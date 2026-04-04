# Техническое задание AutoSeed

## Позиционирование

Система больше не является персональным автосидером. Итоговый продукт представляет собой статический автоконнектор на правильный seed-сервер по общему правилу.

Пользователь открывает страницу на GitHub Pages, у него уже запущены Steam и Squad, страница получает публичный snapshot от SquadJS exporter-а через realtime-подписку и, если по правилам выбран целевой seed-сервер, делает redirect через `steam://...` на этот сервер.

## Архитектура

- frontend полностью статический и размещается на GitHub Pages;
- backend отсутствует полностью:
  - нет auth backend;
  - нет decision backend;
  - нет callback backend;
- frontend получает только публичный read-only snapshot от SquadJS exporter-а;
- frontend получает `joinLink` у exporter-а только в момент реального перехода;
- Steam OpenID и любая пользовательская авторизация в проекте не используются;
- frontend сам выбирает целевой сервер по общим правилам и сам выполняет redirect через `window.location.href = joinLink`.

## Что исключено из проекта

- нет Steam login/OpenID;
- нет `steamId`, `personaName`, `avatar` и пользовательской сессии;
- нет поиска presence по игроку;
- не определяется, на каком сервере сейчас конкретный игрок;
- не используются статусы `not_online`, `on_target_server`, `on_other_server`;
- frontend не вычисляет `joinLink`;
- frontend не парсит Steam и не обращается к сторонним Steam/API сервисам для пользователя.

## Exporter API

Frontend должен работать только с публичным read-only exporter API.

### Обязательные endpoint-ы

- `GET {baseUrl}/snapshot`
- `GET {baseUrl}/healthz`
- `GET {baseUrl}/join-link`

`baseUrl` в runtime-config должен указывать на публичный exporter-prefix, например:

- `https://api.squad.leo-land.ru/squadjs1/v1/autoseed`
- `https://api.squad.leo-land.ru/squadjs2/v1/autoseed`

Если exporter публикуется без дополнительного path-based routing, `baseUrl` может быть просто вида `https://host.example.com/v1/autoseed`.

### Актуальный контракт snapshot

Exporter обязан отдавать:

- `timestamp`
- `servers[]`
- `playerCount`
- `maxPlayers`
- `online`
- `isSeedCandidate`
- `teams[]`
- `teams[].totalPlaytimeHours`
- `teams[].players[]`
- `players[]`

Exporter не должен отдавать policy для frontend decision logic. Правила выбора сервера живут только в `public/runtime-config.json` и в GitHub secret `AUTOSEED_RUNTIME_CONFIG_JSON`.

### Пример ответа

```json
{
  "success": true,
  "timestamp": 1774089600000,
  "generatedAt": "2026-03-21T12:00:00.000Z",
  "version": 3,
  "servers": [
    {
      "id": 1,
      "code": "srv-1",
      "name": "KREST 1",
      "playerCount": 52,
      "maxPlayers": 100,
      "online": true,
      "isSeedCandidate": true,
      "teams": [
        {
          "id": 1,
          "name": "Team 1",
          "playerCount": 25,
          "totalPlaytimeHours": 312.5,
          "players": [
            {
              "name": "Player One",
              "teamId": 1,
              "squadId": 3,
              "squadName": "INF MIC",
              "isLeader": true,
              "isCommander": false,
              "playtimeHours": 24.1
            }
          ]
        }
      ],
      "updatedAt": 1774089600000
    }
  ]
}
```

## Frontend

Frontend на GitHub Pages должен:

- подписываться на `SSE /events` и использовать `snapshot` как fallback;
- выбирать `targetServer` по общим правилам;
- хранить frontend policy в runtime-config;
- проверять popup/Steam protocol permissions;
- показывать локальный preflight-check на странице:
  - всплывающие окна разрешены;
  - открытие Steam разрешено;
  - осталось держать Squad открытым в главном меню;
- хранить `enabled`, `lastProcessedTimestamp`, `cooldown` в `localStorage`;
- делать `window.location.href = joinLink`, если появился новый актуальный snapshot и есть подходящий сервер.
- показывать онлайн серверов, состав сторон и баланс часов по игрокам, не требуя никакой авторизации.

## Правила выбора сервера

Логика выбора сервера остаётся:

1. Ночной режим.
2. Приоритет `2 -> 1`.
3. Лимит `< 80`.
4. `switchDelta > 10`.
5. Fallback на самый населённый подходящий seed-сервер.

### Формализация

1. Если локальное время политики попадает в диапазон `23:00–08:00`, целевым считается `nightPreferredServerId` из frontend runtime-config.
2. В дневном режиме рассматриваются только серверы, где `online === true` и `isSeedCandidate === true`.
3. Исключаются серверы с `playerCount >= maxSeedPlayers`.
4. Сначала проверяется порядок `2 -> 1`.
5. Если другой кандидат опережает приоритетный сервер более чем на `switchDelta`, выбирается более населённый сервер.
6. Если приоритетного победителя нет, выбирается наиболее населённый подходящий seed-сервер.
7. Если кандидатов нет, redirect не выполняется.

### Актуальная policy BSS

- `timezone`: `Europe/Moscow`
- `nightWindowStart`: `23:00`
- `nightWindowEnd`: `08:00`
- `nightPreferredServerId`: `2`
- `priorityOrder`: `2 -> 1`
- `maxSeedPlayers`: `80`
- `switchDelta`: `10`

## Правила redirect

Redirect выполняется, если одновременно выполнены условия:

- автоконнектор включён;
- popup и Steam protocol permissions подтверждены;
- `snapshot.timestamp > lastProcessedTimestamp`;
- cooldown не активен;
- существует подходящий `targetServer`;
- `joinLink` успешно получен отдельным запросом к exporter-у.

## JoinLink

- `joinLink` не должен публиковаться в `snapshot`;
- frontend не должен вычислять `joinLink` самостоятельно;
- frontend не должен парсить Steam;
- frontend должен делать `GET {baseUrl}/join-link` только по факту redirect/direct join;
- exporter должен проксировать lookup в `Squadbrowser API` только для этого запроса;
- допустимый формат: только готовый lobby link из `Squadbrowser API`;
- `joinLink` должен использовать реальный public connect-port Squad-сервера, а не `queryPort`, если эти порты различаются.

## Сетевые требования

Дополнительно к игровым портам Squad нужно публиковать наружу только HTTP/HTTPS порт exporter-а.

Рекомендуемый вариант:

- наружу `443/tcp` через reverse proxy;
- внутрь на ноде exporter-плагина локальный порт, например `32080/tcp`.
- для упрощения можно использовать один HTTPS-домен и path-based routing, например:
  - `/squadjs1` -> первый exporter
  - `/squadjs2` -> второй exporter

## Acceptance criteria

- frontend собирается и деплоится на GitHub Pages;
- frontend работает без любого backend и без Steam auth;
- `prompt.md` не попадает в git;
- realtime-подписка на публичный exporter через `SSE /events` работает;
- `targetServer` выбирается на клиенте;
- redirect выполняется по `joinLink`, полученному отдельным запросом к exporter-у;
- frontend не вычисляет `joinLink` и не содержит пользовательской логики;
- exporter отдаёт read-only `snapshot`/`healthz`/`events`, включая roster и playtime summary, и отдельный `GET /join-link` для on-demand lookup.

## Быстрая проверка

Для рабочего контура BSS базовая проверка выглядит так:

1. Проверить `https://api.squad.leo-land.ru/squadjs1/v1/autoseed/healthz`.
2. Проверить `https://api.squad.leo-land.ru/squadjs1/v1/autoseed/snapshot`.
3. Проверить `https://api.squad.leo-land.ru/squadjs1/v1/autoseed/join-link`.
4. Проверить `https://api.squad.leo-land.ru/squadjs2/v1/autoseed/healthz`.
5. Проверить `https://api.squad.leo-land.ru/squadjs2/v1/autoseed/snapshot`.
6. Проверить `https://api.squad.leo-land.ru/squadjs2/v1/autoseed/join-link`.
7. После этого открыть GitHub Pages frontend и проверить realtime-подписку, preflight-check и redirect.
