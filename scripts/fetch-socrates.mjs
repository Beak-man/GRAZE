/**
 * Bake the SOCRATES conjunction list into a static JSON file at build time.
 *
 * Why: the live CSVs are ~16 MB each and CelesTrak rate-limits aggressive
 * clients. Fetching per pageview does not scale. Run this from a scheduler (or
 * by hand); the app then serves a small pre-parsed file and only touches
 * CelesTrak when a user explicitly asks.
 *
 * Why TWO files: sort-minRange.csv and sort-maxProb.csv contain the same
 * conjunctions in different orders. Truncating either one alone is lossy in the
 * other dimension — measured against live data, keeping only the 10 closest
 * approaches dropped 6 of the 10 highest-probability events, including one at
 * Pc≈0.20. We therefore take the head of BOTH and union them, so neither
 * "closest" nor "most probable" is silently discarded.
 *
 * This is still a subset of ~149,500 screened conjunctions. That is disclosed
 * in the UI rather than hidden; see estimatedTotalRecords below.
 *
 * Parsing is delegated to conjunction-core's parseSocratesCsv — per CLAUDE.md,
 * CSV parsing and orbital math live there and are never reimplemented.
 *
 *   node scripts/fetch-socrates.mjs
 *
 * Env:
 *   SOCRATES_BASE_URL     directory holding the CSVs (default CelesTrak's)
 *   SOCRATES_URL          legacy alias; its directory is used as the base
 *   SOCRATES_MAX_RECORDS  rows taken from EACH file (default 1000)
 *   SOCRATES_CONTACT      contact string embedded in the User-Agent
 *   STRICT_DATA=1         exit non-zero on failure instead of degrading
 *
 * Exit codes: 0 on success *and* on soft failure (so a stranger cloning the
 * repo still gets a working build — the app falls back to runtime fetching).
 * STRICT_DATA=1 makes failures fatal, for a scheduler that should page someone.
 */
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT_PATH = path.join(
  ROOT,
  'packages',
  'conjunction-web',
  'public',
  'data',
  'socrates.json',
);
/**
 * Baked orbital elements, kept out of socrates.json on purpose. Measured: ~422
 * minified bytes per OMM record, so the ~1.5k objects a bake references come to
 * ~650 KiB against socrates.json's 365 KiB. Elements are only needed once a row
 * is clicked, so folding them in would nearly triple the initial download for
 * data most visitors never touch. Separate file, fetched on first selection.
 */
const GP_OUTPUT_PATH = path.join(
  ROOT,
  'packages',
  'conjunction-web',
  'public',
  'data',
  'gp-active.json',
);
const META_PATH = path.join(ROOT, '.cache', 'socrates-meta.json');
const CORE_ENTRY = path.join(ROOT, 'packages', 'conjunction-core', 'dist', 'index.js');

const DEFAULT_BASE_URL = 'https://celestrak.org/SOCRATES';
const REPO_URL = 'https://github.com/Beak-man/GRAZE';
/**
 * 1 -> 2: records gained `sources`, payload gained per-file metadata.
 * 2 -> 3: records gained baked `regime1`/`regime2` from SATCAT.
 * 3 -> 4: payload gained the analyst/absent provenance split.
 * 4 -> 5: payload gained `gp` coverage metadata; GP elements are baked into a
 *         sibling gp-active.json so the client never calls CelesTrak.
 * 5 -> 6: records gained `plottable` — whether BOTH objects have baked
 *         elements — so the "visualizable only" filter works before the lazily
 *         loaded gp-active.json has been fetched.
 *
 * The "nothing changed, reuse the file" shortcut below is gated on this, so a
 * bump forces a rebuild. Without that gate the shortcut happily served a
 * payload predating the new fields forever, because SOCRATES itself had not
 * changed — which is exactly what happened on the first regime deploy.
 */
const SCHEMA_VERSION = 6;
/** Independent of SCHEMA_VERSION: gp-active.json is its own file. */
const GP_SCHEMA_VERSION = 1;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 120_000;
/**
 * Rows taken from each file. 1000 yields ~1389 unique records (~337 KB raw,
 * ~57 KB gzipped — 0.7% of the texture payload) and spans miss distances
 * 0.015–4.882 km, i.e. 97.6% of the app's 0–5 km filter domain, plus every Pc
 * threshold the UI offers. Deliberately generous rather than minimal.
 */
const DEFAULT_MAX_RECORDS = 1000;
/**
 * Range window per file. ~112 bytes/row measured, so 256 KiB comfortably covers
 * 1000 rows with headroom for long object names, while transferring 1.5% of the
 * 16 MB file. CelesTrak honours Range (verified: 206 Partial Content).
 */
const RANGE_BYTES = 256 * 1024;

/** The two pre-sorted views CelesTrak publishes of the same screening run. */
const SOURCE_FILES = {
  minRange: 'sort-minRange.csv',
  maxProb: 'sort-maxProb.csv',
};

/**
 * CelesTrak's satellite catalogue — ONE request covering every object, used to
 * bake orbit regimes in. Verified 2026-07-29: 6,687,967 bytes, 70,122 records
 * including 124 six-digit NORAD IDs (max 100,147), Range and ETag both
 * supported, and it carries PERIOD / APOGEE / PERIGEE / INCLINATION per object.
 *
 * Doing this per object at runtime is what this replaces: the union references
 * ~1,838 unique objects, so classifying in the browser meant ~1,838 CelesTrak
 * requests per visitor.
 */
const SATCAT_URL = 'https://celestrak.org/pub/satcat.csv';

/**
 * Bulk GP elements, ONE request per build for the whole group. This is the only
 * source of orbital elements the app has: the client used to call
 * gp.php?CATNR=<id> per selected object, which is the last runtime CelesTrak
 * dependency and is now gone.
 *
 * `active` covers 1192/1404 referenced objects (84.9%) on the 2026-07-30 bake,
 * leaving 458 of 1374 rows (33.3%) unplottable. It excludes debris, rocket
 * bodies and inactive payloads, which is much of what SOCRATES screens.
 *
 * **There is no `socrates` group** — CelesTrak answers `GROUP=socrates` with
 * `Invalid query: "GROUP=socrates&FORMAT=json" (GROUP=socrates not found)`,
 * verified 2026-07-30 — and no group returns the full catalogue either.
 * `SPECIAL=gpz`/`gpz-plus` are the GEO Protected Zone, not a complete set. The
 * 212 misses break down as 138 debris (only 41 of them in the three published
 * debris-cloud groups), 35 rocket bodies and 39 inactive payloads, so no
 * available group closes the gap; widening means adding several here.
 *
 * The fetch loops over this list, so that stays a config change, and each entry
 * costs exactly one request per build.
 */
const GP_GROUPS = ['active'];
const gpGroupUrl = (group) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An HTTP refusal that retrying cannot fix, so the backoff loop must not try. */
export class NonRetryableHttpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NonRetryableHttpError';
  }
}

/** CelesTrak blocks anonymous automated clients; never send a default/absent UA. */
export function buildUserAgent(version, contact) {
  return `GRAZE/${version} (+${REPO_URL}; ${contact})`;
}

async function packageVersion() {
  try {
    const raw = await readFile(path.join(ROOT, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Stored validators, keyed per source file. Each file has its own ETag —
 * verified distinct on CelesTrak — so they must be tracked independently and
 * one may return 304 while the other returns 200.
 */
export async function readMeta(metaPath = META_PATH) {
  try {
    const parsed = JSON.parse(await readFile(metaPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeMeta(meta, metaPath = META_PATH) {
  await mkdir(path.dirname(metaPath), { recursive: true });
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * SOCRATES CSVs sometimes carry a generation timestamp in a leading comment.
 * Returns null when absent — the schema treats socratesEpoch as optional.
 */
export function extractSocratesEpoch(csv) {
  const head = csv.slice(0, 4096);
  for (const line of head.split(/\r?\n/).slice(0, 5)) {
    if (!line.startsWith('#') && !/^\s*(generated|epoch|as of)/i.test(line)) {
      continue;
    }
    const match = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?)/.exec(line);
    if (match) {
      const parsed = new Date(match[1].replace(' ', 'T') + 'Z');
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
  }
  return null;
}

/**
 * A ranged response almost always cuts the final row mid-line. Dropping it is
 * mandatory: a half-row either fails to parse or, worse, parses into a record
 * with truncated numbers.
 */
export function dropPartialLine(csv) {
  const newline = csv.lastIndexOf('\n');
  return newline === -1 ? '' : csv.slice(0, newline + 1);
}

/** The column header, for verifying both files share one parser path. */
export function headerOf(csv) {
  return (csv.split('\n', 1)[0] ?? '').trim();
}

/** Conditional ranged GET with bounded exponential backoff. */
export async function fetchCsv({
  url,
  userAgent,
  meta,
  fetchImpl = fetch,
  log = console,
  backoffMs = BASE_BACKOFF_MS,
  rangeBytes = RANGE_BYTES,
}) {
  const headers = { 'User-Agent': userAgent, Accept: 'text/csv,*/*' };
  // rangeBytes === null means "whole file" — SATCAT needs every row, because
  // the ids we look up are scattered throughout it.
  if (rangeBytes !== null) {
    headers.Range = `bytes=0-${rangeBytes - 1}`;
  }
  // Conditional headers apply to the whole entity; a 304 means our copy of the
  // entity is current, which is exactly what we want to know before re-ranging.
  if (meta.etag) {
    headers['If-None-Match'] = meta.etag;
  }
  if (meta.lastModified) {
    headers['If-Modified-Since'] = meta.lastModified;
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 304) {
        return { status: 304 };
      }
      /*
       * gp.php signals "you already have this" with 403 and a plain-text body,
       * not 304:
       *
       *   GP data has not updated since your last successful download of
       *   GROUP=active at 2026-07-30 15:50:03 UTC. Data is updated once every
       *   2 hours.
       *
       * Observed 2026-07-30. It is a success for our purposes — reuse what is
       * on disk — and it must NOT be retried: the answer cannot change within
       * a backoff, and hammering a "you already have it" reply is exactly the
       * behaviour that gets a client blocked for real. Matched on the body so
       * a genuine 403 (blocked, banned, bad request) still raises.
       */
      if (response.status === 403) {
        const body = await response.text();
        // The body is hard-wrapped, and the wrap falls mid-phrase ("successful\n
        // download"), so collapse whitespace before matching rather than
        // assuming where the line breaks land.
        const flat = body.replace(/\s+/g, ' ').trim();
        if (/has not updated since your last successful download/i.test(flat)) {
          return { status: 304, notModifiedReason: flat };
        }
        throw new NonRetryableHttpError(`HTTP 403 Forbidden — ${flat.slice(0, 200)}`);
      }
      // 206 is the expected success for a Range request; 200 means the server
      // ignored it and sent the whole file, which still parses fine.
      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status} ${response.statusText ?? ''}`.trim());
      }
      return {
        status: response.status,
        csv: await response.text(),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        contentRange: response.headers.get('content-range'),
      };
    } catch (error) {
      lastError = error;
      // A refusal that a retry cannot change: fail immediately rather than
      // spending the remaining attempts provoking the server.
      if (error instanceof NonRetryableHttpError) {
        throw error;
      }
      if (attempt < MAX_ATTEMPTS) {
        const wait = backoffMs * 2 ** (attempt - 1);
        log.warn?.(`  attempt ${attempt} failed (${error.message}); retrying in ${wait} ms`);
        await sleep(wait);
      }
    }
  }
  throw lastError ?? new Error('fetch failed');
}

/** Total entity size from a Content-Range header, or null. */
export function totalBytesFrom(contentRange) {
  const match = /\/(\d+)\s*$/.exec(contentRange ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * Parse SATCAT into a NORAD id -> regime map. Rows we cannot classify are
 * simply absent, so callers record an explicit "unknown" rather than guessing.
 */
export function buildRegimeIndex(csv, classify) {
  const lines = csv.split('\n');
  const header = (lines[0] ?? '').trim().split(',');
  const col = (name) => header.indexOf(name);
  const idCol = col('NORAD_CAT_ID');
  const periodCol = col('PERIOD');
  const apogeeCol = col('APOGEE');
  const perigeeCol = col('PERIGEE');
  const index = new Map();
  if (idCol === -1 || periodCol === -1 || apogeeCol === -1 || perigeeCol === -1) {
    throw new Error('SATCAT is missing NORAD_CAT_ID/PERIOD/APOGEE/PERIGEE columns');
  }
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',');
    const id = Number(row[idCol]);
    if (!Number.isFinite(id)) {
      continue;
    }
    const regime = classify({
      periodMinutes: Number(row[periodCol]),
      apogeeKm: Number(row[apogeeCol]),
      perigeeKm: Number(row[perigeeCol]),
    });
    if (regime !== null) {
      index.set(id, regime);
    }
  }
  return index;
}

/** Explicit sentinel: the object is absent from SATCAT or unclassifiable. */
export const UNKNOWN_REGIME = 'unknown';

/**
 * The traditional analyst-object block. These are uncorrelated tracks rather
 * than catalogued objects, so their absence from SATCAT is expected and
 * permanent.
 *
 * This is the ONLY id range that carries any meaning here, and it is a closed
 * interval on purpose. A large catalog number says nothing about provenance:
 * CelesTrak exhausted the 5-digit space (~69999) in July 2026, so ordinary
 * objects now receive 6-digit ids. Treating "id > 99999" as analyst would
 * misclassify every post-transition object — see the CelesTrak catalog-number
 * note in CLAUDE.md.
 */
const ANALYST_ID_MIN = 80000;
const ANALYST_ID_MAX = 89999;

/**
 * Why an object missed the SATCAT join. Provenance, NOT orbit class — this is
 * deliberately a separate axis from `regime`, which stays strictly orbital
 * (LEO/MEO/GEO/HEO) so the regime filter keeps one coherent meaning.
 */
export function unknownReasonFor(noradId) {
  return noradId >= ANALYST_ID_MIN && noradId <= ANALYST_ID_MAX
    ? 'analyst-range'
    : 'absent-from-catalog';
}

/** Attach baked regimes to every record. Never defaults silently. */
export function applyRegimes(conjunctions, regimeIndex) {
  let unknownRecords = 0;
  const unknownObjects = new Set();
  for (const c of conjunctions) {
    const r1 = regimeIndex.get(c.noradId1) ?? UNKNOWN_REGIME;
    const r2 = regimeIndex.get(c.noradId2) ?? UNKNOWN_REGIME;
    c.regime1 = r1;
    c.regime2 = r2;
    if (r1 === UNKNOWN_REGIME) unknownObjects.add(c.noradId1);
    if (r2 === UNKNOWN_REGIME) unknownObjects.add(c.noradId2);
    if (r1 === UNKNOWN_REGIME || r2 === UNKNOWN_REGIME) unknownRecords++;
  }
  let analystObjects = 0;
  for (const id of unknownObjects) {
    if (unknownReasonFor(id) === 'analyst-range') analystObjects++;
  }
  return {
    unknownRecords,
    unknownObjects: unknownObjects.size,
    analystObjects,
    absentObjects: unknownObjects.size - analystObjects,
  };
}

/** Stable identity for deduplication across the two orderings. */
function recordKey(event) {
  return `${event.noradId1}|${event.noradId2}|${new Date(event.tca).toISOString()}`;
}

/**
 * Merge per-file record lists into one deduplicated set, recording which
 * file(s) each record came from. Order is preserved: minRange first, then any
 * maxProb records not already present.
 */
export function unionConjunctions(perSource) {
  const out = [];
  const index = new Map();
  for (const [source, events] of perSource) {
    for (const event of events) {
      const key = recordKey(event);
      const existing = index.get(key);
      if (existing === undefined) {
        index.set(key, out.length);
        out.push({ ...event, sources: [source] });
      } else if (!out[existing].sources.includes(source)) {
        out[existing].sources.push(source);
      }
    }
  }
  return out;
}

/** Assemble the baked payload. Throws if the union is empty. */
export function buildPayload({ perSource, sourceMeta, estimatedTotalRecords, now }) {
  const conjunctions = unionConjunctions(perSource);
  if (conjunctions.length === 0) {
    throw new Error('parsed 0 conjunctions — refusing to publish an empty file');
  }
  const lastModifieds = Object.values(sourceMeta)
    .map((s) => s.lastModified)
    .filter(Boolean)
    .sort();
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: (now ?? new Date()).toISOString(),
    // Kept at the top level for the client's informational "upstream freshness"
    // note. The newest of the two files.
    sourceLastModified: lastModifieds.length > 0 ? lastModifieds[lastModifieds.length - 1] : null,
    socratesEpoch: sourceMeta.minRange?.socratesEpoch ?? null,
    sources: sourceMeta,
    recordCount: conjunctions.length,
    /** For the UI's scope disclosure — the app must not imply completeness. */
    estimatedTotalRecords,
    conjunctions,
  };
}

/**
 * Write only after validating, and only via a temp file + rename, so a crash
 * or an empty parse can never leave a partial file where a good one used to be.
 */
export async function writePayloadAtomically(payload, outputPath = OUTPUT_PATH) {
  if (!payload || payload.recordCount <= 0 || payload.conjunctions.length === 0) {
    throw new Error('refusing to write a payload with no records');
  }
  await writeJsonAtomically(payload, outputPath);
}

/** Temp-file + rename, without the conjunction-specific validation above. */
async function writeJsonAtomically(value, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temp = `${outputPath}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, outputPath);
}

/** Every distinct catalog number the conjunction set refers to. */
export function conjunctionObjectIds(conjunctions) {
  const ids = new Set();
  for (const c of conjunctions) {
    ids.add(c.noradId1);
    ids.add(c.noradId2);
  }
  return ids;
}

/**
 * Join the bulk GP payload against the objects we actually plot, in memory.
 *
 * CelesTrak's `active` group is ~11k objects; we keep the ~1.5k that appear in
 * a conjunction and discard the rest, so the browser never downloads elements
 * for objects it cannot select. Objects absent from the group (debris, rocket
 * bodies, analyst tracks, decayed payloads) are simply omitted — there is
 * deliberately NO per-object fallback request, because that is the ~1,800
 * requests-per-visitor defect this whole pipeline exists to prevent.
 */
export function buildGpIndex(gpJson, wantedIds) {
  if (!Array.isArray(gpJson)) {
    throw new Error('bulk GP payload is not a JSON array — is FORMAT=json still honoured?');
  }
  const records = {};
  let matched = 0;
  for (const record of gpJson) {
    const id = Number(record?.NORAD_CAT_ID);
    if (!Number.isFinite(id) || !wantedIds.has(id) || records[id] !== undefined) {
      continue;
    }
    records[id] = record;
    matched++;
  }
  const missingIds = [];
  for (const id of wantedIds) {
    if (records[id] === undefined) missingIds.push(id);
  }
  return { records, matched, catalogSize: gpJson.length, missingIds };
}

/**
 * Stamp each conjunction with whether BOTH its objects have baked elements, and
 * return how many are plottable.
 *
 * Baked per record rather than derived in the browser because gp-active.json is
 * fetched lazily on the first selection — the "visualizable only" filter has to
 * work before a single row has been clicked, and eagerly loading ~500 KiB of
 * elements just to grey out rows would undo the lazy-loading the split exists
 * for.
 */
export function markPlottable(conjunctions, records) {
  let plottable = 0;
  for (const c of conjunctions) {
    const ok = records[c.noradId1] !== undefined && records[c.noradId2] !== undefined;
    c.plottable = ok;
    if (ok) plottable++;
  }
  return plottable;
}

/** Metadata wrapper for the GP file, mirroring the SOCRATES payload's shape. */
export function buildGpPayload({ index, sourceUrl, lastModified, requestedCount, now = new Date() }) {
  return {
    schemaVersion: GP_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    sourceUrl,
    sourceLastModified: lastModified ? new Date(lastModified).toISOString() : null,
    /** Objects a conjunction refers to. */
    requestedCount,
    /** Of those, how many the bulk group actually carried. */
    recordCount: index.matched,
    /** Size of the upstream group, for context in the build log. */
    catalogSize: index.catalogSize,
    /** Id-keyed for O(1) client lookup without building an index. */
    records: index.records,
  };
}

async function loadParser(log) {
  if (!existsSync(CORE_ENTRY)) {
    throw new Error(
      `conjunction-core is not built (${path.relative(ROOT, CORE_ENTRY)} missing). ` +
        'Run "npm run build:core" first.',
    );
  }
  const core = await import(pathToFileURL(CORE_ENTRY).href);
  if (typeof core.parseSocratesCsv !== 'function') {
    throw new Error('conjunction-core does not export parseSocratesCsv');
  }
  if (typeof core.classifyOrbitRegimeFromCatalog !== 'function') {
    throw new Error('conjunction-core does not export classifyOrbitRegimeFromCatalog');
  }
  return core;
}

export async function main({
  env = process.env,
  log = console,
  fetchImpl = fetch,
  outputPath = OUTPUT_PATH,
  gpOutputPath = GP_OUTPUT_PATH,
  metaPath = META_PATH,
  backoffMs = BASE_BACKOFF_MS,
} = {}) {
  const strict = env.STRICT_DATA === '1';
  const base =
    env.SOCRATES_BASE_URL ??
    (env.SOCRATES_URL ? env.SOCRATES_URL.replace(/\/[^/]*$/, '') : DEFAULT_BASE_URL);
  const maxRecords = Number(env.SOCRATES_MAX_RECORDS ?? DEFAULT_MAX_RECORDS);
  const contact = env.SOCRATES_CONTACT ?? 'conjunction-data@graze.invalid';

  try {
    const userAgent = buildUserAgent(await packageVersion(), contact);
    const core = await loadParser(log);
    const { parseSocratesCsv, classifyOrbitRegimeFromCatalog } = core;
    const storedMeta = await readMeta(metaPath);

    /*
     * A conditional request is only safe when there is something to fall back
     * on: 304 means "your copy is current", which is useless if no copy exists.
     * That combination is normal on CI, where the cache may restore .cache/ but
     * not the output file. Validators are therefore used only alongside a real
     * output file; otherwise go unconditional and re-download.
     */
    const outputExists = existsSync(outputPath);
    const previous = outputExists ? await readCachedPayload(outputPath) : null;
    if (!outputExists && (storedMeta.minRange || storedMeta.maxProb)) {
      log.warn?.(
        '  cached validators exist but the baked file does not — ' +
          'sending unconditional GETs so a 304 cannot leave us empty-handed',
      );
    }

    const perSource = [];
    const sourceMeta = {};
    const nextMeta = {};
    let estimatedTotalRecords = null;
    let anyFresh = false;
    let header = null;

    for (const [key, file] of Object.entries(SOURCE_FILES)) {
      const url = `${base}/${file}`;
      const meta = outputExists ? (storedMeta[key] ?? {}) : {};
      log.log?.(`Fetching ${key} from ${url}`);
      if (meta.etag || meta.lastModified) {
        log.log?.(`  ${key}: sending conditional headers`);
      }
      const result = await fetchCsv({ url, userAgent, meta, fetchImpl, log, backoffMs });

      if (result.status === 304) {
        // Reuse this file's slice of the previous payload; the other file may
        // still have changed, which is why the two are tracked independently.
        const reused = previous?.conjunctions?.filter((c) => c.sources?.includes(key)) ?? [];
        if (reused.length === 0) {
          throw new Error(`${key}: 304 with no cached records to reuse`);
        }
        log.log?.(`  ${key}: 304 Not Modified — reusing ${reused.length} cached records`);
        perSource.push([key, reused]);
        sourceMeta[key] = previous?.sources?.[key] ?? { url, lastModified: null };
        nextMeta[key] = meta;
        continue;
      }

      anyFresh = true;
      const csv = dropPartialLine(result.csv);
      const thisHeader = headerOf(csv);
      if (header === null) {
        header = thisHeader;
      } else if (thisHeader !== header) {
        // Both files are assumed to share one parser path; if CelesTrak ever
        // diverges them, fail loudly rather than mis-parse one.
        throw new Error(
          `${key}: column schema differs from the other source file.\n` +
            `  expected: ${header}\n  actual:   ${thisHeader}`,
        );
      }
      const events = parseSocratesCsv(csv, maxRecords);
      log.log?.(
        `  ${key}: ${result.status} — ${events.length} records ` +
          `(last modified ${result.lastModified ?? 'unknown'})`,
      );
      perSource.push([key, events]);
      sourceMeta[key] = {
        url,
        lastModified: result.lastModified ? new Date(result.lastModified).toISOString() : null,
        recordCount: events.length,
        socratesEpoch: extractSocratesEpoch(csv),
      };
      nextMeta[key] = { etag: result.etag, lastModified: result.lastModified };

      const total = totalBytesFrom(result.contentRange);
      if (total !== null && csv.length > 0) {
        const rows = csv.split('\n').length - 2; // minus header and trailing ''
        if (rows > 0) {
          estimatedTotalRecords = Math.round(total / (csv.length / rows));
        }
      }
    }

    // The GP file is a separate artifact, so "sources unchanged" is not enough
    // to skip the build: CI can restore .cache/ and socrates.json while
    // gp-active.json is absent, and skipping would leave the app with no
    // elements at all. Rebuild unless BOTH outputs are present and current.
    const gpOutputExists = existsSync(gpOutputPath);
    /*
     * The shortcut must also notice a CONFIG change, not just an upstream one.
     * Editing GP_GROUPS changes which elements we bake, but SOCRATES is
     * unchanged, so without this the script reports "current" and quietly keeps
     * serving the old group forever — the same trap the schemaVersion gate
     * exists to close.
     */
    const wantedGpUrl = GP_GROUPS.map(gpGroupUrl).join(' ');
    const bakedGpUrl = gpOutputExists ? (await readCachedPayload(gpOutputPath))?.sourceUrl : null;
    const gpSourceChanged = gpOutputExists && bakedGpUrl !== wantedGpUrl;
    if (
      !anyFresh &&
      previous !== null &&
      previous.schemaVersion === SCHEMA_VERSION &&
      gpOutputExists &&
      !gpSourceChanged
    ) {
      log.log?.('  both sources unchanged — existing socrates.json and gp-active.json are current');
      return 0;
    }
    if (!anyFresh && previous !== null && !gpOutputExists) {
      log.log?.('  sources unchanged, but gp-active.json is missing — rebuilding to restore it');
    }
    if (gpSourceChanged) {
      log.log?.(
        `  GP source changed (${bakedGpUrl ?? 'unknown'} -> ${wantedGpUrl}) — rebuilding elements`,
      );
    }
    if (!anyFresh && previous !== null) {
      log.log?.(
        `  both sources unchanged, but the cached payload is schema ` +
          `${previous.schemaVersion ?? 'unknown'} and we emit ${SCHEMA_VERSION} — rebuilding`,
      );
    }

    /*
     * Orbit regimes, baked from ONE bulk request. Previously the browser did
     * this per object, which meant ~1,838 CelesTrak requests per visitor.
     * SATCAT is a third independently-validated source: it can 304 while the
     * SOCRATES files change, or vice versa.
     */
    const satMeta = outputExists ? (storedMeta.satcat ?? {}) : {};
    log.log?.(`Fetching satcat from ${SATCAT_URL}`);
    if (satMeta.etag || satMeta.lastModified) {
      log.log?.('  satcat: sending conditional headers');
    }
    let regimeIndex = null;
    const satResult = await fetchCsv({
      url: SATCAT_URL,
      userAgent,
      meta: satMeta,
      fetchImpl,
      log,
      backoffMs,
      rangeBytes: null,
    });
    if (satResult.status === 304) {
      log.log?.('  satcat: 304 Not Modified — reusing regimes from the cached payload');
      regimeIndex = new Map();
      for (const c of previous?.conjunctions ?? []) {
        if (c.regime1 && c.regime1 !== UNKNOWN_REGIME) regimeIndex.set(c.noradId1, c.regime1);
        if (c.regime2 && c.regime2 !== UNKNOWN_REGIME) regimeIndex.set(c.noradId2, c.regime2);
      }
      nextMeta.satcat = satMeta;
      sourceMeta.satcat = previous?.sources?.satcat ?? { url: SATCAT_URL, lastModified: null };
    } else {
      regimeIndex = buildRegimeIndex(satResult.csv, classifyOrbitRegimeFromCatalog);
      log.log?.(`  satcat: ${satResult.status} — ${regimeIndex.size} objects classified`);
      nextMeta.satcat = { etag: satResult.etag, lastModified: satResult.lastModified };
      sourceMeta.satcat = {
        url: SATCAT_URL,
        lastModified: satResult.lastModified
          ? new Date(satResult.lastModified).toISOString()
          : null,
        recordCount: regimeIndex.size,
      };
    }

    const payload = buildPayload({
      perSource,
      sourceMeta,
      estimatedTotalRecords: estimatedTotalRecords ?? previous?.estimatedTotalRecords ?? null,
    });
    const regimeStats = applyRegimes(payload.conjunctions, regimeIndex);
    payload.regimeUnknownRecords = regimeStats.unknownRecords;
    payload.regimeUnknownObjects = regimeStats.unknownObjects;
    payload.regimeAnalystObjects = regimeStats.analystObjects;
    payload.regimeAbsentObjects = regimeStats.absentObjects;
    log.log?.(
      `  regimes: ${payload.recordCount - regimeStats.unknownRecords}/${payload.recordCount} ` +
        `records fully classified (${regimeStats.unknownObjects} objects unknown: ` +
        `${regimeStats.analystObjects} analyst-range, ${regimeStats.absentObjects} absent from SATCAT)`,
    );
    /*
     * Orbital elements, baked from ONE bulk request per group. This removes the
     * last runtime CelesTrak dependency: the client previously called
     * gp.php?CATNR=<id> for both objects on every conjunction click.
     */
    /*
     * The GP step is fenced off from the conjunction bake. A failure here must
     * not discard a good SOCRATES payload: the table, filters and screening
     * figures are all still valid without elements, and the UI already reports
     * missing elements per row. Under STRICT_DATA the failure is re-raised
     * after the payload is safely on disk.
     */
    let gpError = null;
    const wantedIds = conjunctionObjectIds(payload.conjunctions);
    const gpMeta = outputExists && gpOutputExists ? (storedMeta.gp ?? {}) : {};
    let gpRecords = [];
    let gpFresh = false;
    let gpLastModified = null;
    let gpEtag = null;
    try {
    for (const group of GP_GROUPS) {
      const url = gpGroupUrl(group);
      log.log?.(`Fetching gp:${group} from ${url}`);
      if (gpMeta.etag || gpMeta.lastModified) {
        log.log?.(`  gp:${group}: sending conditional headers`);
      }
      const result = await fetchCsv({
        url,
        userAgent,
        meta: GP_GROUPS.length === 1 ? gpMeta : {},
        fetchImpl,
        log,
        backoffMs,
        rangeBytes: null,
      });
      if (result.status === 304) {
        log.log?.(`  gp:${group}: 304 Not Modified — keeping the existing gp-active.json`);
        continue;
      }
      gpFresh = true;
      gpLastModified = result.lastModified ?? gpLastModified;
      // Only meaningful for a single group; with several, a shared validator
      // would revalidate the wrong body, so it is deliberately dropped.
      gpEtag = GP_GROUPS.length === 1 ? result.etag : null;
      const parsed = JSON.parse(result.csv);
      if (!Array.isArray(parsed)) {
        throw new Error(`gp:${group}: expected a JSON array, got ${typeof parsed}`);
      }
      gpRecords = gpRecords.concat(parsed);
      log.log?.(`  gp:${group}: ${result.status} — ${parsed.length} objects in group`);
    }

    if (gpFresh) {
      const index = buildGpIndex(gpRecords, wantedIds);
      const gpPayload = buildGpPayload({
        index,
        sourceUrl: GP_GROUPS.map(gpGroupUrl).join(' '),
        lastModified: gpLastModified,
        requestedCount: wantedIds.size,
      });
      await writeJsonAtomically(gpPayload, gpOutputPath);
      nextMeta.gp = { etag: gpEtag, lastModified: gpLastModified };
      const pct = ((100 * index.matched) / wantedIds.size).toFixed(1);
      log.log?.(
        `  gp: ${index.matched}/${wantedIds.size} objects have elements (${pct}%); ` +
          `${index.missingIds.length} absent from ${GP_GROUPS.join('+')} — omitted, never fetched individually`,
      );
      payload.gpObjects = index.matched;
      payload.gpMissingObjects = index.missingIds.length;
      payload.gpRequestedObjects = wantedIds.size;
      const plottable = markPlottable(payload.conjunctions, index.records);
      payload.gpUnusableRecords = payload.recordCount - plottable;
      log.log?.(
        `  gp: ${plottable}/${payload.recordCount} conjunctions fully plottable`,
      );
    } else if (existsSync(gpOutputPath)) {
      log.log?.('  gp: unchanged — reusing the existing gp-active.json');
      nextMeta.gp = gpMeta;
      // Recomputed from the file on disk, not copied from the previous payload:
      // the conjunction set may have changed even when GP did not, and a stale
      // flag would hide a row the user can actually plot (or vice versa).
      const existing = (await readCachedPayload(gpOutputPath))?.records ?? {};
      const plottable = markPlottable(payload.conjunctions, existing);
      payload.gpObjects = Object.keys(existing).length;
      payload.gpRequestedObjects = wantedIds.size;
      payload.gpMissingObjects = wantedIds.size - payload.gpObjects;
      payload.gpUnusableRecords = payload.recordCount - plottable;
      log.log?.(
        `  gp: ${plottable}/${payload.recordCount} conjunctions fully plottable`,
      );
    } else {
      /*
       * "Not modified" with nothing on disk to reuse. Reachable because gp.php
       * tracks the last successful download per client, so a fresh clone (or a
       * deleted artifact) can be told it is current when it holds nothing. The
       * conjunction list is still good and still worth shipping; every row will
       * report its elements unavailable until the next GP update window.
       */
      throw new Error(
        'gp: upstream reports our copy is current, but no gp-active.json exists to reuse. ' +
          'GP publishes on a ~2 hour cycle and refuses a repeat download in between, so ' +
          'the elements cannot be re-fetched until the next window.',
      );
    }
    } catch (error) {
      gpError = error;
      log.warn?.(`  ${error.message}`);
      log.warn?.(
        '  continuing without elements: the conjunction list is unaffected and every ' +
          'row will report "GP data unavailable" until the next successful bake.',
      );
      payload.gpObjects = previous?.gpObjects;
      payload.gpMissingObjects = previous?.gpMissingObjects;
      payload.gpRequestedObjects = previous?.gpRequestedObjects;
      payload.gpUnusableRecords = previous?.gpUnusableRecords;
      // No usable element index: leave `plottable` unset on every record. The
      // client treats undefined as "unknown" and shows the row, because hiding
      // a row we merely failed to classify would be a silent omission.
      for (const c of payload.conjunctions) {
        delete c.plottable;
      }
    }

    await writePayloadAtomically(payload, outputPath);
    await writeMeta(nextMeta, metaPath);

    const bytes = (await stat(outputPath)).size;
    log.log?.(
      `  wrote ${payload.recordCount} unique conjunctions (${bytes} bytes) from ` +
        `${perSource.map(([k, v]) => `${k}:${v.length}`).join(', ')}`,
    );
    // The conjunction list is safely on disk; only now is a GP failure allowed
    // to fail the build. A scheduler must still hear about it, because an
    // elements-less deploy can render the table but nothing in 3D.
    if (gpError !== null && strict) {
      log.error?.(`  STRICT_DATA=1 — failing the build on the GP step: ${gpError.message}`);
      return 1;
    }
    return 0;
  } catch (error) {
    const existing = existsSync(outputPath);
    log.warn?.(`SOCRATES fetch failed: ${error.message}`);
    log.warn?.(
      existing
        ? '  keeping the existing baked file; it may be stale.'
        : '  no baked file present; the app will fall back to runtime fetching.',
    );
    if (strict) {
      log.error?.('  STRICT_DATA=1 — failing the build.');
      return 1;
    }
    return 0;
  }
}

async function readCachedPayload(outputPath) {
  try {
    return JSON.parse(await readFile(outputPath, 'utf8'));
  } catch {
    return null;
  }
}

// Only self-execute when invoked directly, so tests can import the pieces.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
