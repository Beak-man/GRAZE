/**
 * Fetch GP element sets for the objects referenced by the bundled SOCRATES
 * test snapshot and store them as CelesTrak-style OMM JSON in:
 *   - test-data/gp/{noradId}.json                       (canonical copy)
 *   - packages/conjunction-web/public/test-data/gp/...  (served by the app)
 *
 * Sources tried in order:
 *   1. CelesTrak GP API (FORMAT=JSON) — authoritative
 *   2. tle.ivanstanojevic.me TLE API (a public mirror of CelesTrak data),
 *      with the TLE converted to the same OMM JSON shape
 *
 * Run with: npm run fetch:test-gp
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SAMPLE_CSV = path.join(ROOT, 'test-data', 'socrates-sample.csv');
const OUTPUT_DIRS = [
  path.join(ROOT, 'test-data', 'gp'),
  path.join(ROOT, 'packages', 'conjunction-web', 'public', 'test-data', 'gp'),
];
/** Matches the TOP_CONJUNCTIONS rows the app displays. */
const SAMPLE_ROWS = 10;
const DELAY_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function neededIds() {
  const csv = await readFile(SAMPLE_CSV, 'utf8');
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const id1 = header.indexOf('NORAD_CAT_ID_1');
  const id2 = header.indexOf('NORAD_CAT_ID_2');
  const ids = new Set();
  for (const line of lines.slice(1, SAMPLE_ROWS + 1)) {
    const fields = line.split(',');
    ids.add(Number(fields[id1]));
    ids.add(Number(fields[id2]));
  }
  return [...ids].sort((a, b) => a - b);
}

async function fromCelestrak(noradId) {
  const url = `https://celestrak.org/NORAD/elements/gp.php?CATNR=${noradId}&FORMAT=JSON`;
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

const ids = await neededIds();
console.log(`Fetching GP data for ${ids.length} objects: ${ids.join(', ')}`);
await Promise.all(OUTPUT_DIRS.map((dir) => mkdir(dir, { recursive: true })));

let failures = 0;
for (const noradId of ids) {
  // Resumable: skip objects fetched on a previous run (delete the file or
  // the gp/ directories to force a refresh).
  if (OUTPUT_DIRS.every((dir) => existsSync(path.join(dir, `${noradId}.json`)))) {
    console.log(`  ${noradId}: already present, skipping`);
    continue;
  }
  let data;
  let source;
  try {
    data = await fromCelestrak(noradId);
    source = 'celestrak';
  } catch (celestrakError) {
    try {
      data = await fromTleApi(noradId);
      source = 'tle-api';
    } catch (mirrorError) {
      console.error(
        `  ${noradId}: FAILED (celestrak: ${celestrakError.message}; mirror: ${mirrorError.message})`,
      );
      failures++;
      continue;
    }
  }
  const json = JSON.stringify(data, null, 2);
  for (const dir of OUTPUT_DIRS) {
    await writeFile(path.join(dir, `${noradId}.json`), `${json}\n`);
  }
  console.log(`  ${noradId}: ok (${source}, ${data[0].OBJECT_NAME}, epoch ${data[0].EPOCH})`);
  await sleep(DELAY_MS);
}

if (failures > 0) {
  console.error(`${failures} object(s) could not be fetched.`);
  process.exitCode = 1;
}
