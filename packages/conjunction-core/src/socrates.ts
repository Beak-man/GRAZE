import type { ConjunctionEvent } from './types.js';

export interface FetchConjunctionsOptions {
  /** Maximum number of events to return (default 100). */
  maxResults?: number;
  /** Which pre-sorted SOCRATES result file to use (default 'MINRANGE'). */
  sortBy?: 'MINRANGE' | 'MAXPROB';
  /**
   * Origin to fetch from (default 'https://celestrak.org'). Pass '' in the
   * browser to go through a same-origin dev-server proxy.
   */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://celestrak.org';

const REQUIRED_COLUMNS = [
  'NORAD_CAT_ID_1',
  'OBJECT_NAME_1',
  'DSE_1',
  'NORAD_CAT_ID_2',
  'OBJECT_NAME_2',
  'DSE_2',
  'TCA',
  'TCA_RANGE',
  'TCA_RELATIVE_SPEED',
  'MAX_PROB',
] as const;

type SocratesColumn = (typeof REQUIRED_COLUMNS)[number];

/** CelesTrak publishes the full SOCRATES results as pre-sorted CSV files. */
const SORT_FILES = {
  MINRANGE: 'sort-minRange.csv',
  MAXPROB: 'sort-maxProb.csv',
} as const;

/**
 * Fetch upcoming conjunction events from CelesTrak SOCRATES.
 *
 * Note: the old `table-socrates.php?FORMAT=csv` query endpoint now serves
 * HTML only, so this downloads the full raw CSV (~16 MB, all predicted
 * conjunctions for the next week) and truncates to maxResults locally.
 */
export async function fetchConjunctions(
  options: FetchConjunctionsOptions = {},
): Promise<ConjunctionEvent[]> {
  const { maxResults = 100, sortBy = 'MINRANGE', baseUrl = DEFAULT_BASE_URL } = options;
  const url = `${baseUrl}/SOCRATES/${SORT_FILES[sortBy]}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`SOCRATES request failed: ${response.status} ${response.statusText}`);
  }
  return parseSocratesCsv(await response.text(), maxResults);
}

/**
 * Parse a SOCRATES CSV document into conjunction events, optionally stopping
 * after maxRows data rows.
 */
export function parseSocratesCsv(csv: string, maxRows?: number): ConjunctionEvent[] {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }

  const header = parseCsvLine(lines[0] ?? '');
  const columnIndex = new Map<string, number>();
  header.forEach((name, i) => columnIndex.set(name.trim(), i));

  for (const column of REQUIRED_COLUMNS) {
    if (!columnIndex.has(column)) {
      throw new Error(`SOCRATES CSV is missing expected column "${column}"`);
    }
  }

  const field = (row: string[], column: SocratesColumn): string => {
    const index = columnIndex.get(column);
    return index === undefined ? '' : (row[index] ?? '').trim();
  };

  const lastRow = maxRows === undefined ? undefined : maxRows + 1;
  const events: ConjunctionEvent[] = [];
  for (const line of lines.slice(1, lastRow)) {
    const row = parseCsvLine(line);
    events.push({
      noradId1: parseIntStrict(field(row, 'NORAD_CAT_ID_1'), 'NORAD_CAT_ID_1'),
      name1: field(row, 'OBJECT_NAME_1'),
      noradId2: parseIntStrict(field(row, 'NORAD_CAT_ID_2'), 'NORAD_CAT_ID_2'),
      name2: field(row, 'OBJECT_NAME_2'),
      tca: parseTca(field(row, 'TCA')),
      minRange: parseFloatStrict(field(row, 'TCA_RANGE'), 'TCA_RANGE'),
      relativeSpeed: parseFloatStrict(field(row, 'TCA_RELATIVE_SPEED'), 'TCA_RELATIVE_SPEED'),
      maxProbability: parseProbability(field(row, 'MAX_PROB')),
      dse1: parseFloatStrict(field(row, 'DSE_1'), 'DSE_1'),
      dse2: parseFloatStrict(field(row, 'DSE_2'), 'DSE_2'),
    });
  }
  return events;
}

/** Split one CSV line into fields, honoring double-quoted fields with embedded commas. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** SOCRATES reports TCA as "YYYY-MM-DD HH:MM:SS.sss" in UTC. */
function parseTca(value: string): Date {
  let normalized = value.replace(' ', 'T');
  if (!normalized.endsWith('Z')) {
    normalized += 'Z';
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Unparseable TCA value "${value}" in SOCRATES CSV`);
  }
  return date;
}

function parseIntStrict(value: string, column: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unparseable ${column} value "${value}" in SOCRATES CSV`);
  }
  return parsed;
}

function parseFloatStrict(value: string, column: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unparseable ${column} value "${value}" in SOCRATES CSV`);
  }
  return parsed;
}

export type ObjectType = 'payload' | 'debris' | 'rocket-body';

/**
 * Classify an object from its SOCRATES name: a "DEB" token means debris,
 * "R/B" means rocket body, anything else is treated as a payload.
 */
export function classifyObjectType(name: string): ObjectType {
  const normalized = name.toUpperCase();
  if (/\bDEB\b/.test(normalized)) {
    return 'debris';
  }
  if (normalized.includes('R/B')) {
    return 'rocket-body';
  }
  return 'payload';
}

/** MAX_PROB can be empty when probability could not be computed; treat as 0. */
function parseProbability(value: string): number {
  if (value === '') {
    return 0;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
