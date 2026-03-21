import type { BrowserPermissions, StoredState } from '../types';

const STORAGE_KEYS = {
  enabled: 'steam-auto-enabled',
  lastTimestamp: 'steam-auto-last-timestamp',
  cooldownUntil: 'steam-auto-cooldown-until',
  permissions: 'steam-auto-permissions'
} as const;

export function loadStoredState(): StoredState {
  const enabled = window.localStorage.getItem(STORAGE_KEYS.enabled) === 'true';
  const lastProcessedTimestamp = Number(window.localStorage.getItem(STORAGE_KEYS.lastTimestamp) || 0);
  const cooldownUntil = Number(window.localStorage.getItem(STORAGE_KEYS.cooldownUntil) || 0);
  const permissions = loadPermissions();

  return {
    enabled,
    lastProcessedTimestamp: Number.isFinite(lastProcessedTimestamp) ? lastProcessedTimestamp : 0,
    cooldownUntil: Number.isFinite(cooldownUntil) ? cooldownUntil : 0,
    permissions
  };
}

export function saveEnabled(value: boolean): void {
  window.localStorage.setItem(STORAGE_KEYS.enabled, String(value));
}

export function saveLastProcessedTimestamp(value: number): void {
  window.localStorage.setItem(STORAGE_KEYS.lastTimestamp, String(value));
}

export function saveCooldownUntil(value: number): void {
  window.localStorage.setItem(STORAGE_KEYS.cooldownUntil, String(value));
}

export function loadPermissions(): BrowserPermissions | null {
  const raw = window.localStorage.getItem(STORAGE_KEYS.permissions);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as BrowserPermissions;
  } catch {
    return null;
  }
}

export function savePermissions(value: BrowserPermissions): void {
  window.localStorage.setItem(STORAGE_KEYS.permissions, JSON.stringify(value));
}
