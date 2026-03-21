import { useEffect, useMemo, useRef, useState } from 'react';

import { runPermissionCheck } from './lib/permissions';
import {
  buildSelectionState,
  getSelectionStatusLabel,
  resolveSeedPolicy
} from './lib/seed-policy';
import { fetchCombinedSnapshot } from './lib/snapshot';
import {
  loadStoredState,
  saveCooldownUntil,
  saveEnabled,
  saveLastProcessedTimestamp,
  savePermissions
} from './lib/storage';
import type {
  AppConfig,
  BrowserPermissions,
  CombinedSnapshot,
  ExporterServerSnapshot,
  SelectionState
} from './types';

type AppProps = {
  config: AppConfig;
};

const EMPTY_SNAPSHOT: CombinedSnapshot = {
  timestamp: 0,
  generatedAt: '',
  servers: [],
  errors: [],
  policy: null
};

function formatTimestamp(value: number | string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(date);
}

function formatBool(value: boolean): string {
  return value ? 'Да' : 'Нет';
}

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export default function App({ config }: AppProps) {
  const storedState = useMemo(() => loadStoredState(), []);
  const [snapshot, setSnapshot] = useState<CombinedSnapshot>(EMPTY_SNAPSHOT);
  const [permissions, setPermissions] = useState<BrowserPermissions | null>(storedState.permissions);
  const [enabled, setEnabled] = useState<boolean>(storedState.enabled);
  const [lastProcessedTimestamp, setLastProcessedTimestamp] = useState<number>(
    storedState.lastProcessedTimestamp
  );
  const [cooldownUntil, setCooldownUntil] = useState<number>(storedState.cooldownUntil);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [isFetching, setIsFetching] = useState<boolean>(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [now, setNow] = useState<number>(Date.now());

  const enabledRef = useRef(enabled);
  const cooldownUntilRef = useRef(cooldownUntil);
  const lastProcessedTimestampRef = useRef(lastProcessedTimestamp);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    cooldownUntilRef.current = cooldownUntil;
  }, [cooldownUntil]);

  useEffect(() => {
    lastProcessedTimestampRef.current = lastProcessedTimestamp;
  }, [lastProcessedTimestamp]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const effectivePolicy = useMemo(
    () => resolveSeedPolicy(config.policy, snapshot.policy),
    [config.policy, snapshot.policy]
  );

  const debugLogLimit = config.app.debugLogLimit || 80;

  const appendLog = (message: string) => {
    setLogs((previous) => {
      const entry = `${new Date().toLocaleTimeString('ru-RU')}: ${message}`;
      const next = [...previous, entry];
      return next.slice(Math.max(0, next.length - debugLogLimit));
    });
  };

  const handlePermissionsCheck = async () => {
    const result = await runPermissionCheck();
    setPermissions(result);
    savePermissions(result);
    appendLog(
      `Проверка permissions: popup=${formatBool(result.popupAllowed)}, steam=${formatBool(result.steamProtocolReady)}`
    );
  };

  const refreshSnapshot = async () => {
    setIsFetching(true);
    setFatalError(null);

    try {
      const nextSnapshot = await fetchCombinedSnapshot(config.exporters);
      const nextPolicy = resolveSeedPolicy(config.policy, nextSnapshot.policy);
      const nextSelection = buildSelectionState(nextSnapshot, nextPolicy);

      setSnapshot(nextSnapshot);
      setSelection(nextSelection);

      if (nextSnapshot.errors.length) {
        nextSnapshot.errors.forEach((error) => appendLog(`Ошибка exporter: ${error}`));
      }

      appendLog(
        `Snapshot fetched: target=${nextSelection.targetServer?.name || 'none'}, mode=${
          nextSelection.nightMode ? 'night' : 'day'
        }`
      );

      if (!enabledRef.current) return;

      if (!permissions?.popupAllowed || !permissions?.steamProtocolReady) {
        appendLog('Redirect подавлен: нет подтверждённых browser permissions.');
        return;
      }

      if (!nextSelection.targetServer?.joinLink) {
        appendLog('Redirect подавлен: нет подходящего сервера или joinLink.');
        return;
      }

      if (nextSnapshot.timestamp <= lastProcessedTimestampRef.current) {
        appendLog('Redirect подавлен: snapshot уже обработан.');
        return;
      }

      if (Date.now() < cooldownUntilRef.current) {
        appendLog('Redirect подавлен: активен cooldown.');
        return;
      }

      const nextCooldownUntil = Date.now() + nextPolicy.cooldownMs;
      setLastProcessedTimestamp(nextSnapshot.timestamp);
      saveLastProcessedTimestamp(nextSnapshot.timestamp);
      setCooldownUntil(nextCooldownUntil);
      saveCooldownUntil(nextCooldownUntil);
      appendLog(`Redirect triggered: ${nextSelection.targetServer.joinLink}`);
      window.location.href = nextSelection.targetServer.joinLink;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown snapshot error';
      setFatalError(message);
      appendLog(`Snapshot fetch failed: ${message}`);
    } finally {
      setIsFetching(false);
    }
  };

  useEffect(() => {
    void refreshSnapshot();
    const interval = window.setInterval(() => {
      void refreshSnapshot();
    }, config.app.pollIntervalMs);

    return () => window.clearInterval(interval);
  }, [config]);

  const handleEnable = async () => {
    let currentPermissions = permissions;
    if (!currentPermissions) {
      currentPermissions = await runPermissionCheck();
      setPermissions(currentPermissions);
      savePermissions(currentPermissions);
    }

    if (!currentPermissions.popupAllowed || !currentPermissions.steamProtocolReady) {
      appendLog('Автоконнектор не запущен: browser permissions не подтверждены.');
      return;
    }

    setEnabled(true);
    saveEnabled(true);
    appendLog('Автоконнектор включён.');
  };

  const handleDisable = () => {
    setEnabled(false);
    saveEnabled(false);
    appendLog('Автоконнектор выключен.');
  };

  const cooldownLeftMs = Math.max(0, cooldownUntil - now);
  const statusText = getSelectionStatusLabel(selection);
  const permissionsReady = Boolean(permissions?.popupAllowed && permissions?.steamProtocolReady);

  return (
    <div className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Squad Static Autoconnect</p>
          <h1>{config.app.title}</h1>
          <p className="hero-copy">
            Статическая страница на GitHub Pages читает публичный snapshot exporter-а и, если по
            общему правилу найден целевой seed-сервер, делает redirect через `steam://`.
          </p>
        </div>
        <div className="hero-side">
          <div className="stat-card">
            <span>Состояние</span>
            <strong>{enabled ? 'Включён' : 'Выключен'}</strong>
          </div>
          <div className="stat-card">
            <span>Target</span>
            <strong>{selection?.targetServer?.name || 'Нет подходящего сервера'}</strong>
          </div>
        </div>
      </header>

      <main className="dashboard-grid" style={{ marginTop: 20 }}>
        <section className="panel">
          <div className="panel-header">
            <h2>Как это работает</h2>
            <span className="badge">{statusText}</span>
          </div>
          <p className="panel-copy">
            Это не персональный автосидер. Система не знает пользователя, не использует Steam auth
            и не отслеживает presence. Решение о подключении принимается только по публичному
            snapshot со списком серверов.
          </p>
          <dl className="keyvals">
            <div>
              <dt>Последний snapshot</dt>
              <dd>{formatTimestamp(snapshot.generatedAt)}</dd>
            </div>
            <div>
              <dt>Режим</dt>
              <dd>{selection?.nightMode ? 'Ночной' : 'Дневной'}</dd>
            </div>
            <div>
              <dt>Exporter endpoints</dt>
              <dd>{config.exporters.length}</dd>
            </div>
            <div>
              <dt>Target joinLink</dt>
              <dd>{selection?.targetServer?.joinLink || '—'}</dd>
            </div>
          </dl>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Permissions</h2>
            <span className="badge">{permissionsReady ? 'Ready' : permissions ? 'Частично готовы' : 'Не проверены'}</span>
          </div>
          <p className="panel-copy">
            Перед запуском нужно один раз проверить popup и `steam://` protocol handler.
          </p>
          <div className="actions">
            <button className="button button-primary" onClick={() => void handlePermissionsCheck()}>
              Проверить permissions
            </button>
          </div>
          <dl className="keyvals">
            <div>
              <dt>Popup</dt>
              <dd>{permissions ? formatBool(permissions.popupAllowed) : '—'}</dd>
            </div>
            <div>
              <dt>Steam protocol</dt>
              <dd>{permissions ? formatBool(permissions.steamProtocolReady) : '—'}</dd>
            </div>
            <div>
              <dt>Checked at</dt>
              <dd>{permissions ? formatTimestamp(permissions.checkedAt) : '—'}</dd>
            </div>
          </dl>
          <div className="preflight-box">
            <h3>Локальный preflight-check</h3>
            <div className="preflight-item">
              <span className={classNames('preflight-dot', permissions?.popupAllowed && 'preflight-dot-ready')} />
              <div>
                <strong>Всплывающие окна разрешены</strong>
                <p>Страница может инициировать переход и тестовое открытие Steam.</p>
              </div>
            </div>
            <div className="preflight-item">
              <span className={classNames('preflight-dot', permissions?.steamProtocolReady && 'preflight-dot-ready')} />
              <div>
                <strong>Открытие Steam разрешено</strong>
                <p>Браузер доверяет вызову `steam://` и не блокирует его.</p>
              </div>
            </div>
            <div className="preflight-item">
              <span className={classNames('preflight-dot', permissionsReady && 'preflight-dot-attention')} />
              <div>
                <strong>Оставьте Squad включённым в главном меню</strong>
                <p>
                  Когда обе локальные проверки пройдены, технически всё готово. Дальше от пользователя
                  нужно только держать Steam и Squad запущенными, а Squad оставить в главном меню.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Управление</h2>
            <span className="badge">{isFetching ? 'Polling…' : 'Idle'}</span>
          </div>
          <div className="actions">
            <button className="button button-primary" onClick={() => void handleEnable()}>
              Включить автоконнектор
            </button>
            <button className="button" onClick={handleDisable}>
              Выключить
            </button>
            <button className="button" onClick={() => void refreshSnapshot()}>
              Обновить сейчас
            </button>
          </div>
          <dl className="keyvals">
            <div>
              <dt>Polling interval</dt>
              <dd>{Math.round(config.app.pollIntervalMs / 1000)} s</dd>
            </div>
            <div>
              <dt>Cooldown</dt>
              <dd>{cooldownLeftMs > 0 ? `${Math.ceil(cooldownLeftMs / 1000)} s` : 'Не активен'}</dd>
            </div>
            <div>
              <dt>lastProcessedTimestamp</dt>
              <dd>{lastProcessedTimestamp || '—'}</dd>
            </div>
          </dl>
          {fatalError ? <p className="error-text">{fatalError}</p> : null}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Правила выбора</h2>
            <span className="badge">{selection?.nightMode ? 'Night window' : 'Priority mode'}</span>
          </div>
          <dl className="keyvals">
            <div>
              <dt>Timezone</dt>
              <dd>{effectivePolicy.timezone}</dd>
            </div>
            <div>
              <dt>Night window</dt>
              <dd>
                {effectivePolicy.nightWindowStart} - {effectivePolicy.nightWindowEnd}
              </dd>
            </div>
            <div>
              <dt>Night preferred server</dt>
              <dd>{effectivePolicy.nightPreferredServerId}</dd>
            </div>
            <div>
              <dt>Priority order</dt>
              <dd>{effectivePolicy.priorityOrder.join(' -> ')}</dd>
            </div>
            <div>
              <dt>Max seed players</dt>
              <dd>{effectivePolicy.maxSeedPlayers}</dd>
            </div>
            <div>
              <dt>switchDelta</dt>
              <dd>{effectivePolicy.switchDelta}</dd>
            </div>
          </dl>
        </section>

        <section className="panel panel-span">
          <div className="panel-header">
            <h2>Серверы из snapshot</h2>
            <span className="badge">{snapshot.servers.length} servers</span>
          </div>
          <div className="server-grid">
            {snapshot.servers.map((server: ExporterServerSnapshot) => (
              <article
                key={`${server.sourceUrl}-${server.id}-${server.code}`}
                className={classNames('server-card', server.online && 'server-card-live')}
              >
                <div className="server-card-head">
                  <h3>{server.name}</h3>
                  <span
                    className={classNames(
                      'server-state',
                      server.online ? 'state-live' : 'state-dead'
                    )}
                  >
                    {server.online ? 'online' : 'offline'}
                  </span>
                </div>
                <dl className="keyvals">
                  <div>
                    <dt>Игроки</dt>
                    <dd>
                      {server.playerCount}/{server.maxPlayers || '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Queue</dt>
                    <dd>{server.queueLength || 0}</dd>
                  </div>
                  <div>
                    <dt>Layer</dt>
                    <dd>{server.currentLayer || '—'}</dd>
                  </div>
                  <div>
                    <dt>Mode</dt>
                    <dd>{server.gameMode || '—'}</dd>
                  </div>
                  <div>
                    <dt>Seed candidate</dt>
                    <dd>{formatBool(server.isSeedCandidate)}</dd>
                  </div>
                  <div>
                    <dt>Exporter</dt>
                    <dd>{server.sourceUrl}</dd>
                  </div>
                  <div>
                    <dt>Join link</dt>
                    <dd>{server.joinLink || '—'}</dd>
                  </div>
                </dl>
                {server.error ? <p className="error-text">{server.error}</p> : null}
              </article>
            ))}
          </div>
        </section>

        <section className="panel panel-span">
          <div className="panel-header">
            <h2>Debug log</h2>
            <span className="badge">{logs.length} events</span>
          </div>
          <div className="log-box">
            {logs.length ? logs.map((line) => <pre key={line}>{line}</pre>) : <pre>Лог пуст.</pre>}
          </div>
        </section>
      </main>
    </div>
  );
}
