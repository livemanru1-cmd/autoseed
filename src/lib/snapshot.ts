import type {
  CombinedSnapshot,
  ExporterEndpointConfig,
  ExporterServerSnapshot,
  ExporterSnapshotResponse,
  SeedPolicy
} from '../types';

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function mapServer(server: Partial<ExporterServerSnapshot>, sourceUrl: string): ExporterServerSnapshot {
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
    joinLink: server.joinLink,
    updatedAt: Number(server.updatedAt) || Date.now(),
    sourceUrl
  };
}

function mergePolicy(
  current: Partial<Omit<SeedPolicy, 'cooldownMs'>> | null,
  next: ExporterSnapshotResponse['meta']
): Partial<Omit<SeedPolicy, 'cooldownMs'>> | null {
  if (!next) return current;

  const normalized: Partial<Omit<SeedPolicy, 'cooldownMs'>> = {
    timezone: next.timezone,
    nightWindowStart: next.nightWindowStart,
    nightWindowEnd: next.nightWindowEnd,
    nightPreferredServerId: next.nightPreferredServerId,
    maxSeedPlayers: next.maxSeedPlayers,
    priorityOrder: Array.isArray(next.priorityOrder) ? next.priorityOrder : undefined,
    switchDelta: next.switchDelta
  };

  return {
    ...(current || {}),
    ...Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined))
  };
}

function sortServers(servers: ExporterServerSnapshot[]): ExporterServerSnapshot[] {
  return servers.slice().sort((left, right) => {
    if (left.id !== right.id) return left.id - right.id;
    return left.name.localeCompare(right.name, 'ru');
  });
}

export async function fetchCombinedSnapshot(
  exporters: ExporterEndpointConfig[]
): Promise<CombinedSnapshot> {
  const results = await Promise.all(
    exporters.map(async (exporterConfig) => {
      const sourceUrl = `${normalizeBaseUrl(exporterConfig.baseUrl)}/v1/autoseed/snapshot`;

      try {
        const response = await fetch(sourceUrl, {
          headers: {
            Accept: 'application/json'
          },
          cache: 'no-store'
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = (await response.json()) as ExporterSnapshotResponse;
        const servers = Array.isArray(payload.servers)
          ? payload.servers.map((server) => mapServer(server, sourceUrl))
          : [];

        return {
          ok: true as const,
          servers,
          timestamp: Number(payload.timestamp) || Date.now(),
          error: null,
          policy: mergePolicy(null, payload.meta)
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown exporter error';
        return {
          ok: false as const,
          servers: [] as ExporterServerSnapshot[],
          timestamp: Date.now(),
          error: `${exporterConfig.name}: ${message}`,
          policy: null
        };
      }
    })
  );

  const policy = results.reduce<Partial<Omit<SeedPolicy, 'cooldownMs'>> | null>(
    (accumulator, result) => {
      if (!result.policy) return accumulator;
      return {
        ...(accumulator || {}),
        ...result.policy
      };
    },
    null
  );

  return {
    timestamp: Math.max(...results.map((result) => result.timestamp), Date.now()),
    generatedAt: new Date().toISOString(),
    servers: sortServers(results.flatMap((result) => result.servers)),
    errors: results
      .map((result) => result.error)
      .filter((value): value is string => Boolean(value)),
    policy
  };
}
