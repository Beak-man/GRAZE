/**
 * Bake the SOCRATES conjunction list into a static JSON file at build time.
 *
 * Why: the live CSV is ~16 MB and CelesTrak rate-limits aggressive clients.
 * Fetching it per pageview does not scale and is what this script exists to
 * stop. Run it from a scheduler (or by hand); the app then serves a small
 * pre-parsed file and only touches CelesTrak when a user explicitly asks.
 *
 * Deliberately plain Node with no CI-vendor anything, so it runs identically
 * from a scheduler, a container, or a laptop. Parsing is delegated to
 * conjunction-core's parseSocratesCsv — per CLAUDE.md, CSV parsing and orbital
 * math live there and are never reimplemented.
 *
 *   node scripts/fetch-socrates.mjs
 *
 * Env:
 *   SOCRATES_URL          source CSV (default: CelesTrak sort-minRange.csv)
 *   SOCRATES_MAX_RECORDS  rows to bake (default 10, matching the app's view)
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

const DEFAULT_URL = 'https://celestrak.org/SOCRATES/sort-minRange.csv';
const REPO_URL = 'https://github.com/Beak-man/GRAZE';
const SCHEMA_VERSION = 1;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 120_000;

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

/** Previously stored validators, or an empty object when there is no cache. */
export async function readMeta(metaPath = META_PATH) {
  try {
    return JSON.parse(await readFile(metaPath, 'utf8'));
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
 * Returns null when absent — the schema treats socratesEpoch as optional and
 * the client falls back to sourceLastModified.
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

/** Conditional GET with bounded exponential backoff. Returns {status, ...}. */
export async function fetchCsv({
  url,
  userAgent,
  meta,
  fetchImpl = fetch,
  log = console,
  backoffMs = BASE_BACKOFF_MS,
}) {
  const headers = { 'User-Agent': userAgent, Accept: 'text/csv,*/*' };
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
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText ?? ''}`.trim());
      }
      return {
        status: 200,
        csv: await response.text(),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
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

/** Assemble the baked payload from raw CSV. Throws if it yields no records. */
export function buildPayload({ csv, url, lastModified, maxRecords, parseSocratesCsv, now }) {
  const conjunctions = parseSocratesCsv(csv, maxRecords);
  if (!Array.isArray(conjunctions) || conjunctions.length === 0) {
    throw new Error('parsed 0 conjunctions — refusing to publish an empty file');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: (now ?? new Date()).toISOString(),
    sourceUrl: url,
    sourceLastModified: lastModified ? new Date(lastModified).toISOString() : null,
    socratesEpoch: extractSocratesEpoch(csv),
    recordCount: conjunctions.length,
    // parseSocratesCsv already drops the columns the app never reads (DILUTION
    // and friends); tca is serialized as ISO and revived on load.
    conjunctions,
  };
}

/**
 * Write only after validating, and only via a temp file + rename, so a crash
 * or a zero-record parse can never leave a partial or empty file where a good
 * one used to be.
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
  return core.parseSocratesCsv;
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
  const url = env.SOCRATES_URL ?? DEFAULT_URL;
  const maxRecords = Number(env.SOCRATES_MAX_RECORDS ?? 10);
  const contact = env.SOCRATES_CONTACT ?? 'conjunction-data@graze.invalid';

  try {
    const userAgent = buildUserAgent(await packageVersion(), contact);
    const parseSocratesCsv = await loadParser(log);
    const storedMeta = await readMeta(metaPath);

    /*
     * A conditional request is only safe when there is something to fall back
     * on: 304 means "your copy is current", which is useless if no copy exists.
     * That combination is normal on CI, where the cache may restore .cache/ but
     * not the output file (or the workspace is simply fresh) — the job would
     * then deploy an artifact with no baked data, and every visitor would
     * auto-fetch the full CSV. So validators are used only alongside a real
     * output file; otherwise go unconditional and re-download.
     */
    const outputExists = existsSync(outputPath);
    const hasValidators = Boolean(storedMeta.etag || storedMeta.lastModified);
    const meta = outputExists ? storedMeta : {};

    log.log?.(`Fetching SOCRATES from ${url}`);
    if (hasValidators && !outputExists) {
      log.warn?.(
        '  cached validators exist but the baked file does not — ' +
          'sending an unconditional GET so a 304 cannot leave us empty-handed',
      );
    } else if (meta.etag || meta.lastModified) {
      log.log?.('  sending conditional headers from .cache/socrates-meta.json');
    }
    const result = await fetchCsv({ url, userAgent, meta, fetchImpl, log, backoffMs });

    if (result.status === 304) {
      // Unchanged upstream: the existing output is still correct. Leave the
      // file completely untouched so its mtime keeps reflecting real changes.
      if (existsSync(outputPath)) {
        log.log?.('  304 Not Modified — existing socrates.json is current');
        return 0;
      }
      log.warn?.('  304 Not Modified but no baked file exists; clearing cached validators');
      await writeMeta({}, metaPath);
      throw new Error('304 with no cached output to reuse');
    }

    const payload = buildPayload({
      csv: result.csv,
      url,
      lastModified: result.lastModified,
      maxRecords,
      parseSocratesCsv,
    });
    await writePayloadAtomically(payload, outputPath);
    await writeMeta({ etag: result.etag, lastModified: result.lastModified }, metaPath);

    const bytes = (await stat(outputPath)).size;
    log.log?.(
      `  wrote ${payload.recordCount} conjunctions (${bytes} bytes), ` +
        `source last modified ${payload.sourceLastModified ?? 'unknown'}`,
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

// Only self-execute when invoked directly, so tests can import the pieces.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
