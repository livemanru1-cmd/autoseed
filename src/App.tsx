import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent
} from 'react';

import { runPermissionCheck } from './lib/permissions';
import {
  buildSelectionState,
  getSelectionStatusLabel,
  resolveSeedPolicy
} from './lib/seed-policy';
import {
  fetchCombinedSnapshot,
  fetchServerJoinLink,
  subscribeCombinedSnapshot
} from './lib/snapshot';
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

type SnapshotUpdateSource = 'manual' | 'stream';

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
  phase: 'dispatching' | 'redirect_sent';
};

type ConnectorWindowState = {
  serverKey: string;
  followupServerKey: string;
  phase: ConnectorWindowContext['phase'];
};

type GuideStep = {
  id: string;
  step: string;
  title: string;
  description: string;
  hints: string[];
};

type InlineHelpProps = {
  label: string;
  title: string;
  description: string;
  testId?: string;
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
  if (ms <= 0) return '0 с';
  return `${Math.ceil(ms / 1000)} с`;
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

function findServerBySelectionKey(
  snapshot: CombinedSnapshot,
  selectionKey: string
): ExporterServerSnapshot | null {
  if (!selectionKey) return null;
  return (
    snapshot.servers.find((server) => getServerSelectionKey(server) === selectionKey) || null
  );
}

function getSeedProgressGradient(percent: number): string {
  const normalized = Math.max(0, Math.min(100, percent));
  const startHue = Math.round((normalized / 100) * 120);
  const endHue = Math.min(120, startHue + 14);
  return `linear-gradient(90deg, hsl(${startHue} 78% 42%), hsl(${endHue} 86% 56%))`;
}

function canUseRedirectSequenceTarget(server: ExporterServerSnapshot | undefined): boolean {
  return Boolean(server?.online && server.joinLinkUrl);
}

function canRequestJoinLink(server: ExporterServerSnapshot | null | undefined): boolean {
  return Boolean(server?.online && server.joinLinkUrl);
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
  const { title, server, followupServer, followupDelayMs = 0, seedLimit, phase } = context;
  const seedPercent = getSeedProgressPercent(server, seedLimit);
  const seedGradient = getSeedProgressGradient(seedPercent);
  const escapedLogo = escapeHtml(projectLogo);
  const weakerTeam = getWeakerTeam(server);
  const [teamOne, teamTwo] = server.teams;
  const matchupText =
    teamOne && teamTwo
      ? `${escapeHtml(teamOne.name)} ${formatHours(teamOne.totalPlaytimeHours)} · ${escapeHtml(teamTwo.name)} ${formatHours(teamTwo.totalPlaytimeHours)}`
      : 'Состав сторон уточняется…';
  const weakerText = weakerTeam
    ? `Слабее по часам: ${escapeHtml(weakerTeam.name)}`
    : 'Баланс сторон пока ровный';
  const hasFollowup = Boolean(followupServer && followupDelayMs > 0);
  const statusTag =
    phase === 'redirect_sent'
      ? hasFollowup
        ? 'Первый переход отправлен'
        : 'Переход отправлен'
      : 'Передаём ссылку входа в Steam';
  const leadText =
    phase === 'redirect_sent'
      ? 'Браузер не получает отдельный ответ от Steam или Squad. Если окно осталось на служебной карточке, это нормально. Перед каждым следующим переходом запросим новую ссылку входа.'
      : 'Держи Squad открытым в главном меню. Окно нужно только для запроса свежей ссылки входа и передачи перехода в Steam.';
  const nextStepLabel = hasFollowup ? 'Следом' : 'Дальше';
  const nextStepText = hasFollowup
    ? `Следующий сервер: ${escapeHtml(followupServer!.name)} через ${Math.ceil(followupDelayMs / 1000)} с`
    : phase === 'redirect_sent'
      ? 'Автоконнектор ждёт новый снимок. Перед следующим переходом ссылка входа будет запрошена заново.'
      : 'После отправки браузер не получит отдельный ответ от Steam или Squad.';
  const snapshotText = formatCompactTimestamp(server.updatedAt);
  const joinLinkText = 'Запрашивается прямо перед переходом';

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
        background:
          radial-gradient(circle at 50% 24%, rgba(255,255,255,.14), transparent 58%),
          rgba(9,14,21,.18);
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
          <p>Служебное окно держит цепочку переходов и не даёт браузеру потерять отправку в Steam.</p>
        </div>
      </div>
      <h1>${escapeHtml(server.name)}</h1>
      <p>${leadText}</p>
      <div class="stack">
        <span class="tag">${statusTag}</span>
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
            <div class="label">Снимок</div>
            <strong>${snapshotText}</strong>
          </div>
        </div>
        <div class="row">
          <div>
            <div class="label">Ссылка входа</div>
            <strong>${joinLinkText}</strong>
          </div>
        </div>
        <div class="row">
          <div>
            <div class="label">${nextStepLabel}</div>
            <strong class="note">${nextStepText}</strong>
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
        background:
          radial-gradient(circle at 50% 24%, rgba(255,255,255,.14), transparent 58%),
          rgba(9,14,21,.18);
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

function InlineHelp({ label, title, description, testId }: InlineHelpProps) {
  return (
    <details className="panel-help" data-testid={testId ? `${testId}-container` : undefined}>
      <summary
        className="panel-help-trigger"
        aria-label={label}
        title={label}
        data-testid={testId ? `${testId}-trigger` : undefined}
      >
        <span aria-hidden="true">?</span>
      </summary>
      <div className="panel-help-popover" data-testid={testId ? `${testId}-popover` : undefined}>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </details>
  );
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
  const [joinLinkRequestServerKey, setJoinLinkRequestServerKey] = useState<string>('');

  const enabledRef = useRef(enabled);
  const modeRef = useRef(mode);
  const snapshotRef = useRef(snapshot);
  const isFetchingRef = useRef(isFetching);
  const cooldownUntilRef = useRef(cooldownUntil);
  const lastProcessedTimestampRef = useRef(lastProcessedTimestamp);
  const permissionsRef = useRef(permissions);
  const pendingSequenceRef = useRef(pendingSequence);
  const connectorWindowRef = useRef<Window | null>(null);
  const sequenceTimerRef = useRef<number | null>(null);
  const testSequenceDelayMsRef = useRef<number>(0);
  const connectorWindowStateRef = useRef<ConnectorWindowState | null>(null);
  const connectorWindowWriteBlockedRef = useRef<boolean>(false);
  const activeRedirectServerKeyRef = useRef<string>('');
  const redirectInFlightRef = useRef<boolean>(false);
  const pendingRedirectServerKeyRef = useRef<string>('');

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    isFetchingRef.current = isFetching;
  }, [isFetching]);

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
    pendingSequenceRef.current = pendingSequence;
  }, [pendingSequence]);

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
    } finally {
      connectorWindowRef.current = null;
      connectorWindowWriteBlockedRef.current = false;
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
  const isJoinLinkRequestPending = (server: ExporterServerSnapshot | null | undefined): boolean =>
    Boolean(server && getServerSelectionKey(server) === joinLinkRequestServerKey);

  const requestFreshJoinLink = async (
    server: ExporterServerSnapshot,
    reason: 'redirect' | 'direct'
  ): Promise<string | null> => {
    if (!canRequestJoinLink(server)) {
      appendLog(
        reason === 'direct'
          ? `Прямое подключение недоступно: ${server.name} сейчас оффлайн.`
          : `Переход отменён: ${server.name} сейчас оффлайн.`
      );
      return null;
    }

    const serverKey = getServerSelectionKey(server);
    setJoinLinkRequestServerKey(serverKey);
    appendLog(
      reason === 'direct'
        ? `Прямое подключение: запрашиваю свежую ссылку входа для ${server.name}.`
        : `Запрашиваю свежую ссылку входа для ${server.name}.`
    );

    try {
      return await fetchServerJoinLink(server.joinLinkUrl);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'неизвестная ошибка при запросе ссылки входа';
      appendLog(
        reason === 'direct'
          ? `Прямое подключение не удалось: ${server.name} не отдал ссылку входа (${message}).`
          : `Переход отменён: ${server.name} не отдал ссылку входа (${message}).`
      );
      return null;
    } finally {
      setJoinLinkRequestServerKey((current) => (current === serverKey ? '' : current));
    }
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
  const periodicReconnectMs = Math.max(0, effectivePolicy.periodicReconnectMs || 0);
  const testSequencePlanLabel = testModeConfig?.sequenceServerIds?.join(' -> ') || '—';
  const hasManualTestSequenceDelay = testSequenceDelayMsOverride > 0;

  useEffect(() => {
    testSequenceDelayMsRef.current = testSequenceDelayMs;
  }, [testSequenceDelayMs]);

  const applySnapshot = useEffectEvent(
    (
      nextSnapshot: CombinedSnapshot,
      options?: RefreshSnapshotOptions,
      source: SnapshotUpdateSource = 'stream'
    ) => {
      setFatalError(null);

      try {
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
          nextSnapshot.errors.forEach((error) => appendLog(`Ошибка экспортера: ${error}`));
        }

        appendLog(
          `Снимок ${source === 'manual' ? 'получен' : 'обновлён'}: цель=${
            nextRedirectPlan[0]?.name || nextSelection.targetServer?.name || 'нет'
          }, режим=${testModeEnabled ? 'тест' : nextSelection.nightMode ? 'ночь' : 'день'}`
        );

        if (!enabledRef.current) return;

        if (!permissionsRef.current?.popupAllowed || !permissionsRef.current?.steamProtocolReady) {
          appendLog('Переход отменён: браузерные разрешения не подтверждены.');
          return;
        }

        if (!nextRedirectPlan[0]) {
          appendLog(
            testModeEnabled
              ? 'Переход отменён: тестовый режим пока не готов.'
              : 'Переход отменён: нет подходящего сервера.'
          );
          return;
        }

        if (testModeEnabled && pendingSequenceRef.current?.remaining.length && !options?.forceRedirect) {
          return;
        }

        const nextTargetKey = getServerSelectionKey(nextRedirectPlan[0]);
        const activeRedirectServerKey = activeRedirectServerKeyRef.current;
        const productionTargetChanged = Boolean(
          !testModeEnabled &&
            nextTargetKey &&
            activeRedirectServerKey &&
            nextTargetKey !== activeRedirectServerKey
        );

        if (redirectInFlightRef.current) {
          if (nextTargetKey && pendingRedirectServerKeyRef.current === nextTargetKey) {
            return;
          }

          appendLog('Переход отменён: предыдущий переход ещё готовится.');
          return;
        }

        if (
          !options?.forceRedirect &&
          !productionTargetChanged &&
          nextSnapshot.timestamp <= lastProcessedTimestampRef.current
        ) {
          appendLog('Переход отменён: этот снимок уже обработан.');
          return;
        }

        if (
          !options?.forceRedirect &&
          !productionTargetChanged &&
          Date.now() < cooldownUntilRef.current
        ) {
          appendLog('Переход отменён: ещё действует пауза между переходами.');
          return;
        }

        if (productionTargetChanged) {
          const previousServer =
            findServerBySelectionKey(nextSnapshot, activeRedirectServerKey) ||
            findServerBySelectionKey(snapshot, activeRedirectServerKey);
          appendLog(
            `Боевой режим: цель сменилась с ${previousServer?.name || 'предыдущего сервера'} на ${nextRedirectPlan[0].name}, паузу пропускаем.`
          );
        }

        void startRedirectPlan(
          nextRedirectPlan,
          nextSnapshot.timestamp,
          testModeEnabled ? testCooldownMs : nextPolicy.cooldownMs
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'неизвестная ошибка снимка';
        setFatalError(message);
        appendLog(`Ошибка обработки снимка: ${message}`);
      }
    }
  );

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
      connectorWindowWriteBlockedRef.current = false;
      return nextWindow;
    } catch {
      return null;
    }
  };

  const renderConnectorWindow = (
    connectorWindow: Window,
    server: ExporterServerSnapshot,
    followupServer?: ExporterServerSnapshot | null,
    phase: ConnectorWindowContext['phase'] = 'dispatching',
    followupDelayMs: number = followupServer ? testSequenceDelayMsRef.current : 0
  ): void => {
    try {
      connectorWindow.document.open();
      connectorWindow.document.write(
        buildConnectorWindowMarkup({
          title: config.app.title,
          server,
          followupServer,
          followupDelayMs,
          seedLimit: effectivePolicy.maxSeedPlayers,
          phase
        })
      );
      connectorWindow.document.close();
      connectorWindowWriteBlockedRef.current = false;
    } catch {
      if (!connectorWindowWriteBlockedRef.current) {
        appendLog(
          phase === 'redirect_sent'
            ? 'Не удалось обновить окно коннектора после перехода.'
            : 'Не удалось обновить окно коннектора перед переходом.'
        );
      }
      connectorWindowWriteBlockedRef.current = true;
    }
  };

  const syncConnectorWindow = (
    nextSnapshot: CombinedSnapshot,
    nextRedirectPlan: ExporterServerSnapshot[]
  ): void => {
    const connectorWindow = connectorWindowRef.current;
    if (!connectorWindow || connectorWindow.closed) {
      connectorWindowRef.current = null;
      connectorWindowWriteBlockedRef.current = false;
      return;
    }

    const trackedState = connectorWindowStateRef.current;
    const trackedServer = trackedState
      ? findServerBySelectionKey(nextSnapshot, trackedState.serverKey)
      : null;
    const trackedFollowupServer = trackedState?.followupServerKey
      ? findServerBySelectionKey(nextSnapshot, trackedState.followupServerKey)
      : null;
    const liveFollowupDelayMs =
      pendingSequence &&
      trackedFollowupServer &&
      pendingSequence.remaining.length &&
      getServerSelectionKey(pendingSequence.remaining[0]) ===
        getServerSelectionKey(trackedFollowupServer)
        ? Math.max(0, pendingSequence.nextRedirectAt - Date.now())
        : trackedFollowupServer
          ? testSequenceDelayMsRef.current
          : 0;

    if (trackedServer && trackedState) {
      renderConnectorWindow(
        connectorWindow,
        trackedServer,
        trackedFollowupServer,
        trackedState.phase,
        liveFollowupDelayMs
      );
      return;
    }

    if (!enabledRef.current || !nextRedirectPlan.length) return;

    const fallbackServer = nextRedirectPlan[0];
    const fallbackFollowupServer = pendingSequence?.remaining[0] || nextRedirectPlan[1] || null;
    connectorWindowStateRef.current = {
      serverKey: getServerSelectionKey(fallbackServer),
      followupServerKey: getServerSelectionKey(fallbackFollowupServer),
      phase: 'redirect_sent'
    };

    renderConnectorWindow(
      connectorWindow,
      fallbackServer,
      fallbackFollowupServer,
      'redirect_sent',
      pendingSequence
        ? Math.max(0, pendingSequence.nextRedirectAt - Date.now())
        : fallbackFollowupServer
          ? testSequenceDelayMsRef.current
          : 0
    );
  };

  useEffect(() => {
    if (!enabled) return;
    syncConnectorWindow(snapshot, plannedSequence);
  }, [enabled, pendingSequence, plannedSequence, snapshot]);

  const triggerJoinLink = async (
    server: ExporterServerSnapshot,
    followupServer?: ExporterServerSnapshot | null
  ): Promise<string | null> => {
    const connectorWindow = ensureConnectorWindow();
    if (!connectorWindow) {
      appendLog('Переход отменён: не удалось подготовить служебное окно.');
      return null;
    }

    try {
      connectorWindowStateRef.current = {
        serverKey: getServerSelectionKey(server),
        followupServerKey: getServerSelectionKey(followupServer),
        phase: 'dispatching'
      };
      renderConnectorWindow(
        connectorWindow,
        server,
        followupServer,
        'dispatching',
        followupServer ? testSequenceDelayMsRef.current : 0
      );

      const joinLink = await requestFreshJoinLink(server, 'redirect');
      if (!joinLink) {
        return null;
      }

      window.setTimeout(() => {
        try {
          connectorWindow.location.href = joinLink;
          connectorWindow.focus();
          appendLog(
            followupServer
              ? `Переход отправлен в Steam для ${server.name}. Отдельного ответа от Steam или Squad браузер не получит.`
              : `Переход отправлен в Steam для ${server.name}. Дальше ждём только новый снимок.`
          );
          connectorWindowStateRef.current = {
            serverKey: getServerSelectionKey(server),
            followupServerKey: getServerSelectionKey(followupServer),
            phase: 'redirect_sent'
          };
          window.setTimeout(() => {
            renderConnectorWindow(
              connectorWindow,
              server,
              followupServer,
              'redirect_sent',
              followupServer ? testSequenceDelayMsRef.current : 0
            );
          }, 1200);
        } catch {
          appendLog('Переход отменён: браузер не дал обновить служебное окно.');
        }
      }, 40);

      return joinLink;
    } catch {
      appendLog('Переход отменён: браузер не дал обновить служебное окно.');
      return null;
    }
  };

  const scheduleSequenceStep = (remaining: ExporterServerSnapshot[]) => {
    clearPendingSequence();

    const nextDelayMs = testSequenceDelayMsRef.current;
    if (!remaining.length || nextDelayMs <= 0) return;

    const [scheduledNextServer, ...tail] = remaining;
    const nextServerKey = getServerSelectionKey(scheduledNextServer);
    const nextRedirectAt = Date.now() + nextDelayMs;

    setPendingSequence({ remaining, nextRedirectAt });
    appendLog(
      `Запланирован следующий переход через ${Math.ceil(nextDelayMs / 1000)} с: ${scheduledNextServer.name}`
    );

    sequenceTimerRef.current = window.setTimeout(() => {
      sequenceTimerRef.current = null;
      setPendingSequence(null);

      void (async () => {
        if (!enabledRef.current) {
          appendLog(`Следующий переход пропущен: автоконнектор уже выключен.`);
          return;
        }

        const latestNextServer =
          findServerBySelectionKey(snapshotRef.current, nextServerKey) || scheduledNextServer;
        const dispatchedJoinLink = await triggerJoinLink(latestNextServer, tail[0] || null);
        if (!dispatchedJoinLink) {
          return;
        }

        appendLog(`Следующий переход запущен: ${latestNextServer.name}`);
        scheduleSequenceStep(tail);
      })();
    }, nextDelayMs);
  };

  const resetRedirectState = () => {
    setLastProcessedTimestamp(0);
    saveLastProcessedTimestamp(0);
    setCooldownUntil(0);
    saveCooldownUntil(0);
    setJoinLinkRequestServerKey('');
    activeRedirectServerKeyRef.current = '';
    pendingRedirectServerKeyRef.current = '';
    redirectInFlightRef.current = false;
    connectorWindowStateRef.current = null;
  };

  const handleTestSequenceDelayChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextSeconds = normalizeDelaySeconds(Number(event.target.value));
    const nextDelayMs = nextSeconds * 1000;
    const pendingRemaining = pendingSequence?.remaining || [];

    testSequenceDelayMsRef.current = nextDelayMs;
    setTestSequenceDelayMsOverride(nextDelayMs);
    saveTestSequenceDelayMs(nextDelayMs);
    appendLog(`Тестовая задержка следующего перехода обновлена: ${nextSeconds} с.`);

    if (pendingRemaining.length && enabledRef.current && modeRef.current === 'test') {
      clearPendingSequence();
      scheduleSequenceStep(pendingRemaining);
      appendLog(`Ожидающий следующий переход пересоздан с новой задержкой.`);
    }
  };

  const handleTestSequenceDelayReset = () => {
    const pendingRemaining = pendingSequence?.remaining || [];

    testSequenceDelayMsRef.current = configuredTestSequenceDelayMs;
    setTestSequenceDelayMsOverride(0);
    saveTestSequenceDelayMs(0);
    appendLog(
      `Тестовая задержка следующего перехода сброшена к конфигу: ${configuredTestSequenceDelaySeconds} с.`
    );

    if (pendingRemaining.length && enabledRef.current && modeRef.current === 'test') {
      clearPendingSequence();
      scheduleSequenceStep(pendingRemaining);
      appendLog(`Ожидающий следующий переход пересоздан с задержкой из конфига.`);
    }
  };

  const handlePermissionsCheck = async () => {
    const result = await runPermissionCheck();
    setPermissions(result);
    savePermissions(result);
    appendLog(
      `Проверка браузера: окно=${formatBool(result.popupAllowed)}, Steam=${formatBool(result.steamProtocolReady)}`
    );
  };

  const handleDirectJoin = async (server: ExporterServerSnapshot) => {
    if (!canRequestJoinLink(server)) {
      appendLog(`Прямое подключение недоступно: ${server.name} сейчас оффлайн.`);
      return;
    }

    const joinLink = await requestFreshJoinLink(server, 'direct');
    if (!joinLink) return;

    try {
      appendLog(`Прямое подключение: ${server.name}`);
      window.location.href = joinLink;
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

  const startRedirectPlan = async (
    redirectPlan: ExporterServerSnapshot[],
    snapshotTimestamp: number,
    cooldownMs: number
  ): Promise<boolean> => {
    const [firstTarget, ...followups] = redirectPlan;
    if (!firstTarget) {
      appendLog('Переход отменён: нет подходящего сервера.');
      return false;
    }

    const targetServerKey = getServerSelectionKey(firstTarget);
    if (redirectInFlightRef.current) {
      if (pendingRedirectServerKeyRef.current === targetServerKey) {
        return false;
      }

      appendLog('Переход отменён: предыдущий переход ещё готовится.');
      return false;
    }

    redirectInFlightRef.current = true;
    pendingRedirectServerKeyRef.current = targetServerKey;
    clearPendingSequence();

    try {
      const dispatchedJoinLink = await triggerJoinLink(firstTarget, followups[0] || null);
      if (!dispatchedJoinLink) {
        return false;
      }

      const nextCooldownUntil = Date.now() + cooldownMs;
      activeRedirectServerKeyRef.current = targetServerKey;
      setLastProcessedTimestamp(snapshotTimestamp);
      saveLastProcessedTimestamp(snapshotTimestamp);
      setCooldownUntil(nextCooldownUntil);
      saveCooldownUntil(nextCooldownUntil);

      appendLog(`Переход запущен: ${firstTarget.name}`);
      scheduleSequenceStep(followups);
      return true;
    } finally {
      if (pendingRedirectServerKeyRef.current === targetServerKey) {
        pendingRedirectServerKeyRef.current = '';
      }
      redirectInFlightRef.current = false;
    }
  };

  const refreshSnapshot = async (options?: RefreshSnapshotOptions) => {
    setIsFetching(true);
    setFatalError(null);

    try {
      const nextSnapshot = await fetchCombinedSnapshot(config.exporters);
      applySnapshot(nextSnapshot, options, 'manual');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'неизвестная ошибка снимка';
      setFatalError(message);
      appendLog(`Не удалось получить снимок: ${message}`);
    } finally {
      setIsFetching(false);
    }
  };

  const triggerPeriodicReconnect = useEffectEvent(() => {
    if (!enabledRef.current || modeRef.current !== 'production') return;
    if (isFetchingRef.current) return;

    const targetServer = selection?.targetServer;
    if (!targetServer) return;

    appendLog(`Периодическое переподключение: запрашиваю свежий снимок для ${targetServer.name}.`);
    void refreshSnapshot({ forceRedirect: true });
  });

  useEffect(() => {
    if (!enabled || activeMode !== 'production' || periodicReconnectMs <= 0) return;

    const timer = window.setInterval(() => {
      triggerPeriodicReconnect();
    }, periodicReconnectMs);

    return () => window.clearInterval(timer);
  }, [activeMode, enabled, periodicReconnectMs]);

  useEffect(() => {
    if (typeof window.EventSource === 'undefined') {
      const message = 'Браузер не поддерживает EventSource/SSE.';
      setFatalError(message);
      setIsFetching(false);
      appendLog(`Поток снимков завершился ошибкой: ${message}`);
      return;
    }

    setIsFetching(true);
    setFatalError(null);

    const unsubscribe = subscribeCombinedSnapshot(config.exporters, (nextSnapshot) => {
      setIsFetching(false);
      applySnapshot(nextSnapshot, undefined, 'stream');
    });

    return () => unsubscribe();
  }, [config.exporters]);

  const handleEnable = async () => {
    if (!permissions) {
      appendLog('Автоконнектор не запущен: сначала вручную выполните локальную проверку браузера.');
      return;
    }

    if (!permissions.popupAllowed || !permissions.steamProtocolReady) {
      appendLog('Автоконнектор не запущен: браузерные разрешения не подтверждены.');
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
        await startRedirectPlan(
          immediateRedirectPlan,
          snapshot.timestamp,
          isTestModeActive ? testCooldownMs : effectivePolicy.cooldownMs
        )
      ) {
        appendLog(
          isTestModeActive
            ? 'Тестовый режим: первый переход запущен сразу из текущего снимка.'
            : 'Боевой режим: первый переход запущен сразу из текущего снимка.'
        );
        return;
      }
    }

    if (immediateRedirectPlan.length && snapshot.timestamp > 0 && !currentSnapshotIsFresh) {
      appendLog('Текущий снимок устарел: запрашиваю свежие данные перед первым переходом.');
    }

    void refreshSnapshot({ forceRedirect: true });
  };

  const handleDisable = () => {
    clearPendingSequence();
    closeConnectorWindow();
    setJoinLinkRequestServerKey('');
    activeRedirectServerKeyRef.current = '';
    pendingRedirectServerKeyRef.current = '';
    redirectInFlightRef.current = false;
    connectorWindowStateRef.current = null;
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
  const diagnosticsIssueCount = snapshot.errors.length + (fatalError ? 1 : 0);
  const debugLogCount = logs.length;
  const nextActionValue = pendingSequence
    ? formatCountdown(nextFollowupCountdown)
    : cooldownLeftMs > 0
      ? formatCountdown(cooldownLeftMs)
      : 'Готово';
  const nextActionCaption = pendingSequence
    ? nextFollowupServer?.name || 'Ждём следующий сервер'
    : enabled
      ? 'Коннектор ждёт новый снимок'
      : 'Коннектор выключен';
  const heroMeshLabel = `${liveServerCount}/${snapshot.servers.length || config.exporters.length}`;
  const heroPriorityLabel = effectivePolicy.priorityOrder.join(' → ');
  const heroCadenceLabel =
    periodicReconnectMs > 0 ? `${Math.round(periodicReconnectMs / 60000)} мин цикл` : 'вручную';
  const browserCheckLabel = permissionsReady ? 'Браузер проверен' : 'Проверить браузер';
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
        ? ['Кнопки: «Боевой» или «Тест»', 'Этот блок определяет сценарий перехода']
        : ['Кнопка: «Боевой»', 'Тестовый режим не настроен в конфиге']
    },
    {
      id: 'browser',
      step: '2',
      title: 'Нажми «Проверить браузер»',
      description:
        'Проверь, что браузер умеет открыть служебное окно и передать ссылку в Steam. Пока оба индикатора не зелёные, автоконнектор не запустится.',
      hints: ['Кнопка: «Проверить браузер»', 'Смотри статусы окна и Steam']
    },
    {
      id: 'connector',
      step: '3',
      title: 'Включи «Автоконнектор»',
      description:
        'После запуска откроется служебное окно коннектора. Оно занимается запросом свежей ссылки входа и переходом в Steam и должно оставаться открытым, пока идёт работа. Если после отправки оно осталось на служебной карточке, это нормально: отдельного ответа от Steam или Squad браузер не получает.',
      hints: ['Кнопка: «Автоконнектор»', 'Служебное окно не закрывать']
    },
    {
      id: 'manual',
      step: '4',
      title: 'Следи за целью и, если нужно, жми прямой вход',
      description:
        'Ниже видно целевой сервер, слабую сторону и карточку выбранного сервера. Если нужен ручной обход автоматики, используй кнопку «Подключиться напрямую».',
      hints: ['Карточки: «Текущая цель» и «Куда заходить»', 'Кнопка в карточке сервера: «Подключиться напрямую»']
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
    <div className="shell modern-shell" style={BRAND_STYLE} data-testid="app-shell">
      <header className="hero hero-redesign" data-testid="hero">
        <div className="hero-main hero-main-tight">
          <div className="hero-topline">
            <div className="hero-brand">
              <div className="hero-logo-shell">
                <img className="hero-logo" src={projectLogo} alt={`Логотип ${config.app.title}`} />
              </div>
              <div className="hero-brand-copy">
                <span className="hero-brand-kicker">Mdj BSS</span>
                <span className="hero-brand-subtitle">пульт автоподключения</span>
              </div>
            </div>

            <InlineHelp
              label="Справка по главному экрану"
              title="Основное окно AutoSeed"
              description="Главный экран. Здесь включается автоконнектор, выбирается режим, видна цель и состояния браузера с экспортерами."
              testId="hero-help"
            />
          </div>

          <p className="eyebrow">BSS Seed Connect</p>
          <h1 data-testid="hero-title">{config.app.title}</h1>
          <p className="hero-copy hero-copy-tight">
            Включай коннектор или сразу смотри онлайн, состав сторон и баланс часов по обоим
            серверам.
          </p>

          <div className="hero-ribbon" data-testid="hero-ribbon">
            <span className="hero-ribbon-tag">Онлайн</span>
            <p>
              Пульт работает от публичного снимка, а свежую ссылку входа забирает только в момент
              реального перехода.
            </p>
          </div>

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

          <div className="hero-glance-grid" data-testid="hero-glance-grid">
            <article className="hero-glance-card hero-glance-card-emphasis">
              <span className="hero-glance-label">Контур</span>
              <strong>{heroMeshLabel}</strong>
              <p>узлов сейчас в сети</p>
            </article>
            <article className="hero-glance-card">
              <span className="hero-glance-label">Следующее действие</span>
              <strong>{nextActionValue}</strong>
              <p>{nextActionCaption}</p>
            </article>
            <article className="hero-glance-card">
              <span className="hero-glance-label">Приоритет</span>
              <strong>{heroPriorityLabel}</strong>
              <p>{heroCadenceLabel}</p>
            </article>
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
                data-testid="mode-production"
              >
                Боевой
              </button>
              <button
                className={classNames('segment', isTestModeActive && 'segment-active')}
                onClick={!productionMode ? undefined : handleModeToggle}
                disabled={!hasConfiguredTestMode || isTestModeActive}
                data-testid="mode-test"
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
            data-testid="power-toggle"
            aria-pressed={enabled}
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
              className={classNames(
                'button',
                'guide-button',
                'guide-focus',
                permissionsReady ? 'button-success guide-focus-success' : 'button-primary guide-focus-primary'
              )}
              onClick={() => void handlePermissionsCheck()}
              data-testid="check-browser-button"
            >
              <span className="guide-inline-step" aria-hidden="true">
                2
              </span>
              <span>{browserCheckLabel}</span>
            </button>
            <button
              className="button"
              onClick={() => void refreshSnapshot()}
              data-testid="refresh-snapshot-button"
            >
              Обновить сейчас
            </button>
          </div>

          {hasConfiguredTestMode && isTestModeActive ? (
            <div className="test-delay-card">
              <label className="delay-field">
                <span>Следом</span>
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
            <div className="signal-card signal-card-with-help">
              <div className="signal-card-main">
                <span
                  className={classNames(
                    'signal-dot',
                    permissions?.popupAllowed ? 'signal-dot-good' : 'signal-dot-bad'
                  )}
                />
                <div>
                  <strong>Окно</strong>
                  <p>{permissions?.popupAllowed ? 'готов' : 'не готов'}</p>
                </div>
              </div>
              <InlineHelp
                label="Что делает окно"
                title="Служебное окно коннектора"
                description="Открывается после включения автоконнектора. Оно нужно только для запроса свежей ссылки входа, перехода в Steam и последующих переходов. После отправки ссылки окно может визуально остаться на служебной карточке: Steam и Squad не присылают браузеру отдельный ответ."
                testId="popup-help"
              />
            </div>
            <div className="signal-card signal-card-with-help">
              <div className="signal-card-main">
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
              <InlineHelp
                label="Что значит Steam"
                title="Steam и Squad"
                description="Это финальная точка подключения. Держи Squad открытым в главном меню, чтобы переход в клиент проходил быстрее и стабильнее."
                testId="steam-help"
              />
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
                <strong>Экспортеры</strong>
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
                <strong>Цель</strong>
                <p>{displayTargetServer ? 'есть' : 'нет'}</p>
              </div>
            </div>
          </div>
        </aside>
      </header>

      <details className="panel panel-span guide-spoiler">
        <summary className="details-summary">
          <span>Как запустить</span>
          <span className="badge badge-muted">{quickStartSteps.length} шага</span>
        </summary>
        <div className="guide-spoiler-body">
          <p className="guide-spoiler-copy">
            Весь сценарий укладывается в четыре действия: выбрать режим, проверить браузер,
            включить коннектор и при необходимости зайти вручную в нужную цель.
          </p>

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

      {(fatalError || snapshot.errors.length) && (
        <section className="alert-strip">
          {fatalError ? <p>{fatalError}</p> : null}
          {snapshot.errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </section>
      )}

      <section className="section-shell">
        <div className="section-head">
          <div>
            <span className="section-eyebrow">Сводка</span>
            <h2>Что происходит прямо сейчас</h2>
          </div>
          <p>Сводка по цели, таймингам и общей доступности контура.</p>
        </div>

        <div className="overview-grid">
          <article
            className="overview-card overview-card-spotlight"
            data-testid="overview-target"
          >
            <span className="overview-label">Текущая цель</span>
            <strong>{displayTargetServer?.name || 'Подходящий сервер не найден'}</strong>
            <p>{statusText}</p>
          </article>

          <article className="overview-card">
            <span className="overview-label">Куда заходить</span>
            <strong>{weakSideSuggestion?.name || 'Стороны пока ровные'}</strong>
            <p>{weakSideSuggestion ? 'Слабая сторона на текущей цели' : 'Ждём состав сторон'}</p>
          </article>

          <article className="overview-card">
            <span className="overview-label">Снимок</span>
            <strong>{formatCompactTimestamp(snapshot.generatedAt)}</strong>
            <p>
              {liveServerCount}/{snapshot.servers.length || config.exporters.length} серверов в сети
            </p>
          </article>

          <article className="overview-card">
            <span className="overview-label">{pendingSequence ? 'Следующий переход' : 'Пауза'}</span>
            <strong>
              {pendingSequence
                ? formatCountdown(nextFollowupCountdown)
                : cooldownLeftMs > 0
                  ? formatCountdown(cooldownLeftMs)
                  : '—'}
            </strong>
            <p>
              {pendingSequence
                ? nextFollowupServer?.name || 'Ждём следующий сервер'
                : enabled
                  ? 'Коннектор ждёт новый снимок'
                  : 'Коннектор не активен'}
            </p>
          </article>
        </div>
      </section>

      <section className="section-shell server-switcher">
        <div className="section-head">
          <div>
            <span className="section-eyebrow">Серверы</span>
            <h2>Быстрый выбор узла</h2>
          </div>
          <p>Выбери карточку ниже, чтобы развернуть полную тактическую панель сервера.</p>
        </div>

        <div className="server-switcher-track" data-testid="server-switcher-track">
          {orderedServers.map((server) => {
            const serverKey = getServerSelectionKey(server);
            const isActive = serverKey === getServerSelectionKey(activeServer);
            const isTarget = isSameServer(server, displayTargetServer);
            const canDirectJoin = canRequestJoinLink(server);
            const joinRequestPending = isJoinLinkRequestPending(server);
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
                data-testid={`server-card-${server.id}`}
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
                      {server.online ? 'в сети' : 'оффлайн'}
                    </span>
                  </div>
                  <div className="server-switcher-meta">
                    <span>{server.playerCount}/{server.maxPlayers || '—'}</span>
                    {isTarget ? <span className="server-switcher-accent">цель</span> : null}
                  </div>
                  <p>{switcherHoursLine}</p>
                </button>

                <div className="server-switcher-actions">
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => void handleDirectJoin(server)}
                    disabled={!canDirectJoin || joinRequestPending}
                    data-testid={`direct-join-${server.id}`}
                  >
                    {joinRequestPending
                      ? 'Запрашиваем ссылку...'
                      : canDirectJoin
                        ? 'Подключиться'
                        : 'Сервер оффлайн'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="section-shell server-stack">
        <div className="section-head">
          <div>
            <span className="section-eyebrow">Выбранный сервер</span>
            <h2>Текущая тактическая панель</h2>
          </div>
          <p>Нагрузка, прогресс рассида, состав сторон и лидерские часы по выбранному серверу.</p>
        </div>

        {activeServer ? (() => {
          const server = activeServer;
          const canDirectJoin = canRequestJoinLink(server);
          const joinRequestPending = isJoinLinkRequestPending(server);
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
              data-testid="active-server-board"
            >
              <div className="server-board-top">
                <div className="server-title-block">
                  <div className="server-title-row">
                    <div className="server-title-main">
                      <h2>{server.name}</h2>
                      <InlineHelp
                        label="Справка по карточке сервера"
                        title="Карточка выбранного сервера"
                        description="Это главный блок цели ниже переключателя серверов. Здесь видно текущий онлайн, прогресс рассида, слабую сторону и ручную кнопку входа."
                        testId="server-help"
                      />
                    </div>
                    <div className="server-chip-row">
                      <span
                        className={classNames(
                          'server-state',
                          server.online ? 'state-live' : 'state-dead'
                        )}
                      >
                        {server.online ? 'в сети' : 'оффлайн'}
                      </span>
                      <span
                        className={classNames(
                          'server-state',
                          server.isSeedCandidate ? 'state-live' : 'state-dead'
                        )}
                      >
                        сид
                      </span>
                      <span className="server-state state-join">вход по запросу</span>
                      {isSameServer(server, displayTargetServer) ? (
                        <span className="server-state state-target">цель</span>
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
                      onClick={() => void handleDirectJoin(server)}
                      disabled={!canDirectJoin || joinRequestPending}
                      data-testid="primary-direct-join"
                    >
                      <span className="guide-inline-step" aria-hidden="true">
                        4
                      </span>
                      <span>
                        {joinRequestPending
                          ? 'Запрашиваем ссылку...'
                          : canDirectJoin
                            ? 'Подключиться напрямую'
                            : 'Сервер оффлайн'}
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
                    <span>Прогресс сида</span>
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
                    Состав сторон пока не поступил из экспортера.
                  </div>
                ) : null}
              </div>
            </article>
          );
        })() : (
          <article className="server-board">
            <div className="roster-empty">Серверы пока не пришли из экспортера.</div>
          </article>
        )}
      </section>

      <section className="panel panel-span panel-details" data-testid="diagnostics-panel">
        <div className="details-summary panel-section-head">
          <span>Правила и диагностика</span>
          {diagnosticsIssueCount > 0 ? (
            <span className="badge badge-muted">{diagnosticsIssueCount}</span>
          ) : null}
        </div>
        <p className="panel-section-copy">
          Блок всегда открыт: здесь сразу видны текущие правила выбора цели, время последних
          обновлений и возможные ошибки.
        </p>
        <div className="diagnostics-grid">
          <div className="summary-stack">
            <div className="summary-row">
              <span>Режим</span>
              <strong>{productionMode ? 'Боевой' : `Тест ${testSequencePlanLabel}`}</strong>
            </div>
            <div className="summary-row">
              <span>Последний снимок</span>
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
              <span>Ночная цель</span>
              <strong>{effectivePolicy.nightPreferredServerId}</strong>
            </div>
            <div className="rule-card">
              <span>Лимит сида</span>
              <strong>&lt; {effectivePolicy.maxSeedPlayers}</strong>
            </div>
            <div className="rule-card">
              <span>Порог переключения</span>
              <strong>&gt; {effectivePolicy.switchDelta}</strong>
            </div>
            <div className="rule-card">
              <span>Поток данных</span>
              <strong>SSE /events + запасной снимок</strong>
            </div>
            {hasConfiguredTestMode ? (
              <>
                <div className="rule-card">
                  <span>Тестовый план</span>
                  <strong>{testSequencePlanLabel}</strong>
                </div>
                <div className="rule-card">
                  <span>Задержка следующего перехода</span>
                  <strong>
                    {Math.round(testSequenceDelayMs / 1000)} с
                    {hasManualTestSequenceDelay ? ' · локально' : ''}
                  </strong>
                </div>
                <div className="rule-card">
                  <span>Пауза теста</span>
                  <strong>{Math.round(testCooldownMs / 1000)} с</strong>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </section>

      <details className="panel panel-span panel-details" data-testid="debug-log-panel">
        <summary className="details-summary">
          <span>Журнал событий</span>
          {debugLogCount > 0 ? <span className="badge badge-muted">{debugLogCount}</span> : null}
        </summary>
        <div className="log-box">
          {logs.length ? logs.map((line) => <pre key={line}>{line}</pre>) : <pre>Лог пуст.</pre>}
        </div>
      </details>
    </div>
  );
}
