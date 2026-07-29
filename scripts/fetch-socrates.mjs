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
const META_PATH = path.join(ROOT, '.cache', 'socrates-meta.json');
const CORE_ENTRY = path.join(ROOT, 'packages', 'conjunction-core', 'dist', 'index.js');

const DEFAULT_BASE_URL = 'https://celestrak.org/SOCRATES';
const REPO_URL = 'https://github.com/Beak-man/GRAZE';
/** Bumped from 1: records gained `sources`, and the payload gained per-file metadata. */
const SCHEMA_VERSION = 2;
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return { unknownRecords, unknownObjects: unknownObjects.size };
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
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temp = `${outputPath}.tmp`;
  await writeFile(temp, JSON.stringify(payload));
  await rename(temp, outputPath);
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

    if (!anyFresh && previous !== null) {
      log.log?.('  both sources unchanged — existing socrates.json is current');
      return 0;
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
    log.log?.(
      `  regimes: ${payload.recordCount - regimeStats.unknownRecords}/${payload.recordCount} ` +
        `records fully classified (${regimeStats.unknownObjects} objects unknown)`,
    );
    await writePayloadAtomically(payload, outputPath);
    await writeMeta(nextMeta, metaPath);

    const bytes = (await stat(outputPath)).size;
    log.log?.(
      `  wrote ${payload.recordCount} unique conjunctions (${bytes} bytes) from ` +
        `${perSource.map(([k, v]) => `${k}:${v.length}`).join(', ')}`,
    );
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
