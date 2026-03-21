import type { AppConfig } from '../types';

function assertConfigShape(config: Partial<AppConfig>): asserts config is AppConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('runtime-config.json is empty or malformed.');
  }

  if (!config.app || !Array.isArray(config.exporters)) {
    throw new Error('runtime-config.json must contain app and exporters sections.');
  }
}

export async function loadRuntimeConfig(): Promise<AppConfig> {
  const response = await fetch('./runtime-config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load runtime config: ${response.status}`);
  }

  const parsed = (await response.json()) as Partial<AppConfig>;
  assertConfigShape(parsed);
  return parsed;
}
