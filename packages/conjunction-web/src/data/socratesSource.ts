/**
 * Decides where the conjunction list comes from: the build-time baked file,
 * the bundled dev snapshot, or a runtime fetch from CelesTrak.
 *
 * The decision is a pure function (`selectSource`) kept separate from all I/O,
 * so every branch is testable without touching the network. See
 * `test/socratesSource.test.ts`.
 */
import type { ConjunctionEvent } from 'conjunction-core';

export type DataMode = 'auto' | 'baked' | 'runtime';

/** Shape written by scripts/fetch-socrates.mjs. */
export interface BakedSocrates {
  schemaVersion: number;
  generatedAt: string;
  sourceUrl: string;
  sourceLastModified: string | null;
  socratesEpoch: string | null;
  recordCount: number;
  conjunctions: ConjunctionEvent[];
}

export interface SourceConfig {
  mode: DataMode;
  maxAgeHours: number;
  isDev: boolean;
  useLocalSocrates: boolean;
}

/** What the baked file looks like to the decision, or null when absent. */
export interface BakedProbe {
  /** Best available epoch for the data: socratesEpoch, else sourceLastModified. */
  dataEpoch: string | null;
}

export type Selection =
  /** Bundled dev snapshot. Never networks, never age-checked. */
  | { kind: 'local' }
  /** Baked file, fresh enough to use as-is. */
  | { kind: 'baked'; ageMs: number | null }
  /** Baked file past MAX_AGE: still rendered, with an opt-in refresh offered. */
  | { kind: 'baked-stale'; ageMs: number }
  /** Nothing baked (or mode=runtime): fetch from CelesTrak now. */
  | { kind: 'runtime' };

export const DEFAULT_MAX_AGE_HOURS = 8;

function parseMode(value: unknown): DataMode {
  return value === 'baked' || value === 'runtime' ? value : 'auto';
}

function parsePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read configuration out of an import.meta.env-shaped object. */
export function readSourceConfig(env: Record<string, unknown>, isDev: boolean): SourceConfig {
  return {
    mode: parseMode(env['VITE_DATA_MODE']),
    maxAgeHours: parsePositiveNumber(env['VITE_MAX_DATA_AGE_HOURS'], DEFAULT_MAX_AGE_HOURS),
    isDev,
    useLocalSocrates: env['VITE_USE_LOCAL_SOCRATES'] === 'true',
  };
}

/**
 * Pure source resolution.
 *
 * Order matters, and two branches are deliberate rather than obvious:
 *  - The dev/local branch is checked first and is NOT age-gated. Stale bundled
 *    data is the correct dev behaviour; adding a freshness check here would
 *    push routine dev traffic onto CelesTrak, the exact opposite of the intent.
 *  - A stale baked file still renders (`baked-stale`). The caller offers a
 *    manual refresh; it must not auto-fetch. If the scheduler dies, auto-fetch
 *    would turn every pageview into a full CSV pull — precisely the failure
 *    this design prevents, and precisely when nobody is watching.
 */
export function selectSource(
  config: SourceConfig,
  baked: BakedProbe | null,
  now: Date = new Date(),
): Selection {
  if (config.mode === 'runtime') {
    return { kind: 'runtime' }; // never reads the baked file
  }
  if (config.isDev && config.useLocalSocrates) {
    return { kind: 'local' };
  }
  if (baked === null) {
    // mode=baked never networks, even with nothing to show.
    return config.mode === 'baked' ? { kind: 'baked', ageMs: null } : { kind: 'runtime' };
  }
  if (baked.dataEpoch === null) {
    // Undated baked file: usable, but age is unknown so it can't be called stale.
    return { kind: 'baked', ageMs: null };
  }
  const epochMs = Date.parse(baked.dataEpoch);
  if (Number.isNaN(epochMs)) {
    return { kind: 'baked', ageMs: null };
  }
  const ageMs = now.getTime() - epochMs;
  if (config.mode === 'baked') {
    return { kind: 'baked', ageMs };
  }
  return ageMs > config.maxAgeHours * 3_600_000
    ? { kind: 'baked-stale', ageMs }
    : { kind: 'baked', ageMs };
}

/** The epoch to display: the SOCRATES epoch when known, else Last-Modified. */
export function dataEpochOf(baked: BakedSocrates): string | null {
  return baked.socratesEpoch ?? baked.sourceLastModified;
}

function isBakedSocrates(value: unknown): value is BakedSocrates {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<BakedSocrates>;
  return (
    typeof candidate.schemaVersion === 'number' &&
    Array.isArray(candidate.conjunctions) &&
    candidate.conjunctions.length > 0
  );
}

/**
 * Load the baked file, or null when it is absent/invalid. A missing file is an
 * ordinary outcome (fresh clone, offline build), not an error.
 */
export async function loadBaked(
  url = '/data/socrates.json',
  fetchImpl: typeof fetch = fetch,
): Promise<BakedSocrates | null> {
  try {
    const response = await fetchImpl(url, { cache: 'no-cache' });
    if (!response.ok) {
      return null;
    }
    const parsed: unknown = await response.json();
    if (!isBakedSocrates(parsed)) {
      return null;
    }
    // JSON has no Date type; revive tca the same way the localStorage cache does.
    parsed.conjunctions = parsed.conjunctions.map((event) => ({
      ...event,
      tca: new Date(event.tca),
    }));
    return parsed;
  } catch {
    return null;
  }
}
