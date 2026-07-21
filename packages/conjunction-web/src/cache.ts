/**
 * Small localStorage cache with per-entry TTL, used to spare CelesTrak repeated
 * requests across page reloads (the SOCRATES list and GP element sets change
 * only every few hours). Every access is guarded, so private-mode, disabled, or
 * quota-full storage simply degrades to a cache miss rather than throwing.
 *
 * Keys are versioned (`graze:v1:…`); bump KEY_PREFIX to invalidate all entries
 * after a schema change.
 */
const KEY_PREFIX = 'graze:v1:';

interface CacheEnvelope<T> {
  savedAt: number;
  data: T;
}

/** A cache hit, with the value and when it was stored. */
export interface CacheHit<T> {
  data: T;
  savedAt: Date;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Accessing localStorage can throw (e.g. blocked in some privacy modes).
    return null;
  }
}

/**
 * Return the cached value for `key` if present and younger than `ttlMs`,
 * otherwise null. `reviver` runs on the parsed `data` to rebuild non-JSON
 * types (e.g. Date fields) before it is handed back.
 */
export function readCache<T>(
  key: string,
  ttlMs: number,
  reviver?: (data: T) => T,
): CacheHit<T> | null {
  const store = storage();
  if (store === null) {
    return null;
  }
  let raw: string | null;
  try {
    raw = store.getItem(KEY_PREFIX + key);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  let envelope: CacheEnvelope<T>;
  try {
    envelope = JSON.parse(raw) as CacheEnvelope<T>;
  } catch {
    return null; // Corrupt entry — treat as a miss.
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    typeof envelope.savedAt !== 'number' ||
    Date.now() - envelope.savedAt >= ttlMs
  ) {
    return null;
  }
  const data = reviver ? reviver(envelope.data) : envelope.data;
  return { data, savedAt: new Date(envelope.savedAt) };
}

/** Store `data` under `key` with the current timestamp. Silent on failure. */
export function writeCache<T>(key: string, data: T): void {
  const store = storage();
  if (store === null) {
    return;
  }
  const envelope: CacheEnvelope<T> = { savedAt: Date.now(), data };
  try {
    store.setItem(KEY_PREFIX + key, JSON.stringify(envelope));
  } catch {
    // Quota exceeded or storage unavailable — caching is best-effort.
  }
}
