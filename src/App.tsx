import { useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';

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
  saveMode,
  savePermissions,
  saveTestSequenceDelayMs
} from './lib/storage';
import type {
  AppConfig,
  AppMode,
  BrowserPermissions,
  CombinedSnapshot,
  ExporterServerSnapshot,
  ExporterSquadSnapshot,
  ExporterTeamSnapshot,
  SelectionState
} from './types';
import projectLogo from '../image.png';

type AppProps = {
  config: AppConfig;
};

type PendingSequence = {
  remaining: ExporterServerSnapshot[];
  nextRedirectAt: number;
};

type RefreshSnapshotOptions = {
  forceRedirect?: boolean;
};

type TeamPanelProps = {
  team: ExporterTeamSnapshot;
  opponent: ExporterTeamSnapshot | null;
};

type TeamRosterGroup = {
  key: string;
  name: string;
  playerCount: number;
  totalPlaytimeHours: number | null;
  players: ExporterTeamSnapshot['players'];
  isUnassigned: boolean;
};

type ConnectorWindowContext = {
  title: string;
  server: ExporterServerSnapshot;
  followupServer?: ExporterServerSnapshot | null;
  followupDelayMs?: number;
  seedLimit: number;
};

type GuideStep = {
  id: string;
  step: string;
  title: string;
  description: string;
  hints: string[];
};

type GuideWindow = {
  title: string;
  description: string;
  label: string;
};

const EMPTY_SNAPSHOT: CombinedSnapshot = {
  timestamp: 0,
  generatedAt: '',
  servers: [],
  errors: []
};

const IMMEDIATE_REDIRECT_SNAPSHOT_MAX_AGE_MS = 15_000;
const BRAND_STYLE = {
  '--brand-logo': `url(${projectLogo})`
} as CSSProperties;

function formatTimestamp(value: number | string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(date);
}

function formatCompactTimestamp(value: number | string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatBool(value: boolean): string {
  return value ? 'Да' : 'Нет';
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0 s';
  return `${Math.ceil(ms / 1000)} s`;
}

function formatHours(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: value >= 100 ? 0 : 1,
    maximumFractionDigits: 1
  }).format(value)} ч`;
}

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function normalizeDelaySeconds(value: number): number {
  if (!Number.isFinite(value)) return 60;
  return Math.max(5, Math.min(600, Math.round(value)));
}

function getSnapshotAgeMs(snapshot: CombinedSnapshot): number {
  const generatedAtMs = Date.parse(snapshot.generatedAt);
  if (Number.isFinite(generatedAtMs)) {
    return Math.max(0, Date.now() - generatedAtMs);
  }

  if (snapshot.timestamp > 0) {
    return Math.max(0, Date.now() - snapshot.timestamp);
  }

  return Number.POSITIVE_INFINITY;
}

function getServerLoadPercent(server: ExporterServerSnapshot): number {
  if (!server.maxPlayers) return 0;
  return Math.max(0, Math.min(100, Math.round((server.playerCount / server.maxPlayers) * 100)));
}

function getSeedProgressPercent(server: ExporterServerSnapshot, seedLimit: number): number {
  if (!seedLimit) return 0;
  return Math.max(0, Math.min(100, Math.round((server.playerCount / seedLimit) * 100)));
}

function getServerSelectionKey(server: ExporterServerSnapshot | null | undefined): string {
  if (!server) return '';
  return `${server.sourceUrl}::${server.id}::${server.code}`;
}

function isSameServer(
  left: ExporterServerSnapshot | null | undefined,
  right: ExporterServerSnapshot | null | undefined
): boolean {
  return Boolean(left && right && getServerSelectionKey(left) === getServerSelectionKey(right));
}

function getSeedProgressGradient(percent: number): string {
  const normalized = Math.max(0, Math.min(100, percent));
  const startHue = Math.round((normalized / 100) * 120);
  const endHue = Math.min(120, startHue + 14);
  return `linear-gradient(90deg, hsl(${startHue} 78% 42%), hsl(${endHue} 86% 56%))`;
}

function canUseRedirectSequenceTarget(server: ExporterServerSnapshot | undefined): boolean {
  return Boolean(server?.online && server.joinLink);
}

function buildTestSequence(
  snapshot: CombinedSnapshot,
  configuredServerIds: number[] | undefined
): ExporterServerSnapshot[] {
  if (!configuredServerIds?.length) return [];

  const sequence: ExporterServerSnapshot[] = [];

  for (const serverId of configuredServerIds) {
    const server = snapshot.servers.find((entry) => entry.id === serverId);
    if (!server || !canUseRedirectSequenceTarget(server)) {
      return [];
    }

    sequence.push(server);
  }

  return sequence;
}

function getTeamHours(team: ExporterTeamSnapshot | null | undefined): number {
  return typeof team?.totalPlaytimeHours === 'number' ? team.totalPlaytimeHours : 0;
}

function buildSquadGroupKey(squadId?: number | null, squadName?: string | null): string {
  if (typeof squadId === 'number' && Number.isFinite(squadId)) {
    return `id:${squadId}`;
  }

  const normalizedName = (squadName || '').trim().toLowerCase();
  return normalizedName ? `name:${normalizedName}` : 'unassigned';
}

function buildTeamRosterGroups(team: ExporterTeamSnapshot): TeamRosterGroup[] {
  const groups = new Map<
    string,
    {
      squad: ExporterSquadSnapshot | null;
      name: string;
      players: ExporterTeamSnapshot['players'];
      isUnassigned: boolean;
    }
  >();

  for (const squad of team.squads) {
    const key = buildSquadGroupKey(squad.id, squad.name);
    groups.set(key, {
      squad,
      name: squad.name || 'Без сквада',
      players: [],
      isUnassigned: false
    });
  }

  for (const player of team.players) {
    const key = buildSquadGroupKey(player.squadId, player.squadName);
    const existing = groups.get(key);
    if (existing) {
      existing.players.push(player);
      continue;
    }

    groups.set(key, {
      squad: null,
      name: player.squadName || 'Без сквада',
      players: [player],
      isUnassigned: !player.squadName && !player.squadId
    });
  }

  return Array.from(groups.entries())
    .map(([key, value]) => {
      const fallbackHours = value.players.reduce((sum, player) => {
        return sum + (typeof player.playtimeHours === 'number' ? player.playtimeHours : 0);
      }, 0);

      return {
        key,
        name: value.name,
        playerCount: value.players.length || value.squad?.playerCount || 0,
        totalPlaytimeHours:
          typeof value.squad?.totalPlaytimeHours === 'number'
            ? value.squad.totalPlaytimeHours
            : fallbackHours || null,
        players: value.players,
        isUnassigned: value.isUnassigned
      };
    })
    .filter((group) => group.playerCount > 0)
    .sort((left, right) => {
      if (left.isUnassigned !== right.isUnassigned) return left.isUnassigned ? 1 : -1;
      return left.name.localeCompare(right.name, 'ru', { numeric: true, sensitivity: 'base' });
    });
}

function getWeakerTeam(server: ExporterServerSnapshot | null | undefined): ExporterTeamSnapshot | null {
  if (!server) return null;
  const [left, right] = server.teams;
  if (!left || !right) return null;

  const leftHours = getTeamHours(left);
  const rightHours = getTeamHours(right);
  if (leftHours === rightHours) return null;
  return leftHours < rightHours ? left : right;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildConnectorWindowMarkup(context: ConnectorWindowContext): string {
  const { title, server, followupServer, followupDelayMs = 0, seedLimit } = context;
  const seedPercent = getSeedProgressPercent(server, seedLimit);
  const seedGradient = getSeedProgressGradient(seedPercent);
  const escapedLogo = escapeHtml(projectLogo);
  const weakerTeam = getWeakerTeam(server);
  const [teamOne, teamTwo] = server.teams;
  const matchupText =
    teamOne && teamTwo
      ? `${escapeHtml(teamOne.name)} ${formatHours(teamOne.totalPlaytimeHours)} · ${escapeHtml(teamTwo.name)} ${formatHours(teamTwo.totalPlaytimeHours)}`
      : 'Состав сторон уточняется…';
  const followupText =
    followupServer && followupDelayMs > 0
      ? `Следом: ${escapeHtml(followupServer.name)} через ${Math.ceil(followupDelayMs / 1000)} s`
      : 'Ожидаем ответ Steam / Squad';
  const weakerText = weakerTeam
    ? `Слабее по часам: ${escapeHtml(weakerTeam.name)}`
    : 'Баланс сторон пока ровный';

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #060606;
        --panel: rgba(18, 18, 18, 0.96);
        --line: rgba(255, 255, 255, 0.08);
        --text: #f5f5f5;
        --muted: #9d9d9d;
        --red: #dd1f1f;
        --green: #20c45a;
        --amber: #f59e0b;
        --brand: url("${escapedLogo}");
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; font-family: Inter, system-ui, sans-serif; background:
        radial-gradient(circle at top left, rgba(221, 31, 31, 0.24), transparent 28%),
        radial-gradient(circle at 100% 100%, rgba(255, 255, 255, 0.08), transparent 24%),
        linear-gradient(180deg, rgba(0, 0, 0, 0.44), rgba(0, 0, 0, 0.76)),
        var(--brand) center/cover no-repeat,
        linear-gradient(180deg, #020202 0%, #090909 100%);
        color: var(--text); }
      body { display: grid; place-items: center; padding: 16px; }
      .panel {
        position: relative;
        width: min(440px, 100%);
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--panel);
        padding: 22px;
        overflow: hidden;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
      }
      .panel::before {
        content: "";
        position: absolute;
        inset: auto -30px -40px auto;
        width: 210px;
        height: 210px;
        background: var(--brand) center/contain no-repeat;
        opacity: 0.12;
        filter: saturate(1.05);
        pointer-events: none;
      }
      .panel > * { position: relative; z-index: 1; }
      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .brand-mark {
        width: 58px;
        height: 58px;
        border-radius: 18px;
        border: 1px solid rgba(255,255,255,.08);
        background: rgba(0,0,0,.35);
        object-fit: contain;
        padding: 6px;
      }
      .eyebrow {
        margin: 0 0 6px;
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .brand-copy p { margin-top: 4px; }
      h1 {
        margin: 12px 0 0;
        font-size: 24px;
        line-height: 1.05;
      }
      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.5;
      }
      .stack { display: grid; gap: 14px; margin-top: 18px; }
      .row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
      }
      .row strong { font-size: 15px; }
      .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
      .big { font-size: 34px; font-weight: 800; line-height: 1; }
      .progress {
        height: 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.06);
        overflow: hidden;
      }
      .progress > span {
        display: block;
        height: 100%;
        width: ${seedPercent}%;
        background: ${seedGradient};
        box-shadow: 0 0 18px rgba(0, 0, 0, 0.24);
      }
      .tag {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        width: fit-content;
        min-height: 32px;
        padding: 0 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(32, 196, 90, 0.12);
        color: var(--green);
        font-size: 13px;
        font-weight: 600;
      }
      .tag::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: currentColor;
      }
      .note { color: var(--amber); }
    </style>
  </head>
  <body>
    <main class="panel">
      <div class="brand">
        <img class="brand-mark" src="${escapedLogo}" alt="" />
        <div class="brand-copy">
          <p class="eyebrow">BSS AutoConnect</p>
          <p>Служебное окно держит redirect-цепочку и не даёт браузеру потерять переход в Steam.</p>
        </div>
      </div>
      <h1>${escapeHtml(server.name)}</h1>
      <p>Держи Squad открытым в главном меню. Окно нужно только для redirect в Steam.</p>
      <div class="stack">
        <span class="tag">Подключаем к серверу</span>
        <div class="row">
          <div>
            <div class="label">Прогресс рассида</div>
            <div class="big">${server.playerCount}/${seedLimit || server.maxPlayers || '—'}</div>
          </div>
          <div style="text-align:right">
            <div class="label">Общий онлайн</div>
            <strong>${server.playerCount}/${server.maxPlayers || '—'}</strong>
          </div>
        </div>
        <div class="progress"><span></span></div>
        <div class="row">
          <div>
            <div class="label">Стороны</div>
            <strong>${matchupText}</strong>
          </div>
        </div>
        <div class="row">
          <div>
            <div class="label">Подсказка</div>
            <strong>${weakerText}</strong>
          </div>
        </div>
        <div class="row">
          <div>
            <div class="label">Дальше</div>
            <strong class="note">${followupText}</strong>
          </div>
        </div>
      </div>
    </main>
  </body>
</html>`;
}

function buildConnectorWindowBootMarkup(title: string): string {
  const escapedLogo = escapeHtml(projectLogo);

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --brand: url("${escapedLogo}");
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        min-height: 100%;
        font-family: Inter, system-ui, sans-serif;
        color: #f3f3f3;
        background:
          radial-gradient(circle at top left, rgba(221, 31, 31, 0.24), transparent 28%),
          linear-gradient(180deg, rgba(0, 0, 0, 0.42), rgba(0, 0, 0, 0.78)),
          var(--brand) center/cover no-repeat,
          #060606;
      }
      body {
        display: grid;
        place-items: center;
        padding: 16px;
      }
      .boot {
        width: min(340px, 100%);
        padding: 18px;
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 22px;
        background: rgba(17, 17, 17, 0.92);
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.52);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .brand img {
        width: 56px;
        height: 56px;
        padding: 6px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,.08);
        background: rgba(0,0,0,.35);
        object-fit: contain;
      }
      .eyebrow {
        margin: 0 0 4px;
        color: rgba(255,255,255,.6);
        font-size: 12px;
        letter-spacing: .14em;
        text-transform: uppercase;
      }
      p {
        margin: 0;
        color: rgba(255,255,255,.76);
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    <div class="boot">
      <div class="brand">
        <img src="${escapedLogo}" alt="" />
        <div>
          <p class="eyebrow">BSS AutoConnect</p>
          <p>Служебное окно коннектора готово. Не закрывайте его во время переключений.</p>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function TeamPanel({ team, opponent }: TeamPanelProps) {
  const teamHours = getTeamHours(team);
  const opponentHours = getTeamHours(opponent);
  const hoursDelta = teamHours - opponentHours;
  const isUnderdog = Boolean(opponent) && hoursDelta < 0;
  const isStronger = Boolean(opponent) && hoursDelta > 0;
  const averageHours = team.playerCount > 0 ? teamHours / team.playerCount : 0;
  const rosterGroups = buildTeamRosterGroups(team);

  let balanceLabel = 'Баланс пока ровный';
  let balanceTone = 'team-balance-neutral';
  if (isUnderdog) {
    balanceLabel = `Слабее на ${formatHours(Math.abs(hoursDelta))}`;
    balanceTone = 'team-balance-underdog';
  } else if (isStronger) {
    balanceLabel = `Сильнее на ${formatHours(Math.abs(hoursDelta))}`;
    balanceTone = 'team-balance-strong';
  }

  return (
    <section className={classNames('team-panel', isUnderdog && 'team-panel-underdog')}>
      <div className="team-panel-head">
        <div>
          <h4>{team.name}</h4>
          <p>{team.playerCount} игроков</p>
        </div>
        <span className={classNames('team-balance', balanceTone)}>{balanceLabel}</span>
      </div>

      <div className="team-kpis">
        <div className="team-kpi">
          <span>Всего</span>
          <strong>{formatHours(team.totalPlaytimeHours)}</strong>
        </div>
        <div className="team-kpi">
          <span>Среднее</span>
          <strong>{team.playerCount ? formatHours(averageHours) : '—'}</strong>
        </div>
        <div className="team-kpi">
          <span>SL</span>
          <strong>{formatHours(team.leaderPlaytimeHours)}</strong>
        </div>
        <div className="team-kpi">
          <span>CMD</span>
          <strong>{formatHours(team.commanderPlaytimeHours)}</strong>
        </div>
      </div>

      <div className="roster-list">
        {rosterGroups.length ? (
          rosterGroups.map((group) => (
            <section key={`${team.id || 0}-${group.key}`} className="squad-group">
              <header className="squad-group-head">
                <div>
                  <strong>{group.name}</strong>
                  <p>{group.playerCount} игроков</p>
                </div>
                <span className="squad-chip">{formatHours(group.totalPlaytimeHours)}</span>
              </header>

              <div className="squad-group-body">
                {group.players.map((player) => (
                  <article
                    key={`${player.steamId || player.eosId || player.name}-${player.teamId || 0}`}
                    className="roster-row"
                  >
                    <div className="roster-main">
                      <div className="roster-name-row">
                        <strong>{player.name}</strong>
                        {player.isCommander ? (
                          <span className="role-pill role-pill-cmd">CMD</span>
                        ) : null}
                        {!player.isCommander && player.isLeader ? (
                          <span className="role-pill role-pill-sl">SL</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="roster-hours">{formatHours(player.playtimeHours)}</div>
                  </article>
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className="roster-empty">Список игроков пока пуст.</div>
        )}
      </div>
    </section>
  );
}

export default function App({ config }: AppProps) {
  const storedState = useMemo(() => loadStoredState(), []);
  const hasConfiguredTestMode = Boolean(config.app.testMode?.sequenceServerIds?.length);
  const [snapshot, setSnapshot] = useState<CombinedSnapshot>(EMPTY_SNAPSHOT);
  const [permissions, setPermissions] = useState<BrowserPermissions | null>(storedState.permissions);
  const [enabled, setEnabled] = useState<boolean>(storedState.enabled);
  const [mode, setMode] = useState<AppMode>(
    hasConfiguredTestMode ? storedState.mode : 'production'
  );
  const [lastProcessedTimestamp, setLastProcessedTimestamp] = useState<number>(
    storedState.lastProcessedTimestamp
  );
  const [cooldownUntil, setCooldownUntil] = useState<number>(storedState.cooldownUntil);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [plannedSequence, setPlannedSequence] = useState<ExporterServerSnapshot[]>([]);
  const [pendingSequence, setPendingSequence] = useState<PendingSequence | null>(null);
  const [testSequenceDelayMsOverride, setTestSequenceDelayMsOverride] = useState<number>(
    storedState.testSequenceDelayMs
  );
  const [isFetching, setIsFetching] = useState<boolean>(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [now, setNow] = useState<number>(Date.now());
  const [activeServerKey, setActiveServerKey] = useState<string>('');

  const enabledRef = useRef(enabled);
  const modeRef = useRef(mode);
  const cooldownUntilRef = useRef(cooldownUntil);
  const lastProcessedTimestampRef = useRef(lastProcessedTimestamp);
  const permissionsRef = useRef(permissions);
  const connectorWindowRef = useRef<Window | null>(null);
  const sequenceTimerRef = useRef<number | null>(null);
  const testSequenceDelayMsRef = useRef<number>(0);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    cooldownUntilRef.current = cooldownUntil;
  }, [cooldownUntil]);

  useEffect(() => {
    lastProcessedTimestampRef.current = lastProcessedTimestamp;
  }, [lastProcessedTimestamp]);

  useEffect(() => {
    permissionsRef.current = permissions;
  }, [permissions]);

  useEffect(() => {
    if (!hasConfiguredTestMode && mode !== 'production') {
      setMode('production');
      saveMode('production');
    }
  }, [hasConfiguredTestMode, mode]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const clearPendingSequence = () => {
    if (sequenceTimerRef.current) {
      window.clearTimeout(sequenceTimerRef.current);
      sequenceTimerRef.current = null;
    }

    setPendingSequence(null);
  };

  const closeConnectorWindow = () => {
    const connectorWindow = connectorWindowRef.current;
    if (!connectorWindow || connectorWindow.closed) return;

    try {
      connectorWindow.close();
    } catch {
      // Ignore user-agent specific close failures.
    }
  };

  useEffect(() => {
    return () => {
      clearPendingSequence();
      closeConnectorWindow();
    };
  }, []);

  const effectivePolicy = useMemo(() => resolveSeedPolicy(config.policy), [config.policy]);
  const debugLogLimit = config.app.debugLogLimit || 80;

  const appendLog = (message: string) => {
    setLogs((previous) => {
      const entry = `${new Date().toLocaleTimeString('ru-RU')}: ${message}`;
      const next = [...previous, entry];
      return next.slice(Math.max(0, next.length - debugLogLimit));
    });
  };

  const testModeConfig = config.app.testMode;
  const activeMode: AppMode = hasConfiguredTestMode ? mode : 'production';
  const isTestModeActive = activeMode === 'test';
  const configuredTestSequenceDelayMs = Math.max(0, testModeConfig?.delayMs || 0);
  const testSequenceDelayMs = Math.max(0, testSequenceDelayMsOverride || configuredTestSequenceDelayMs);
  const testSequenceDelaySeconds = Math.max(5, Math.round(testSequenceDelayMs / 1000));
  const configuredTestSequenceDelaySeconds = Math.max(
    5,
    Math.round(configuredTestSequenceDelayMs / 1000)
  );
  const testCooldownMs = Math.max(0, testModeConfig?.cooldownMs || 30000);
  const testSequencePlanLabel = testModeConfig?.sequenceServerIds?.join(' -> ') || '—';
  const hasManualTestSequenceDelay = testSequenceDelayMsOverride > 0;

  useEffect(() => {
    testSequenceDelayMsRef.current = testSequenceDelayMs;
  }, [testSequenceDelayMs]);

  const ensureConnectorWindow = (): Window | null => {
    const existingWindow = connectorWindowRef.current;
    if (existingWindow && !existingWindow.closed) {
      return existingWindow;
    }

    try {
      const nextWindow = window.open('', 'autoseed-connector', 'popup=yes,width=480,height=460');
      if (!nextWindow) return null;

      nextWindow.document.open();
      nextWindow.document.write(buildConnectorWindowBootMarkup(config.app.title));
      nextWindow.document.close();
      connectorWindowRef.current = nextWindow;
      return nextWindow;
    } catch {
      return null;
    }
  };

  const renderConnectorWindow = (
    connectorWindow: Window,
    server: ExporterServerSnapshot,
    followupServer?: ExporterServerSnapshot | null
  ): void => {
    try {
      connectorWindow.document.open();
      connectorWindow.document.write(
        buildConnectorWindowMarkup({
          title: config.app.title,
          server,
          followupServer,
          followupDelayMs: followupServer ? testSequenceDelayMsRef.current : 0,
          seedLimit: effectivePolicy.maxSeedPlayers
        })
      );
      connectorWindow.document.close();
    } catch {
      appendLog('Не удалось обновить окно коннектора перед redirect.');
    }
  };

  const triggerJoinLink = (
    server: ExporterServerSnapshot,
    followupServer?: ExporterServerSnapshot | null
  ): boolean => {
    if (!server.joinLink) {
      appendLog(`Redirect подавлен: у ${server.name} нет joinLink.`);
      return false;
    }

    const connectorWindow = ensureConnectorWindow();
    if (!connectorWindow) {
      appendLog('Redirect подавлен: не удалось подготовить служебное окно.');
      return false;
    }

    try {
      renderConnectorWindow(connectorWindow, server, followupServer);
      window.setTimeout(() => {
        try {
          connectorWindow.location.href = server.joinLink!;
          connectorWindow.focus();
        } catch {
          appendLog('Redirect подавлен: браузер не дал обновить служебное окно.');
        }
      }, 40);
      return true;
    } catch {
      appendLog('Redirect подавлен: браузер не дал обновить служебное окно.');
      return false;
    }
  };

  const scheduleSequenceStep = (remaining: ExporterServerSnapshot[]) => {
    clearPendingSequence();

    const nextDelayMs = testSequenceDelayMsRef.current;
    if (!remaining.length || nextDelayMs <= 0) return;

    const [nextServer, ...tail] = remaining;
    const nextRedirectAt = Date.now() + nextDelayMs;

    setPendingSequence({ remaining, nextRedirectAt });
    appendLog(
      `Запланирован follow-up redirect через ${Math.ceil(nextDelayMs / 1000)} s: ${nextServer.name}`
    );

    sequenceTimerRef.current = window.setTimeout(() => {
      sequenceTimerRef.current = null;
      setPendingSequence(null);

      if (!enabledRef.current) {
        appendLog(`Follow-up redirect пропущен: автоконнектор уже выключен.`);
        return;
      }

      if (!nextServer.joinLink) {
        appendLog(`Follow-up redirect пропущен: у ${nextServer.name} нет joinLink.`);
        return;
      }

      if (!triggerJoinLink(nextServer, tail[0] || null)) {
        return;
      }

      appendLog(`Follow-up redirect triggered: ${nextServer.joinLink}`);
      scheduleSequenceStep(tail);
    }, nextDelayMs);
  };

  const resetRedirectState = () => {
    setLastProcessedTimestamp(0);
    saveLastProcessedTimestamp(0);
    setCooldownUntil(0);
    saveCooldownUntil(0);
  };

  const handleTestSequenceDelayChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextSeconds = normalizeDelaySeconds(Number(event.target.value));
    const nextDelayMs = nextSeconds * 1000;
    const pendingRemaining = pendingSequence?.remaining || [];

    testSequenceDelayMsRef.current = nextDelayMs;
    setTestSequenceDelayMsOverride(nextDelayMs);
    saveTestSequenceDelayMs(nextDelayMs);
    appendLog(`Тестовая задержка follow-up обновлена: ${nextSeconds} s.`);

    if (pendingRemaining.length && enabledRef.current && modeRef.current === 'test') {
      clearPendingSequence();
      scheduleSequenceStep(pendingRemaining);
      appendLog(`Ожидающий follow-up redirect пересоздан с новой задержкой.`);
    }
  };

  const handleTestSequenceDelayReset = () => {
    const pendingRemaining = pendingSequence?.remaining || [];

    testSequenceDelayMsRef.current = configuredTestSequenceDelayMs;
    setTestSequenceDelayMsOverride(0);
    saveTestSequenceDelayMs(0);
    appendLog(
      `Тестовая задержка follow-up сброшена к конфигу: ${configuredTestSequenceDelaySeconds} s.`
    );

    if (pendingRemaining.length && enabledRef.current && modeRef.current === 'test') {
      clearPendingSequence();
      scheduleSequenceStep(pendingRemaining);
      appendLog(`Ожидающий follow-up redirect пересоздан с задержкой из конфига.`);
    }
  };

  const handlePermissionsCheck = async () => {
    const result = await runPermissionCheck();
    setPermissions(result);
    savePermissions(result);
    appendLog(
      `Проверка браузера: popup=${formatBool(result.popupAllowed)}, steam=${formatBool(result.steamProtocolReady)}`
    );
  };

  const handleDirectJoin = (server: ExporterServerSnapshot) => {
    if (!server.joinLink) {
      appendLog(`Прямое подключение недоступно: у ${server.name} нет joinLink.`);
      return;
    }

    try {
      appendLog(`Прямое подключение: ${server.name}`);
      window.location.href = server.joinLink;
    } catch {
      appendLog(`Прямое подключение не удалось: браузер заблокировал переход к ${server.name}.`);
    }
  };

  const handleModeToggle = () => {
    if (!hasConfiguredTestMode) return;

    const nextMode: AppMode = mode === 'production' ? 'test' : 'production';
    clearPendingSequence();
    resetRedirectState();
    modeRef.current = nextMode;
    setMode(nextMode);
    saveMode(nextMode);
    appendLog(nextMode === 'test' ? 'Переключено в тестовый режим.' : 'Переключено в боевой режим.');
    void refreshSnapshot();
  };

  const startRedirectPlan = (
    redirectPlan: ExporterServerSnapshot[],
    snapshotTimestamp: number,
    cooldownMs: number
  ): boolean => {
    const [firstTarget, ...followups] = redirectPlan;
    if (!firstTarget?.joinLink) {
      appendLog('Redirect подавлен: нет готового joinLink.');
      return false;
    }

    const nextCooldownUntil = Date.now() + cooldownMs;
    setLastProcessedTimestamp(snapshotTimestamp);
    saveLastProcessedTimestamp(snapshotTimestamp);
    setCooldownUntil(nextCooldownUntil);
    saveCooldownUntil(nextCooldownUntil);
    clearPendingSequence();

    if (!triggerJoinLink(firstTarget, followups[0] || null)) {
      return false;
    }

    appendLog(`Redirect triggered: ${firstTarget.joinLink}`);
    scheduleSequenceStep(followups);
    return true;
  };

  const refreshSnapshot = async (options?: RefreshSnapshotOptions) => {
    setIsFetching(true);
    setFatalError(null);

    try {
      const nextSnapshot = await fetchCombinedSnapshot(config.exporters);
      const nextPolicy = resolveSeedPolicy(config.policy);
      const nextSelection = buildSelectionState(nextSnapshot, nextPolicy);
      const testModeEnabled = modeRef.current === 'test';
      const nextTestSequence = buildTestSequence(
        nextSnapshot,
        testModeEnabled ? testModeConfig?.sequenceServerIds : undefined
      );
      const nextRedirectPlan = testModeEnabled
        ? nextTestSequence
        : nextSelection.targetServer
          ? [nextSelection.targetServer]
          : [];

      setSnapshot(nextSnapshot);
      setSelection(nextSelection);
      setPlannedSequence(nextRedirectPlan);

      if (nextSnapshot.errors.length) {
        nextSnapshot.errors.forEach((error) => appendLog(`Ошибка exporter: ${error}`));
      }

      appendLog(
        `Snapshot fetched: target=${nextRedirectPlan[0]?.name || nextSelection.targetServer?.name || 'none'}, mode=${
          testModeEnabled ? 'test' : nextSelection.nightMode ? 'night' : 'day'
        }`
      );

      if (!enabledRef.current) return;

      if (!permissionsRef.current?.popupAllowed || !permissionsRef.current?.steamProtocolReady) {
        appendLog('Redirect подавлен: нет подтверждённых browser permissions.');
        return;
      }

      if (!nextRedirectPlan[0]?.joinLink) {
        appendLog(
          testModeEnabled
            ? 'Redirect подавлен: тестовый режим пока не готов.'
            : 'Redirect подавлен: нет подходящего сервера или joinLink.'
        );
        return;
      }

      if (!options?.forceRedirect && nextSnapshot.timestamp <= lastProcessedTimestampRef.current) {
        appendLog('Redirect подавлен: snapshot уже обработан.');
        return;
      }

      if (!options?.forceRedirect && Date.now() < cooldownUntilRef.current) {
        appendLog('Redirect подавлен: активен cooldown.');
        return;
      }

      startRedirectPlan(
        nextRedirectPlan,
        nextSnapshot.timestamp,
        testModeEnabled ? testCooldownMs : nextPolicy.cooldownMs
      );
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
    if (!permissions) {
      appendLog('Автоконнектор не запущен: сначала вручную выполните локальную проверку браузера.');
      return;
    }

    if (!permissions.popupAllowed || !permissions.steamProtocolReady) {
      appendLog('Автоконнектор не запущен: browser permissions не подтверждены.');
      return;
    }

    if (!ensureConnectorWindow()) {
      appendLog('Автоконнектор не запущен: не удалось открыть служебное окно.');
      return;
    }

    clearPendingSequence();
    resetRedirectState();
    enabledRef.current = true;

    setEnabled(true);
    saveEnabled(true);
    appendLog(
      isTestModeActive
        ? `Автоконнектор включён. Активен тестовый режим: ${testSequencePlanLabel}.`
        : 'Автоконнектор включён.'
    );

    const immediateRedirectPlan =
      isTestModeActive
        ? plannedSequence.length === (testModeConfig?.sequenceServerIds?.length || 0)
          ? plannedSequence
          : []
        : selection?.targetServer
          ? [selection.targetServer]
          : [];
    const currentSnapshotIsFresh =
      snapshot.timestamp > 0 && getSnapshotAgeMs(snapshot) <= IMMEDIATE_REDIRECT_SNAPSHOT_MAX_AGE_MS;

    if (immediateRedirectPlan.length && currentSnapshotIsFresh) {
      if (
        startRedirectPlan(
          immediateRedirectPlan,
          snapshot.timestamp,
          isTestModeActive ? testCooldownMs : effectivePolicy.cooldownMs
        )
      ) {
        appendLog(
          isTestModeActive
            ? 'Тестовый режим: первый redirect запущен сразу из текущего snapshot.'
            : 'Боевой режим: первый redirect запущен сразу из текущего snapshot.'
        );
        return;
      }
    }

    if (immediateRedirectPlan.length && snapshot.timestamp > 0 && !currentSnapshotIsFresh) {
      appendLog('Текущий snapshot устарел: запрашиваю свежие данные перед первичным redirect.');
    }

    void refreshSnapshot({ forceRedirect: true });
  };

  const handleDisable = () => {
    clearPendingSequence();
    closeConnectorWindow();
    enabledRef.current = false;
    setEnabled(false);
    saveEnabled(false);
    appendLog('Автоконнектор выключен.');
  };

  const cooldownLeftMs = Math.max(0, cooldownUntil - now);
  const permissionsReady = Boolean(permissions?.popupAllowed && permissions?.steamProtocolReady);
  const productionMode = activeMode === 'production';
  const statusText = isTestModeActive
    ? plannedSequence.length === (testModeConfig?.sequenceServerIds?.length || 0)
      ? 'Тестовая последовательность готова'
      : 'Тестовая последовательность пока не готова'
    : getSelectionStatusLabel(selection);
  const displayTargetServer = plannedSequence[0] || selection?.targetServer || null;
  const nextFollowupServer = pendingSequence?.remaining[0] || plannedSequence[1] || null;
  const nextFollowupCountdown = pendingSequence
    ? Math.max(0, pendingSequence.nextRedirectAt - now)
    : 0;
  const weakSideSuggestion = getWeakerTeam(displayTargetServer);
  const liveServerCount = snapshot.servers.filter((server) => server.online).length;
  const healthyExporterCount = Math.max(0, config.exporters.length - snapshot.errors.length);
  const latestLog = logs[logs.length - 1] || 'Событий пока нет.';
  const orderedServers = useMemo(
    () =>
      snapshot.servers
        .slice()
        .sort((left, right) => {
          const leftTarget = isSameServer(left, displayTargetServer) ? 1 : 0;
          const rightTarget = isSameServer(right, displayTargetServer) ? 1 : 0;
          if (leftTarget !== rightTarget) return rightTarget - leftTarget;
          if (left.online !== right.online) return Number(right.online) - Number(left.online);
          return left.id - right.id;
        }),
    [displayTargetServer, snapshot.servers]
  );
  const activeServer =
    orderedServers.find((server) => getServerSelectionKey(server) === activeServerKey) ||
    orderedServers[0] ||
    null;
  const quickStartSteps: GuideStep[] = [
    {
      id: 'mode',
      step: '1',
      title: 'Выбери режим в правом верхнем блоке',
      description: hasConfiguredTestMode
        ? 'Оставляй «Боевой» для реальной работы по правилам. «Тест» нужен только чтобы прогнать заранее заданную последовательность серверов.'
        : 'Сейчас доступен только «Боевой» режим, поэтому ничего переключать не нужно.',
      hints: hasConfiguredTestMode
        ? ['Кнопки: «Боевой» или «Тест»', 'Этот блок определяет сценарий redirect-а']
        : ['Кнопка: «Боевой»', 'Тестовый режим не настроен в конфиге']
    },
    {
      id: 'browser',
      step: '2',
      title: 'Нажми «Проверить браузер»',
      description:
        'Проверь, что браузер умеет открыть popup и передать ссылку в Steam. Пока оба индикатора не зелёные, автоконнектор не запустится.',
      hints: ['Кнопка: «Проверить браузер»', 'Смотри статусы Popup и Steam']
    },
    {
      id: 'connector',
      step: '3',
      title: 'Включи «Автоконнектор»',
      description:
        'После запуска откроется служебное окно коннектора. Оно занимается redirect-ом в Steam и должно оставаться открытым, пока идёт работа.',
      hints: ['Кнопка: «Автоконнектор»', 'Служебное окно не закрывать']
    },
    {
      id: 'manual',
      step: '4',
      title: 'Следи за target и, если нужно, жми прямой вход',
      description:
        'Ниже видно целевой сервер, слабую сторону и карточку выбранного сервера. Если нужен ручной обход автоматики, используй кнопку «Подключиться напрямую».',
      hints: ['Карточки: «Текущая цель» и «Куда заходить»', 'Кнопка в карточке сервера: «Подключиться напрямую»']
    }
  ];
  const guideWindows: GuideWindow[] = [
    {
      title: 'Основное окно AutoSeed',
      label: 'Dashboard',
      description:
        'Главный экран. Здесь запускается логика, выбирается режим, видно текущий target, состояние exporter-ов и баланс сторон.'
    },
    {
      title: 'Служебное окно коннектора',
      label: 'Popup',
      description:
        'Открывается после включения коннектора. Нужен только для redirect в Steam и для follow-up переходов в тестовой последовательности.'
    },
    {
      title: 'Steam / Squad',
      label: 'Client',
      description:
        'Финальная точка входа. Держи Squad открытым в главном меню: так redirect проходит быстрее и стабильнее.'
    },
    {
      title: 'Карточка выбранного сервера',
      label: 'Target',
      description:
        'Большой блок ниже переключателя серверов. Здесь прогресс рассида, команды, слабая сторона и запасная кнопка ручного входа.'
    }
  ];

  useEffect(() => {
    if (!orderedServers.length) {
      setActiveServerKey('');
      return;
    }

    setActiveServerKey((current) => {
      if (current && orderedServers.some((server) => getServerSelectionKey(server) === current)) {
        return current;
      }

      return getServerSelectionKey(displayTargetServer) || getServerSelectionKey(orderedServers[0]);
    });
  }, [displayTargetServer, orderedServers]);

  return (
    <div className="shell modern-shell" style={BRAND_STYLE}>
      <header className="hero hero-redesign">
        <div className="hero-main hero-main-tight">
          <div className="hero-brand">
            <div className="hero-logo-shell">
              <img className="hero-logo" src={projectLogo} alt={`${config.app.title} logo`} />
            </div>
            <div className="hero-brand-copy">
              <span className="hero-brand-kicker">Mdj BSS</span>
              <span className="hero-brand-subtitle">auto-connect control room</span>
            </div>
          </div>

          <p className="eyebrow">BSS Seed Connect</p>
          <h1>{config.app.title}</h1>
          <p className="hero-copy hero-copy-tight">
            Включай коннектор или сразу смотри онлайн, состав сторон и баланс часов по обоим
            серверам.
          </p>

          <div className="hero-badges hero-badges-tight">
            <span className={classNames('status-pill', enabled ? 'status-good' : 'status-muted')}>
              {enabled ? 'Коннектор активен' : 'Коннектор выключен'}
            </span>
            <span
              className={classNames(
                'status-pill',
                permissionsReady ? 'status-good' : 'status-danger'
              )}
            >
              {permissionsReady ? 'Браузер готов' : 'Нужна проверка браузера'}
            </span>
            <span
              className={classNames(
                'status-pill',
                displayTargetServer ? 'status-good' : 'status-danger'
              )}
            >
              {displayTargetServer ? `Цель: ${displayTargetServer.name}` : 'Цель не выбрана'}
            </span>
          </div>
        </div>

        <aside className="control-deck">
          <div className="guide-focus guide-focus-neutral">
            <div className="guide-control-label">
              <span className="guide-inline-step" aria-hidden="true">
                1
              </span>
              <span>Сначала выбери режим</span>
            </div>

            <div className="segmented-control">
              <button
                className={classNames('segment', productionMode && 'segment-active')}
                onClick={productionMode ? undefined : handleModeToggle}
                disabled={productionMode}
              >
                Боевой
              </button>
              <button
                className={classNames('segment', isTestModeActive && 'segment-active')}
                onClick={!productionMode ? undefined : handleModeToggle}
                disabled={!hasConfiguredTestMode || isTestModeActive}
              >
                {hasConfiguredTestMode ? `Тест ${testSequencePlanLabel}` : 'Тест недоступен'}
              </button>
            </div>
          </div>

          <button
            className={classNames(
              'power-button',
              'guide-focus',
              'guide-focus-primary',
              enabled && 'power-button-live'
            )}
            onClick={enabled ? handleDisable : () => void handleEnable()}
          >
            <div className="power-button-head">
              <span className="guide-inline-step guide-inline-step-large" aria-hidden="true">
                3
              </span>
              <span className="power-caption">Автоконнектор</span>
            </div>
            <strong>{enabled ? 'Включён' : 'Выключен'}</strong>
            <small>{statusText}</small>
          </button>

          <div className="control-actions">
            <button
              className="button button-primary guide-button guide-focus guide-focus-primary"
              onClick={() => void handlePermissionsCheck()}
            >
              <span className="guide-inline-step" aria-hidden="true">
                2
              </span>
              <span>Проверить браузер</span>
            </button>
            <button className="button" onClick={() => void refreshSnapshot()}>
              Обновить сейчас
            </button>
          </div>

          {hasConfiguredTestMode && isTestModeActive ? (
            <div className="test-delay-card">
              <label className="delay-field">
                <span>Follow-up</span>
                <input
                  className="delay-input"
                  type="number"
                  min={5}
                  max={600}
                  step={5}
                  value={testSequenceDelaySeconds}
                  onChange={handleTestSequenceDelayChange}
                />
                <small>сек</small>
              </label>
              <button
                className="button"
                onClick={handleTestSequenceDelayReset}
                disabled={!hasManualTestSequenceDelay}
              >
                Сбросить
              </button>
            </div>
          ) : null}

          <div className="signal-grid compact-signal-grid">
            <div className="signal-card">
              <span
                className={classNames(
                  'signal-dot',
                  permissions?.popupAllowed ? 'signal-dot-good' : 'signal-dot-bad'
                )}
              />
              <div>
                <strong>Popup</strong>
                <p>{permissions?.popupAllowed ? 'готов' : 'не готов'}</p>
              </div>
            </div>
            <div className="signal-card">
              <span
                className={classNames(
                  'signal-dot',
                  permissions?.steamProtocolReady ? 'signal-dot-good' : 'signal-dot-bad'
                )}
              />
              <div>
                <strong>Steam</strong>
                <p>{permissions?.steamProtocolReady ? 'готов' : 'не готов'}</p>
              </div>
            </div>
            <div className="signal-card">
              <span
                className={classNames(
                  'signal-dot',
                  healthyExporterCount === config.exporters.length
                    ? 'signal-dot-good'
                    : 'signal-dot-warn'
                )}
              />
              <div>
                <strong>Exporter</strong>
                <p>
                  {healthyExporterCount}/{config.exporters.length}
                </p>
              </div>
            </div>
            <div className="signal-card">
              <span
                className={classNames(
                  'signal-dot',
                  displayTargetServer ? 'signal-dot-good' : 'signal-dot-bad'
                )}
              />
              <div>
                <strong>Target</strong>
                <p>{displayTargetServer ? 'есть' : 'нет'}</p>
              </div>
            </div>
          </div>
        </aside>
      </header>

      <section className="help-strip" aria-label="Справка по интерфейсу">
        <details className="help-popover">
          <summary className="help-trigger">
            <span className="help-trigger-icon" aria-hidden="true">
              ?
            </span>
            <span>Как запустить</span>
          </summary>

          <div className="help-panel">
            <div className="help-panel-head">
              <p className="eyebrow">Быстрый запуск</p>
              <h2>Что нажимать и в каком порядке</h2>
              <p>
                Весь сценарий укладывается в четыре действия: выбрать режим, проверить браузер,
                включить коннектор и при необходимости зайти вручную в нужный target.
              </p>
            </div>

            <ol className="guide-steps" aria-label="Пошаговая инструкция">
              {quickStartSteps.map((item) => (
                <li key={item.id} className="guide-step">
                  <span className="guide-step-index" aria-hidden="true">
                    {item.step}
                  </span>
                  <div className="guide-step-copy">
                    <strong>{item.title}</strong>
                    <p>{item.description}</p>
                    <div className="guide-pill-row">
                      {item.hints.map((hint) => (
                        <span key={`${item.id}-${hint}`} className="guide-pill">
                          {hint}
                        </span>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </details>

        <details className="help-popover">
          <summary className="help-trigger">
            <span className="help-trigger-icon" aria-hidden="true">
              ?
            </span>
            <span>Окна и блоки</span>
          </summary>

          <div className="help-panel">
            <div className="help-panel-head">
              <p className="eyebrow">Окна и блоки</p>
              <h2>Что за что отвечает</h2>
              <p>
                Справа в шапке живут управляющие кнопки, ниже идут подсказки по target-у, а
                служебный popup нужен только для перехода в Steam.
              </p>
            </div>

            <div className="guide-window-grid guide-window-grid-compact">
              {guideWindows.map((item) => (
                <article key={item.title} className="guide-window-card">
                  <span className="guide-window-label">{item.label}</span>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </article>
              ))}
            </div>
          </div>
        </details>
      </section>

      {(fatalError || snapshot.errors.length) && (
        <section className="alert-strip">
          {fatalError ? <p>{fatalError}</p> : null}
          {snapshot.errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </section>
      )}

      <section className="overview-grid">
        <article className="overview-card overview-card-spotlight">
          <span className="overview-label">Текущая цель</span>
          <strong>{displayTargetServer?.name || 'Подходящий сервер не найден'}</strong>
          <p>{statusText}</p>
        </article>

        <article className="overview-card">
          <span className="overview-label">Куда заходить</span>
          <strong>{weakSideSuggestion?.name || 'Стороны пока ровные'}</strong>
          <p>{weakSideSuggestion ? 'Слабая сторона на текущем target' : 'Ждём состав сторон'}</p>
        </article>

        <article className="overview-card">
          <span className="overview-label">Snapshot</span>
          <strong>{formatCompactTimestamp(snapshot.generatedAt)}</strong>
          <p>
            {liveServerCount}/{snapshot.servers.length || config.exporters.length} серверов online
          </p>
        </article>

        <article className="overview-card">
          <span className="overview-label">{pendingSequence ? 'Следующий переход' : 'Cooldown'}</span>
          <strong>
            {pendingSequence
              ? formatCountdown(nextFollowupCountdown)
              : cooldownLeftMs > 0
                ? formatCountdown(cooldownLeftMs)
                : '—'}
          </strong>
          <p>
            {pendingSequence
              ? nextFollowupServer?.name || 'Ожидаем follow-up'
              : enabled
                ? 'Коннектор ждёт новый snapshot'
                : 'Коннектор не активен'}
          </p>
        </article>
      </section>

      <section className="server-switcher">
        <div className="server-switcher-track">
          {orderedServers.map((server) => {
            const serverKey = getServerSelectionKey(server);
            const isActive = serverKey === getServerSelectionKey(activeServer);
            const isTarget = isSameServer(server, displayTargetServer);
            const [leftTeam, rightTeam] = server.teams;
            const switcherHoursLine =
              leftTeam && rightTeam
                ? `${leftTeam.name}: ${formatHours(leftTeam.totalPlaytimeHours)} · ${rightTeam.name}: ${formatHours(rightTeam.totalPlaytimeHours)}`
                : 'Часы сторон пока не готовы';

            return (
              <article
                key={serverKey}
                className={classNames(
                  'server-switcher-card',
                  isActive && 'server-switcher-card-active',
                  isTarget && 'server-switcher-card-target'
                )}
              >
                <button
                  type="button"
                  className="server-switcher-select"
                  onClick={() => setActiveServerKey(serverKey)}
                >
                  <div className="server-switcher-head">
                    <strong>{server.name}</strong>
                    <span
                      className={classNames(
                        'server-state',
                        server.online ? 'state-live' : 'state-dead'
                      )}
                    >
                      {server.online ? 'online' : 'offline'}
                    </span>
                  </div>
                  <div className="server-switcher-meta">
                    <span>{server.playerCount}/{server.maxPlayers || '—'}</span>
                    {isTarget ? <span className="server-switcher-accent">target</span> : null}
                  </div>
                  <p>{switcherHoursLine}</p>
                </button>

                <div className="server-switcher-actions">
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => handleDirectJoin(server)}
                    disabled={!server.joinLink}
                  >
                    {server.joinLink ? 'Подключиться' : 'Lobby не готов'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="server-stack">
        {activeServer ? (() => {
          const server = activeServer;
          const seedLimit = effectivePolicy.maxSeedPlayers || server.maxPlayers || 0;
          const loadPercent = getServerLoadPercent(server);
          const seedPercent = getSeedProgressPercent(server, seedLimit);
          const weakerTeam = getWeakerTeam(server);
          const [teamOne, teamTwo] = server.teams;

          return (
            <article
              key={getServerSelectionKey(server)}
              className={classNames(
                'server-board',
                server.online && 'server-board-live',
                isSameServer(server, displayTargetServer) && 'server-board-target'
              )}
            >
              <div className="server-board-top">
                <div className="server-title-block">
                  <div className="server-title-row">
                    <h2>{server.name}</h2>
                    <div className="server-chip-row">
                      <span
                        className={classNames(
                          'server-state',
                          server.online ? 'state-live' : 'state-dead'
                        )}
                      >
                        {server.online ? 'online' : 'offline'}
                      </span>
                      <span
                        className={classNames(
                          'server-state',
                          server.isSeedCandidate ? 'state-live' : 'state-dead'
                        )}
                      >
                        seed
                      </span>
                      {server.joinLink ? (
                        <span className="server-state state-join">join ready</span>
                      ) : (
                        <span className="server-state state-dead">no join</span>
                      )}
                      {isSameServer(server, displayTargetServer) ? (
                        <span className="server-state state-target">target</span>
                      ) : null}
                    </div>
                  </div>
                  <p className="server-board-copy">
                    {weakerTeam
                      ? `Слабее по часам: ${weakerTeam.name}`
                      : 'Смотри состав сторон и общий баланс часов ниже.'}
                  </p>
                  <div className="server-board-actions">
                    <button
                      type="button"
                      className="button button-primary guide-button guide-focus guide-focus-accent"
                      onClick={() => handleDirectJoin(server)}
                      disabled={!server.joinLink}
                    >
                      <span className="guide-inline-step" aria-hidden="true">
                        4
                      </span>
                      <span>
                        {server.joinLink ? 'Подключиться напрямую' : 'Lobby link не готов'}
                      </span>
                    </button>
                  </div>
                </div>

                <div className="server-metrics">
                  <div className="server-metric">
                    <span>Онлайн</span>
                    <strong>
                      {server.playerCount}/{server.maxPlayers || '—'}
                    </strong>
                  </div>
                  <div className="server-metric">
                    <span>Seed progress</span>
                    <strong>
                      {server.playerCount}/{seedLimit || '—'}
                    </strong>
                  </div>
                  <div className="server-metric">
                    <span>Очередь</span>
                    <strong>{server.queueLength || 0}</strong>
                  </div>
                  <div className="server-metric">
                    <span>Снимок</span>
                    <strong>{formatCompactTimestamp(server.updatedAt)}</strong>
                  </div>
                </div>
              </div>

              <div className="meter-block">
                <div className="meter-line">
                  <span>Загрузка</span>
                  <strong>{loadPercent}%</strong>
                </div>
                <div className="server-meter server-meter-neutral">
                  <span style={{ width: `${loadPercent}%` }} />
                </div>
              </div>

              <div className="meter-block">
                <div className="meter-line">
                  <span>Прогресс рассида</span>
                  <strong>{seedPercent}%</strong>
                </div>
                <div className="server-meter server-meter-seed">
                  <span
                    style={{
                      width: `${seedPercent}%`,
                      background: getSeedProgressGradient(seedPercent)
                    }}
                  />
                </div>
              </div>

              <div className="server-facts dense-facts">
                <div className="fact-pill">
                  <span>Слой</span>
                  <strong>{server.currentLayer || '—'}</strong>
                </div>
                <div className="fact-pill">
                  <span>Режим</span>
                  <strong>{server.gameMode || '—'}</strong>
                </div>
                <div className="fact-pill">
                  <span>Стороны</span>
                  <strong>{server.teams.length || 0}</strong>
                </div>
                <div className="fact-pill">
                  <span>Игроков с часами</span>
                  <strong>
                    {server.teams.reduce((sum, team) => sum + (team.playersWithHours || 0), 0)}
                  </strong>
                </div>
              </div>

              {server.error ? <p className="error-text">{server.error}</p> : null}

              <div className="teams-grid">
                {teamOne ? <TeamPanel team={teamOne} opponent={teamTwo || null} /> : null}
                {teamTwo ? <TeamPanel team={teamTwo} opponent={teamOne || null} /> : null}
                {!teamOne && !teamTwo ? (
                  <div className="team-panel team-panel-empty">
                    Состав сторон пока не поступил из exporter-а.
                  </div>
                ) : null}
              </div>
            </article>
          );
        })() : (
          <article className="server-board">
            <div className="roster-empty">Серверы пока не пришли из exporter-а.</div>
          </article>
        )}
      </section>

      <details className="panel panel-span panel-details">
        <summary className="details-summary">
          <span>Правила и диагностика</span>
          <span className="badge badge-muted">{snapshot.errors.length + (fatalError ? 1 : 0)}</span>
        </summary>
        <div className="diagnostics-grid">
          <div className="summary-stack">
            <div className="summary-row">
              <span>Режим</span>
              <strong>{productionMode ? 'Боевой' : `Тест ${testSequencePlanLabel}`}</strong>
            </div>
            <div className="summary-row">
              <span>Последний snapshot</span>
              <strong>{formatTimestamp(snapshot.generatedAt)}</strong>
            </div>
            <div className="summary-row">
              <span>Последняя проверка браузера</span>
              <strong>{permissions ? formatTimestamp(permissions.checkedAt) : '—'}</strong>
            </div>
            <div className="summary-row">
              <span>Последнее событие</span>
              <strong>{latestLog}</strong>
            </div>
          </div>

          <div className="rule-grid">
            <div className="rule-card">
              <span>Приоритет</span>
              <strong>{effectivePolicy.priorityOrder.join(' → ')}</strong>
            </div>
            <div className="rule-card">
              <span>Ночь</span>
              <strong>
                {effectivePolicy.nightWindowStart} - {effectivePolicy.nightWindowEnd}
              </strong>
            </div>
            <div className="rule-card">
              <span>Ночной target</span>
              <strong>{effectivePolicy.nightPreferredServerId}</strong>
            </div>
            <div className="rule-card">
              <span>Лимит seed</span>
              <strong>&lt; {effectivePolicy.maxSeedPlayers}</strong>
            </div>
            <div className="rule-card">
              <span>Switch delta</span>
              <strong>&gt; {effectivePolicy.switchDelta}</strong>
            </div>
            <div className="rule-card">
              <span>Polling</span>
              <strong>{Math.round(config.app.pollIntervalMs / 1000)} s</strong>
            </div>
            {hasConfiguredTestMode ? (
              <>
                <div className="rule-card">
                  <span>Тестовый план</span>
                  <strong>{testSequencePlanLabel}</strong>
                </div>
                <div className="rule-card">
                  <span>Задержка follow-up</span>
                  <strong>
                    {Math.round(testSequenceDelayMs / 1000)} s
                    {hasManualTestSequenceDelay ? ' · local' : ''}
                  </strong>
                </div>
                <div className="rule-card">
                  <span>Cooldown теста</span>
                  <strong>{Math.round(testCooldownMs / 1000)} s</strong>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </details>

      <details className="panel panel-span panel-details">
        <summary className="details-summary">
          <span>Debug log</span>
          <span className="badge badge-muted">{logs.length}</span>
        </summary>
        <div className="log-box">
          {logs.length ? logs.map((line) => <pre key={line}>{line}</pre>) : <pre>Лог пуст.</pre>}
        </div>
      </details>
    </div>
  );
}
