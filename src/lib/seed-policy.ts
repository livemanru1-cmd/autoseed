import type {
  CombinedSnapshot,
  ExporterServerSnapshot,
  SeedPolicy,
  SelectionState
} from '../types';

export const DEFAULT_SEED_POLICY: SeedPolicy = {
  timezone: 'Europe/Moscow',
  nightWindowStart: '23:00',
  nightWindowEnd: '08:00',
  nightPreferredServerId: 1,
  maxSeedPlayers: 80,
  priorityOrder: [1, 2, 4],
  switchDelta: 10,
  cooldownMs: 10 * 60 * 1000
};

function getMinutesInTimezone(timezone: string, date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

  const hour = Number(parts.find((part) => part.type === 'hour')?.value || '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || '0');
  return hour * 60 + minute;
}

function parseTime(value: string): number {
  const [hour, minute] = value.split(':').map((part) => Number(part));
  return hour * 60 + minute;
}

function isNightWindow(policy: SeedPolicy, date = new Date()): boolean {
  const current = getMinutesInTimezone(policy.timezone, date);
  const start = parseTime(policy.nightWindowStart);
  const end = parseTime(policy.nightWindowEnd);

  if (start <= end) {
    return current >= start && current < end;
  }

  return current >= start || current < end;
}

function isSuitableSeedCandidate(server: ExporterServerSnapshot): boolean {
  return server.online && server.isSeedCandidate;
}

export function resolveSeedPolicy(
  fallbackPolicy?: Partial<SeedPolicy> | null,
  snapshotPolicy?: Partial<Omit<SeedPolicy, 'cooldownMs'>> | null
): SeedPolicy {
  return {
    ...DEFAULT_SEED_POLICY,
    ...(fallbackPolicy || {}),
    ...(snapshotPolicy || {}),
    priorityOrder:
      snapshotPolicy?.priorityOrder ||
      fallbackPolicy?.priorityOrder ||
      DEFAULT_SEED_POLICY.priorityOrder
  };
}

export function determineTargetServer(
  snapshot: CombinedSnapshot,
  policy: SeedPolicy
): ExporterServerSnapshot | null {
  const candidates = snapshot.servers
    .filter((server) => isSuitableSeedCandidate(server))
    .filter((server) => server.playerCount < policy.maxSeedPlayers);

  if (!candidates.length) return null;

  if (isNightWindow(policy)) {
    return candidates.find((server) => server.id === policy.nightPreferredServerId) || null;
  }

  const priorityCandidate = policy.priorityOrder
    .map((serverId) => candidates.find((server) => server.id === serverId) || null)
    .find(Boolean) as ExporterServerSnapshot | undefined;

  const strongest = candidates
    .slice()
    .sort((left, right) => right.playerCount - left.playerCount)[0];

  if (!priorityCandidate) {
    return strongest || null;
  }

  if (
    strongest &&
    strongest.id !== priorityCandidate.id &&
    strongest.playerCount - priorityCandidate.playerCount > policy.switchDelta
  ) {
    return strongest;
  }

  return priorityCandidate;
}

export function buildSelectionState(
  snapshot: CombinedSnapshot,
  policy: SeedPolicy
): SelectionState {
  const targetServer = determineTargetServer(snapshot, policy);
  if (!targetServer) {
    return {
      targetServer: null,
      reason: 'no_suitable_server',
      nightMode: isNightWindow(policy)
    };
  }

  return {
    targetServer,
    reason: 'target_found',
    nightMode: isNightWindow(policy)
  };
}

export function getSelectionStatusLabel(selection: SelectionState | null): string {
  if (!selection) return 'Ожидание обновления данных';
  return selection.reason === 'target_found'
    ? 'Подходящий seed-сервер найден'
    : 'Подходящий seed-сервер не найден';
}
