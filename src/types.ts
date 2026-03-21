export type AppConfig = {
  app: {
    title: string;
    pollIntervalMs: number;
    debugLogLimit?: number;
  };
  policy?: Partial<SeedPolicy>;
  exporters: ExporterEndpointConfig[];
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
};

export type ExporterEndpointConfig = {
  name: string;
  baseUrl: string;
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
  joinLink?: string;
  updatedAt: number;
  sourceUrl: string;
  error?: string | null;
};

export type ExporterSnapshotResponse = {
  success: boolean;
  timestamp: number;
  generatedAt: string;
  version: number;
  servers: Array<Partial<Omit<ExporterServerSnapshot, 'sourceUrl' | 'error'>>>;
  meta?: Partial<Omit<SeedPolicy, 'cooldownMs'>> & {
    stale?: boolean;
    lastServerUpdateAt?: number;
  };
};

export type CombinedSnapshot = {
  timestamp: number;
  generatedAt: string;
  servers: ExporterServerSnapshot[];
  errors: string[];
  policy: Partial<Omit<SeedPolicy, 'cooldownMs'>> | null;
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

export type StoredState = {
  enabled: boolean;
  lastProcessedTimestamp: number;
  cooldownUntil: number;
  permissions: BrowserPermissions | null;
};
