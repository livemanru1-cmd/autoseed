import type {
  CombinedSnapshot,
  ExporterEndpointConfig,
  ExporterJoinLinkResponse,
  ExporterPlayerSnapshot,
  ExporterServerSnapshot,
  ExporterSnapshotPlayerResponse,
  ExporterSnapshotResponse,
  ExporterSnapshotServerResponse,
  ExporterSnapshotSquadResponse,
  ExporterSnapshotTeamResponse,
  ExporterSquadSnapshot,
  ExporterTeamSnapshot
} from '../types';

type ExporterSnapshotState = {
  name: string;
  snapshotUrl: string;
  joinLinkUrl: string;
  eventsUrl: string;
  initialized: boolean;
  servers: ExporterServerSnapshot[];
  timestamp: number;
  generatedAt: string;
  error: string | null;
};

type ExporterStreamSubscription = {
  state: ExporterSnapshotState;
  eventSource: EventSource | null;
  pollTimerId: number | null;
  reconnectTimerId: number | null;
  reconnectAttempt: number;
};

const SNAPSHOT_POLL_INTERVAL_MS = 30_000;
const STREAM_RECONNECT_BASE_DELAY_MS = 60_000;
const STREAM_RECONNECT_MAX_DELAY_MS = 5 * 60_000;
const SNAPSHOT_HEADERS = {
  Accept: 'application/json'
} as const;

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function mapPlayer(player: ExporterSnapshotPlayerResponse): ExporterPlayerSnapshot {
  return {
    eosId: player.eosId || null,
    steamId: player.steamId || null,
    name: player.name || 'Игрок',
    teamId: Number(player.teamId) || null,
    teamName: player.teamName || null,
    squadId: Number(player.squadId) || null,
    squadName: player.squadName || null,
    role: player.role || null,
    isLeader: Boolean(player.isLeader),
    isCommander: Boolean(player.isCommander),
    playtimeSeconds:
      typeof player.playtimeSeconds === 'number' ? player.playtimeSeconds : null,
    playtimeHours: typeof player.playtimeHours === 'number' ? player.playtimeHours : null,
    playtimeSource: player.playtimeSource || null
  };
}

function mapSquad(squad: ExporterSnapshotSquadResponse): ExporterSquadSnapshot {
  return {
    id: Number(squad.id) || null,
    name: squad.name || `Сквад ${Number(squad.id) || 0}`,
    playerCount: Number(squad.playerCount) || 0,
    totalPlaytimeSeconds:
      typeof squad.totalPlaytimeSeconds === 'number' ? squad.totalPlaytimeSeconds : null,
    totalPlaytimeHours: typeof squad.totalPlaytimeHours === 'number' ? squad.totalPlaytimeHours : null,
    leaderName: squad.leaderName || null,
    leaderPlaytimeSeconds:
      typeof squad.leaderPlaytimeSeconds === 'number' ? squad.leaderPlaytimeSeconds : null,
    leaderPlaytimeHours:
      typeof squad.leaderPlaytimeHours === 'number' ? squad.leaderPlaytimeHours : null
  };
}

function mapTeam(team: ExporterSnapshotTeamResponse): ExporterTeamSnapshot {
  return {
    id: Number(team.id) || null,
    name: team.name || `Сторона ${Number(team.id) || 0}`,
    playerCount: Number(team.playerCount) || 0,
    playersWithHours: Number(team.playersWithHours) || 0,
    totalPlaytimeSeconds:
      typeof team.totalPlaytimeSeconds === 'number' ? team.totalPlaytimeSeconds : null,
    totalPlaytimeHours: typeof team.totalPlaytimeHours === 'number' ? team.totalPlaytimeHours : null,
    leaderPlaytimeSeconds:
      typeof team.leaderPlaytimeSeconds === 'number' ? team.leaderPlaytimeSeconds : null,
    leaderPlaytimeHours:
      typeof team.leaderPlaytimeHours === 'number' ? team.leaderPlaytimeHours : null,
    commanderPlaytimeSeconds:
      typeof team.commanderPlaytimeSeconds === 'number' ? team.commanderPlaytimeSeconds : null,
    commanderPlaytimeHours:
      typeof team.commanderPlaytimeHours === 'number' ? team.commanderPlaytimeHours : null,
    squads: Array.isArray(team.squads) ? team.squads.map(mapSquad) : [],
    players: Array.isArray(team.players) ? team.players.map(mapPlayer) : []
  };
}

function mapServer(
  server: ExporterSnapshotServerResponse,
  sourceUrl: string,
  joinLinkUrl: string
): ExporterServerSnapshot {
  return {
    id: Number(server.id) || 0,
    code: server.code || `server-${Number(server.id) || 0}`,
    name: server.name || server.code || sourceUrl,
    playerCount: Number(server.playerCount) || 0,
    maxPlayers: Number(server.maxPlayers) || 0,
    queueLength: Number(server.queueLength) || 0,
    currentLayer: server.currentLayer,
    gameMode: server.gameMode,
    isSeedCandidate: server.isSeedCandidate !== false,
    online: Boolean(server.online),
    teams: Array.isArray(server.teams) ? server.teams.map(mapTeam) : [],
    players: Array.isArray(server.players) ? server.players.map(mapPlayer) : [],
    updatedAt: Number(server.updatedAt) || Date.now(),
    sourceUrl,
    joinLinkUrl
  };
}

function sortServers(servers: ExporterServerSnapshot[]): ExporterServerSnapshot[] {
  return servers.slice().sort((left, right) => {
    if (left.id !== right.id) return left.id - right.id;
    return left.name.localeCompare(right.name, 'ru');
  });
}

function createExporterSnapshotState(
  exporterConfig: ExporterEndpointConfig
): ExporterSnapshotState {
  const baseUrl = normalizeBaseUrl(exporterConfig.baseUrl);

  return {
    name: exporterConfig.name,
    snapshotUrl: `${baseUrl}/snapshot`,
    joinLinkUrl: `${baseUrl}/join-link`,
    eventsUrl: `${baseUrl}/events`,
    initialized: false,
    servers: [],
    timestamp: 0,
    generatedAt: '',
    error: null
  };
}

function buildCombinedSnapshot(states: ExporterSnapshotState[]): CombinedSnapshot {
  const timestamps = states
    .map((state) => Number(state.timestamp) || 0)
    .filter((value) => value > 0);
  const latestState = states
    .filter((state) => state.timestamp > 0)
    .sort((left, right) => (Number(right.timestamp) || 0) - (Number(left.timestamp) || 0))[0];

  return {
    timestamp: timestamps.length ? Math.max(...timestamps) : Date.now(),
    generatedAt: latestState?.generatedAt || new Date().toISOString(),
    servers: sortServers(states.flatMap((state) => state.servers)),
    errors: states
      .map((state) => state.error)
      .filter((value): value is string => Boolean(value))
  };
}

function applySnapshotPayload(
  state: ExporterSnapshotState,
  payload: ExporterSnapshotResponse
): void {
  state.initialized = true;
  state.error = null;
  state.timestamp = Number(payload.timestamp) || Date.now();
  state.generatedAt = payload.generatedAt || new Date(state.timestamp).toISOString();
  state.servers = Array.isArray(payload.servers)
    ? payload.servers.map((server) => mapServer(server, state.snapshotUrl, state.joinLinkUrl))
    : [];
}

function applySnapshotError(state: ExporterSnapshotState, message: string): void {
  state.initialized = true;
  state.error = `${state.name}: ${message}`;

  if (state.timestamp > 0) {
    return;
  }

  state.servers = [];
  state.timestamp = 0;
  state.generatedAt = '';
}

function clearTimer(timerId: number | null): null {
  if (timerId !== null) {
    window.clearTimeout(timerId);
  }

  return null;
}

function getReconnectDelay(attempt: number): number {
  return Math.min(
    STREAM_RECONNECT_BASE_DELAY_MS * 2 ** attempt,
    STREAM_RECONNECT_MAX_DELAY_MS
  );
}

async function buildHttpError(response: Response): Promise<string> {
  const statusText = `HTTP ${response.status}`;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const payload = (await response.clone().json()) as {
        error?: string;
        message?: string;
      };
      const detail = payload.error || payload.message;
      if (detail) {
        return `${statusText}: ${detail}`;
      }
    } catch {
      // Ignore invalid JSON error bodies and fall back to text/status.
    }
  }

  try {
    const text = (await response.text()).trim();
    if (text) {
      return `${statusText}: ${text}`;
    }
  } catch {
    // Ignore unreadable error bodies and fall back to status only.
  }

  return statusText;
}

async function fetchSnapshotPayload(snapshotUrl: string): Promise<ExporterSnapshotResponse> {
  const response = await fetch(snapshotUrl, {
    headers: SNAPSHOT_HEADERS,
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(await buildHttpError(response));
  }

  return (await response.json()) as ExporterSnapshotResponse;
}

export async function fetchServerJoinLink(joinLinkUrl: string): Promise<string> {
  const response = await fetch(joinLinkUrl, {
    headers: SNAPSHOT_HEADERS,
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(await buildHttpError(response));
  }

  const payload = (await response.json()) as ExporterJoinLinkResponse;
  const joinLink = typeof payload.joinLink === 'string' ? payload.joinLink.trim() : '';
  if (!joinLink) {
    throw new Error('Join link response is missing joinLink.');
  }

  return joinLink;
}

export async function fetchCombinedSnapshot(
  exporters: ExporterEndpointConfig[]
): Promise<CombinedSnapshot> {
  const states = exporters.map(createExporterSnapshotState);

  await Promise.all(
    states.map(async (state) => {
      try {
        const payload = await fetchSnapshotPayload(state.snapshotUrl);
        applySnapshotPayload(state, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown exporter error';
        applySnapshotError(state, message);
      }
    })
  );

  return buildCombinedSnapshot(states);
}

export function subscribeCombinedSnapshot(
  exporters: ExporterEndpointConfig[],
  onSnapshot: (snapshot: CombinedSnapshot) => void
): () => void {
  const subscriptions: ExporterStreamSubscription[] = exporters.map((exporterConfig) => ({
    state: createExporterSnapshotState(exporterConfig),
    eventSource: null,
    pollTimerId: null,
    reconnectTimerId: null,
    reconnectAttempt: 0
  }));
  const states = subscriptions.map((subscription) => subscription.state);
  let closed = false;

  const emitSnapshot = () => {
    if (closed || !states.every((state) => state.initialized)) return;
    onSnapshot(buildCombinedSnapshot(states));
  };

  const stopPolling = (subscription: ExporterStreamSubscription) => {
    subscription.pollTimerId = clearTimer(subscription.pollTimerId);
  };

  const stopReconnect = (subscription: ExporterStreamSubscription) => {
    subscription.reconnectTimerId = clearTimer(subscription.reconnectTimerId);
  };

  const stopEventSource = (subscription: ExporterStreamSubscription) => {
    if (!subscription.eventSource) return;
    subscription.eventSource.close();
    subscription.eventSource = null;
  };

  const schedulePolling = (subscription: ExporterStreamSubscription, delayMs = 0) => {
    if (closed || subscription.eventSource || subscription.pollTimerId !== null) return;

    subscription.pollTimerId = window.setTimeout(() => {
      subscription.pollTimerId = null;
      void (async () => {
        try {
          const payload = await fetchSnapshotPayload(subscription.state.snapshotUrl);
          applySnapshotPayload(subscription.state, payload);
          emitSnapshot();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown exporter error';
          applySnapshotError(subscription.state, message);
          emitSnapshot();
        } finally {
          if (!closed && subscription.eventSource === null) {
            schedulePolling(subscription, SNAPSHOT_POLL_INTERVAL_MS);
          }
        }
      })();
    }, delayMs);
  };

  const openEventSource = (subscription: ExporterStreamSubscription) => {
    if (closed || subscription.eventSource) return;

    const eventSource = new EventSource(subscription.state.eventsUrl);
    subscription.eventSource = eventSource;

    eventSource.onopen = () => {
      stopPolling(subscription);
    };

    eventSource.addEventListener('snapshot', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as ExporterSnapshotResponse;
        applySnapshotPayload(subscription.state, payload);
        subscription.reconnectAttempt = 0;
        stopReconnect(subscription);
        stopPolling(subscription);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid snapshot event payload';
        stopEventSource(subscription);
        applySnapshotError(subscription.state, message);
        emitSnapshot();
        schedulePolling(subscription);

        if (subscription.reconnectTimerId === null) {
          const reconnectDelayMs = getReconnectDelay(subscription.reconnectAttempt);
          subscription.reconnectAttempt += 1;
          subscription.reconnectTimerId = window.setTimeout(() => {
            subscription.reconnectTimerId = null;
            if (closed) return;
            openEventSource(subscription);
          }, reconnectDelayMs);
        }

        return;
      }

      emitSnapshot();
    });

    eventSource.onerror = () => {
      if (closed) return;

      stopEventSource(subscription);
      applySnapshotError(subscription.state, 'event stream unavailable');
      emitSnapshot();

      schedulePolling(subscription);

      if (subscription.reconnectTimerId !== null) return;

      const reconnectDelayMs = getReconnectDelay(subscription.reconnectAttempt);
      subscription.reconnectAttempt += 1;
      subscription.reconnectTimerId = window.setTimeout(() => {
        subscription.reconnectTimerId = null;
        if (closed) return;
        openEventSource(subscription);
      }, reconnectDelayMs);
    };
  };

  subscriptions.forEach((subscription) => openEventSource(subscription));

  return () => {
    closed = true;
    subscriptions.forEach((subscription) => {
      stopEventSource(subscription);
      stopPolling(subscription);
      stopReconnect(subscription);
    });
  };
}
