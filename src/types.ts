export type AppConfig = {
  app: {
    title: string;
    debugLogLimit?: number;
    testMode?: TestModeConfig;
  };
  policy?: Partial<SeedPolicy>;
  exporters: ExporterEndpointConfig[];
};

export type TestModeConfig = {
  sequenceServerIds: number[];
  delayMs: number;
  cooldownMs: number;
};

export type SeedPolicy = {
  timezone: string;
  nightWindowStart: string;
  nightWindowEnd: string;
  nightPreferredServerId: number;
  maxSeedPlayers: number;
  priorityOrder: number[];
  switchDelta: number;
  cooldownMs: number;
  periodicReconnectMs: number;
};

export type ExporterEndpointConfig = {
  name: string;
  baseUrl: string;
};

export type ExporterPlayerSnapshot = {
  eosId?: string | null;
  steamId?: string | null;
  name: string;
  teamId?: number | null;
  teamName?: string | null;
  squadId?: number | null;
  squadName?: string | null;
  role?: string | null;
  isLeader: boolean;
  isCommander: boolean;
  playtimeSeconds?: number | null;
  playtimeHours?: number | null;
  playtimeSource?: string | null;
};

export type ExporterSquadSnapshot = {
  id?: number | null;
  name: string;
  playerCount: number;
  totalPlaytimeSeconds?: number | null;
  totalPlaytimeHours?: number | null;
  leaderName?: string | null;
  leaderPlaytimeSeconds?: number | null;
  leaderPlaytimeHours?: number | null;
};

export type ExporterTeamSnapshot = {
  id?: number | null;
  name: string;
  playerCount: number;
  playersWithHours?: number;
  totalPlaytimeSeconds?: number | null;
  totalPlaytimeHours?: number | null;
  leaderPlaytimeSeconds?: number | null;
  leaderPlaytimeHours?: number | null;
  commanderPlaytimeSeconds?: number | null;
  commanderPlaytimeHours?: number | null;
  squads: ExporterSquadSnapshot[];
  players: ExporterPlayerSnapshot[];
};

export type ExporterServerSnapshot = {
  id: number;
  code: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  queueLength?: number;
  currentLayer?: string;
  gameMode?: string;
  isSeedCandidate: boolean;
  online: boolean;
  teams: ExporterTeamSnapshot[];
  players: ExporterPlayerSnapshot[];
  updatedAt: number;
  sourceUrl: string;
  joinLinkUrl: string;
  error?: string | null;
};

export type ExporterSnapshotPlayerResponse = Partial<ExporterPlayerSnapshot>;

export type ExporterSnapshotSquadResponse = Partial<ExporterSquadSnapshot>;

export type ExporterSnapshotTeamResponse = Partial<Omit<ExporterTeamSnapshot, 'players' | 'squads'>> & {
  squads?: ExporterSnapshotSquadResponse[];
  players?: ExporterSnapshotPlayerResponse[];
};

export type ExporterSnapshotServerResponse = Partial<
  Omit<ExporterServerSnapshot, 'sourceUrl' | 'joinLinkUrl' | 'error' | 'teams' | 'players'>
> & {
  teams?: ExporterSnapshotTeamResponse[];
  players?: ExporterSnapshotPlayerResponse[];
};

export type ExporterSnapshotResponse = {
  success: boolean;
  timestamp: number;
  generatedAt: string;
  version: number;
  servers: ExporterSnapshotServerResponse[];
};

export type CombinedSnapshot = {
  timestamp: number;
  generatedAt: string;
  servers: ExporterServerSnapshot[];
  errors: string[];
};

export type SelectionState = {
  targetServer: ExporterServerSnapshot | null;
  reason: 'target_found' | 'no_suitable_server';
  nightMode: boolean;
};

export type BrowserPermissions = {
  popupAllowed: boolean;
  steamProtocolReady: boolean;
  checkedAt: number;
};

export type ExporterJoinLinkResponse = {
  ok?: boolean;
  timestamp?: number;
  serverId?: number;
  serverCode?: string;
  serverName?: string;
  joinLink?: string;
  error?: string;
  message?: string;
};

export type StoredState = {
  enabled: boolean;
  mode: AppMode;
  testSequenceDelayMs: number;
  lastProcessedTimestamp: number;
  cooldownUntil: number;
  permissions: BrowserPermissions | null;
};

export type AppMode = 'production' | 'test';
