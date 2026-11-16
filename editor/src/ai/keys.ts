/**
 * Where the user's AI key lives: in this browser only. By default it is kept for this tab and
 * forgotten when the tab closes; if the user asks to stay connected it is kept on this device.
 * It is never sent anywhere except to the AI provider it belongs to.
 */
export type ProviderId = 'openrouter' | 'anthropic';
export const PROVIDER_NAMES: Record<ProviderId, string> = { openrouter: 'OpenRouter', anthropic: 'Anthropic' };

export interface Connection { provider: ProviderId; key: string; remembered: boolean }

const KEY = 'ai.connection';

function stores(): { session: Storage | null; local: Storage | null } {
  let session: Storage | null = null, local: Storage | null = null;
  try { session = globalThis.sessionStorage ?? null; } catch { /* storage is blocked */ }
  try { local = globalThis.localStorage ?? null; } catch { /* storage is blocked */ }
  return { session, local };
}

function read(store: Storage | null, remembered: boolean): Connection | null {
  try {
    const v = JSON.parse(store?.getItem(KEY) ?? 'null') as { provider?: unknown; key?: unknown } | null;
    if (v && (v.provider === 'openrouter' || v.provider === 'anthropic') && typeof v.key === 'string' && v.key) return { provider: v.provider, key: v.key, remembered };
  } catch { /* a damaged entry counts as not connected */ }
  return null;
}

export function loadConnection(): Connection | null {
  const { session, local } = stores();
  return read(session, false) ?? read(local, true);
}

/** Saves the key for this tab, or on this device when `remember` is on. Returns false if the browser refused. */
export function saveConnection(provider: ProviderId, key: string, remember: boolean): boolean {
  clearConnection();
  const { session, local } = stores();
  try { (remember ? local : session)?.setItem(KEY, JSON.stringify({ provider, key })); return !!(remember ? local : session); } catch { return false; }
}

export function clearConnection() {
  const { session, local } = stores();
  try { session?.removeItem(KEY); } catch { /* ignore */ }
  try { local?.removeItem(KEY); } catch { /* ignore */ }
}

/** Which provider a pasted key belongs to, judged by how it starts. Null when it is not recognisable. */
export function guessProvider(key: string): ProviderId | null {
  const k = key.trim();
  if (k.startsWith('sk-or-')) return 'openrouter';
  if (k.startsWith('sk-ant-')) return 'anthropic';
  return null;
}

/** The model picked last time for a provider. Not secret, so it is always kept on this device. */
export const modelChoice = {
  get(provider: ProviderId): string | null { try { return stores().local?.getItem(`ai.model.${provider}`) ?? null; } catch { return null; } },
  set(provider: ProviderId, id: string) { try { stores().local?.setItem(`ai.model.${provider}`, id); } catch { /* ignore */ } },
};
