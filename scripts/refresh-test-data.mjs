/**
 * Refresh the bundled offline dev data in a single step: pull the current
 * SOCRATES conjunction list AND the GP element sets for the objects it
 * references, writing a self-consistent snapshot to both the canonical and the
 * app-served copies:
 *   - test-data/socrates-sample.csv                       + test-data/gp/{id}.json
 *   - packages/conjunction-web/public/test-data/...        (served by `npm run dev`)
 *
 * Strategy: the live sort-minRange.csv is pre-sorted by ascending miss distance,
 * so we walk it top-down and keep the first ROWS rows whose BOTH objects have
 * fetchable GP data — guaranteeing every bundled row is covered even when some
 * objects can't be fetched. GP is re-fetched for every referenced object, and
 * gp/ files no longer referenced are pruned.
 *
 * GP sources, tried in order per object:
 *   1. CelesTrak GP API (FORMAT=JSON) — authoritative
 *   2. tle.ivanstanojevic.me TLE API (a public CelesTrak mirror), TLE→OMM JSON
 *
 * Run with: npm run refresh:test-data
 * Env overrides: ROWS (default 10), MAX_CANDIDATES (default 40), BASE origin.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSV_OUTPUTS = [
  path.join(ROOT, 'test-data', 'socrates-sample.csv'),
  path.join(ROOT, 'packages', 'conjunction-web', 'public', 'test-data', 'socrates-sample.csv'),
];
const OUTPUT_DIRS = [
  path.join(ROOT, 'test-data', 'gp'),
  path.join(ROOT, 'packages', 'conjunction-web', 'public', 'test-data', 'gp'),
];

const BASE = process.env.BASE ?? 'https://celestrak.org';
/** Rows to bundle — must match TOP_CONJUNCTIONS in conjunction-web/src/main.ts. */
const ROWS = Number(process.env.ROWS ?? 10);
/** How many top rows to consider before giving up on reaching ROWS covered. */
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES ?? 40);
const DELAY_MS = 400;
/**
 * The full sort-minRange.csv is ~16 MB and downloads slowly/unreliably, but it
 * is sorted by ascending miss distance and we only need the top rows — so fetch
 * just the first chunk via an HTTP Range request (~130 bytes/row, so 64 KiB is
 * hundreds of rows, far more than MAX_CANDIDATES). CelesTrak honors Range.
 */
const LIST_BYTES = 64 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry a flaky network call with linear backoff (CelesTrak returns transient 503s). */
async function withRetry(fn, tries = 3) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < tries - 1) {
        await sleep(500 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

async function fetchList() {
  const url = `${BASE}/SOCRATES/sort-minRange.csv`;
  return withRetry(async () => {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${LIST_BYTES - 1}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    // 206 = we got just the requested prefix (so the final line may be cut off);
    // 200 = the server ignored Range and sent the whole file (last line intact).
    return { text: await response.text(), partial: response.status === 206 };
  });
}

async function fromCelestrak(noradId) {
  const url = `${BASE}/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=JSON`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = JSON.parse(await response.text());
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('no GP data in response');
  }
  return data;
}

/** "39749-3" (assumed leading decimal point + exponent) → 0.39749e-3 */
function parseTleExponentField(field) {
  const text = field.trim();
  if (text === '' || /^[+-]?0+([+-]0)?$/.test(text)) {
    return 0;
  }
  const match = /^([+-]?)(\d+)([+-]\d)$/.exec(text);
  if (!match) {
    throw new Error(`unparseable TLE exponent field "${field}"`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const mantissa = Number(match[2]) / 10 ** match[2].length;
  return sign * mantissa * 10 ** Number(match[3]);
}

/** TLE epoch "26162.94115470" → "2026-06-11T22:35:15.766080" (CelesTrak style). */
function tleEpochToIso(field) {
  const year2 = Number(field.slice(0, 2));
  const year = year2 < 57 ? 2000 + year2 : 1900 + year2;
  const dayOfYear = Number(field.slice(2));
  const ms = Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86_400_000;
  const date = new Date(Math.round(ms));
  // Extend millisecond precision to CelesTrak's six fractional digits.
  return `${date.toISOString().replace('Z', '')}000`;
}

/** "23001DC" → "2023-001DC" */
function intlDesignatorToObjectId(field) {
  const text = field.trim();
  if (text === '') {
    return 'UNKNOWN';
  }
  const year2 = Number(text.slice(0, 2));
  const year = year2 < 57 ? 2000 + year2 : 1900 + year2;
  return `${year}-${text.slice(2)}`;
}

function tleToOmm(name, line1, line2) {
  return {
    OBJECT_NAME: name,
    OBJECT_ID: intlDesignatorToObjectId(line1.slice(9, 17)),
    EPOCH: tleEpochToIso(line1.slice(18, 32).trim()),
    MEAN_MOTION: Number(line2.slice(52, 63)),
    ECCENTRICITY: Number(`0.${line2.slice(26, 33).trim()}`),
    INCLINATION: Number(line2.slice(8, 16)),
    RA_OF_ASC_NODE: Number(line2.slice(17, 25)),
    ARG_OF_PERICENTER: Number(line2.slice(34, 42)),
    MEAN_ANOMALY: Number(line2.slice(43, 51)),
    EPHEMERIS_TYPE: Number(line1.slice(62, 63)),
    CLASSIFICATION_TYPE: line1.slice(7, 8),
    NORAD_CAT_ID: Number(line1.slice(2, 7)),
    ELEMENT_SET_NO: Number(line1.slice(64, 68)),
    REV_AT_EPOCH: Number(line2.slice(63, 68)),
    BSTAR: parseTleExponentField(line1.slice(53, 61)),
    MEAN_MOTION_DOT: Number(line1.slice(33, 43)),
    MEAN_MOTION_DDOT: parseTleExponentField(line1.slice(44, 52)),
  };
}

async function fromTleApi(noradId) {
  const url = `https://tle.ivanstanojevic.me/api/tle/${noradId}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const tle = await response.json();
  return [tleToOmm(tle.name, tle.line1, tle.line2)];
}

/** Fetched GP per NORAD id (data array or null on failure), deduped across rows. */
const gpCache = new Map();

async function getGp(noradId) {
  if (gpCache.has(noradId)) {
    return gpCache.get(noradId);
  }
  let data = null;
  let source = null;
  try {
    data = await withRetry(() => fromCelestrak(noradId));
    source = 'celestrak';
  } catch (celestrakError) {
    try {
      data = await withRetry(() => fromTleApi(noradId), 2);
      source = 'tle-api';
    } catch (mirrorError) {
      console.error(
        `  ${noradId}: FAILED (celestrak: ${celestrakError.message}; mirror: ${mirrorError.message})`,
      );
    }
  }
  gpCache.set(noradId, data);
  if (data !== null) {
    console.log(`  ${noradId}: ok (${source}, ${data[0].OBJECT_NAME}, epoch ${data[0].EPOCH})`);
    await sleep(DELAY_MS);
  }
  return data;
}

// --- 1. Fetch the live conjunction list -------------------------------------
console.log(`Fetching SOCRATES list from ${BASE}/SOCRATES/sort-minRange.csv …`);
let list;
try {
  list = await fetchList();
} catch (error) {
  console.error(
    `Could not fetch the SOCRATES list from ${BASE}: ${error.message ?? error}. ` +
      'Bundled snapshot left untouched — check connectivity (VPN?) and rerun.',
  );
  process.exit(1);
}
const lines = list.text.split(/\r?\n/);
const header = lines[0];
let dataLines = lines.slice(1).filter((line) => line.trim().length > 0);
if (list.partial && dataLines.length > 0) {
  // The byte range likely cut the final row mid-line; drop it (we only use the
  // top MAX_CANDIDATES rows, far above this boundary).
  dataLines = dataLines.slice(0, -1);
}
const columns = header.split(',');
const idIndex1 = columns.indexOf('NORAD_CAT_ID_1');
const idIndex2 = columns.indexOf('NORAD_CAT_ID_2');
if (idIndex1 === -1 || idIndex2 === -1) {
  console.error('SOCRATES CSV is missing NORAD_CAT_ID_1/NORAD_CAT_ID_2 columns.');
  process.exit(1);
}

// --- 2. Keep the top ROWS rows whose both objects have fetchable GP ----------
console.log(`Selecting ${ROWS} fully-covered rows from up to ${MAX_CANDIDATES} candidates …`);
const keptRows = [];
const referenced = new Set();
for (const line of dataLines.slice(0, MAX_CANDIDATES)) {
  if (keptRows.length >= ROWS) {
    break;
  }
  const fields = line.split(',');
  const id1 = Number(fields[idIndex1]);
  const id2 = Number(fields[idIndex2]);
  const [gp1, gp2] = [await getGp(id1), await getGp(id2)];
  if (gp1 !== null && gp2 !== null) {
    keptRows.push(line);
    referenced.add(id1);
    referenced.add(id2);
  } else {
    console.warn(`  skip row ${id1} × ${id2}: GP unavailable`);
  }
}

if (keptRows.length < ROWS) {
  console.error(
    `Only ${keptRows.length}/${ROWS} rows could be fully covered within ${MAX_CANDIDATES} ` +
      `candidates — leaving the bundled snapshot untouched. Re-run (CelesTrak may be rate-limiting).`,
  );
  process.exit(1);
}

// --- 3. Write the CSV snapshot (both copies, byte-identical) -----------------
const csvOut = `${[header, ...keptRows].join('\n')}\n`;
for (const file of CSV_OUTPUTS) {
  await writeFile(file, csvOut);
}
console.log(`Wrote ${keptRows.length} conjunction rows to both socrates-sample.csv copies.`);

// --- 4. Write GP for exactly the referenced objects (both dirs) --------------
await Promise.all(OUTPUT_DIRS.map((dir) => mkdir(dir, { recursive: true })));
const referencedIds = [...referenced].sort((a, b) => a - b);
for (const noradId of referencedIds) {
  const json = `${JSON.stringify(gpCache.get(noradId), null, 2)}\n`;
  for (const dir of OUTPUT_DIRS) {
    await writeFile(path.join(dir, `${noradId}.json`), json);
  }
}
console.log(`Wrote GP for ${referencedIds.length} objects: ${referencedIds.join(', ')}`);

// --- 5. Prune gp/ files the new snapshot no longer references ----------------
let pruned = 0;
for (const dir of OUTPUT_DIRS) {
  for (const file of await readdir(dir)) {
    const match = /^(\d+)\.json$/.exec(file);
    if (match !== null && !referenced.has(Number(match[1]))) {
      await rm(path.join(dir, file));
      pruned++;
    }
  }
}
console.log(`Pruned ${pruned} orphaned GP file(s). Done.`);
