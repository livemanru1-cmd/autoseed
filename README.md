# AutoSeed

Статический frontend для автоконнектора Squad и набор документов по интеграции с публичным exporter-плагином для `SquadJS`.

`squadjs2` использует remote `git@github-svo:breaking-squad/squadjs2.git`, а alias `github-svo` в `~/.ssh/config` указывает на ключ `/home/kyarkov/.ssh/id_rsa_home_from_svo`. Для `git@github-svo:breaking-squad/autoseed.git` доступ по SSH есть, но remote сейчас выглядит пустым, поэтому проект в этой папке собран локально с нуля и привязан к `origin`.

## Что реализовано

- frontend на Vite + React c GitHub Pages deployment;
- runtime-конфиг через `public/runtime-config.json`;
- fully-static архитектура без backend и без Steam auth;
- client-side polling публичных exporter endpoint-ов;
- выбор target server по ночному окну, приоритетам, лимиту онлайна и `switchDelta`;
- хранение `enabled`, `lastProcessedTimestamp`, `cooldown` и permissions в `localStorage`;
- локальный preflight-check на странице: popup, `steam://`, и явная подсказка оставить Squad в главном меню;
- redirect через `window.location.href = joinLink`, если пришёл новый snapshot и есть подходящий seed-сервер;
- документация по настройке frontend и exporter-а.

## Локальный запуск

```bash
npm install
npm run dev
```

По умолчанию `prebuild` создаёт `public/runtime-config.json` из `AUTOSEED_RUNTIME_CONFIG_JSON`. Если переменная не передана, он копирует `public/runtime-config.example.json`.

## Runtime config

`baseUrl` должен указывать не просто на host, а на публичный exporter-prefix. Frontend сам дописывает к нему только `/snapshot`.

Файл `public/runtime-config.json` должен содержать:

```json
{
  "app": {
    "title": "BSS AutoConnect",
    "pollIntervalMs": 180000
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
      "baseUrl": "https://seed-api.example.com/classic/v1/autoseed"
    },
    {
      "name": "specops",
      "baseUrl": "https://seed-api.example.com/specops/v1/autoseed"
    }
  ]
}
```

Важно: это публичный клиентский конфиг. Даже если он подставляется через GitHub Secrets, после билда значения становятся видимыми в браузере. Не кладите туда приватные ключи.

Frontend не знает пользователя, не хранит `steamId` и не обращается к Steam OpenID. Это общий autoconnect на правильный seed-сервер по публичному правилу.

## GitHub Pages

CI workflow лежит в `.github/workflows/deploy-pages.yml`.

1. В `Settings -> Pages` включите `GitHub Actions`.
2. Создайте secret `AUTOSEED_RUNTIME_CONFIG_JSON` и положите туда итоговый JSON-конфиг frontend-а.
3. При необходимости создайте variable `VITE_BASE_PATH`, если сайт публикуется не из корня домена.
4. Пуш в `main` соберёт сайт и выложит его на Pages.

## Документация

- [README.md](./README.md)
- [docs/autoseed-tz.md](./docs/autoseed-tz.md)
- [docs/setup.md](./docs/setup.md)
