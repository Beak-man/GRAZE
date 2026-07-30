import type { OrbitalElements } from 'conjunction-core';

/**
 * Baked orbital elements. The client makes ZERO CelesTrak requests: elements
 * come from gp-active.json, produced by scripts/fetch-socrates.mjs from one
 * bulk GP request per build.
 *
 * The previous design called gp.php?CATNR=<id> for both objects on every
 * conjunction click. That is the runtime dependency this module removes, and
 * there is deliberately no fallback path back to it — an object without baked
 * elements is reported as unavailable, not fetched on demand.
 */
export const BAKED_GP_URL = '/data/gp-active.json';

export interface BakedGp {
  schemaVersion: number;
  generatedAt: string;
  sourceUrl: string;
  sourceLastModified: string | null;
  /** Objects referenced by a conjunction. */
  requestedCount: number;
  /** Of those, how many the bulk group carried. */
  recordCount: number;
  catalogSize: number;
  /** Id-keyed, so lookup needs no index build. */
  records: Record<string, OrbitalElements>;
}

/**
 * Thrown when an object has no baked elements. Distinct from a network failure:
 * the UI must say "not in the baked catalogue", not "could not fetch", because
 * retrying cannot help and there is nothing to retry against.
 */
export class GpUnavailableError extends Error {
  constructor(readonly noradId: number) {
    super(`No baked GP elements for ${noradId}`);
    this.name = 'GpUnavailableError';
  }
}

/** Thrown when gp-active.json itself is missing or unparseable. */
export class GpFileMissingError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'GpFileMissingError';
  }
}

function isRecordMap(value: unknown): value is Record<string, OrbitalElements> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse and validate the baked GP file. Rejects a payload whose `records` is
 * missing rather than yielding an empty map, so a truncated or wrong-shaped
 * deploy surfaces as an error instead of "every object unavailable".
 */
export function parseBakedGp(value: unknown): BakedGp {
  if (typeof value !== 'object' || value === null) {
    throw new GpFileMissingError('baked GP payload is not an object');
  }
  const candidate = value as Partial<BakedGp>;
  if (!isRecordMap(candidate.records)) {
    throw new GpFileMissingError('baked GP payload has no records map');
  }
  return {
    schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : 0,
    generatedAt: typeof candidate.generatedAt === 'string' ? candidate.generatedAt : '',
    sourceUrl: typeof candidate.sourceUrl === 'string' ? candidate.sourceUrl : '',
    sourceLastModified:
      typeof candidate.sourceLastModified === 'string' ? candidate.sourceLastModified : null,
    requestedCount: typeof candidate.requestedCount === 'number' ? candidate.requestedCount : 0,
    recordCount: typeof candidate.recordCount === 'number' ? candidate.recordCount : 0,
    catalogSize: typeof candidate.catalogSize === 'number' ? candidate.catalogSize : 0,
    records: candidate.records,
  };
}

/**
 * Fetch the baked GP file once. The caller memoises the returned promise, so a
 * burst of selections shares a single request and the ~650 KiB download happens
 * on first selection rather than at page load.
 */
export async function loadBakedGp(
  fetchImpl: typeof fetch = fetch,
  url: string = BAKED_GP_URL,
): Promise<BakedGp> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new GpFileMissingError(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    throw new GpFileMissingError(`${response.status} fetching ${url}`);
  }
  return parseBakedGp(await response.json());
}

/** Look up one object's elements, or throw GpUnavailableError. */
export function elementsFor(baked: BakedGp, noradId: number): OrbitalElements {
  const record = baked.records[String(noradId)];
  if (record === undefined) {
    throw new GpUnavailableError(noradId);
  }
  return record;
}
