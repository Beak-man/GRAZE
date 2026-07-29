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

/** Per-source metadata recorded by the bake step (schemaVersion 2). */
export interface BakedSourceMeta {
  url: string;
  lastModified: string | null;
  recordCount?: number;
  socratesEpoch?: string | null;
}

/** Shape written by scripts/fetch-socrates.mjs. */
export interface BakedSocrates {
  schemaVersion: number;
  /** When OUR pipeline last produced this file. Drives staleness. */
  generatedAt: string;
  sourceUrl?: string;
  /** When CELESTRAK last published. Informational only — never drives staleness. */
  sourceLastModified: string | null;
  socratesEpoch: string | null;
  sources?: Record<string, BakedSourceMeta>;
  recordCount: number;
  /** Rough size of the full screening run, for the UI's scope disclosure. */
  estimatedTotalRecords?: number | null;
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
  /**
   * When our pipeline produced the file. This — not the upstream publication
   * time — decides staleness, because it answers "is the bake still running".
   */
  generatedAt: string | null;
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

/**
 * Staleness threshold, in hours, applied to `generatedAt` — i.e. "is our bake
 * pipeline alive", NOT "has CelesTrak published lately".
 *
 * 24h rather than 8h on purpose. The scheduler runs every 8h, so an 8h
 * threshold would flip to "stale" on any single late or skipped run and invite
 * a click that re-fetches a byte-identical file. 24h means three consecutive
 * missed runs before we cry wolf.
 */
export const DEFAULT_MAX_AGE_HOURS = 24;

/**
 * How long upstream may go without publishing before we mention it. Purely
 * informational: CelesTrak regenerating slowly is their business, not a fault
 * in our pipeline, so it must never produce a warning or a fetch button.
 */
export const UPSTREAM_QUIET_HOURS = 24;

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
  if (baked.generatedAt === null) {
    // Undated baked file: usable, but age is unknown so it can't be called stale.
    return { kind: 'baked', ageMs: null };
  }
  const epochMs = Date.parse(baked.generatedAt);
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

/**
 * True when our pipeline is healthy but CelesTrak simply has not published
 * anything new. Worth a neutral note — never a warning, and never a fetch
 * button, because re-fetching would return a byte-identical file.
 */
export function isUpstreamQuiet(baked: BakedSocrates, now: Date = new Date()): boolean {
  const upstream = dataEpochOf(baked);
  if (upstream === null) {
    return false;
  }
  const upstreamMs = Date.parse(upstream);
  if (Number.isNaN(upstreamMs)) {
    return false;
  }
  return now.getTime() - upstreamMs > UPSTREAM_QUIET_HOURS * 3_600_000;
}

/** Human-facing scope statement. The app must never imply completeness. */
export function scopeDisclosure(
  baked: BakedSocrates,
  perFile: number,
): { shown: number; total: number | null; perFile: number } {
  return {
    shown: baked.recordCount,
    total: baked.estimatedTotalRecords ?? null,
    perFile,
  };
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
