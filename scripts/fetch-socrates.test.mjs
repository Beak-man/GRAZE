/**
 * Tests for the SOCRATES bake script. Every HTTP interaction is injected and
 * mocked — nothing here may reach CelesTrak.
 */
import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRegimes,
  buildPayload,
  buildRegimeIndex,
  buildUserAgent,
  dropPartialLine,
  extractSocratesEpoch,
  fetchCsv,
  headerOf,
  main,
  readMeta,
  totalBytesFrom,
  UNKNOWN_REGIME,
  unionConjunctions,
  unknownReasonFor,
  writeMeta,
  writePayloadAtomically,
} from './fetch-socrates.mjs';
import { parseSocratesCsv } from '../packages/conjunction-core/dist/index.js';

const CSV = [
  'NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION',
  '25544,ISS (ZARYA) [+],1.0,100001,TEST DEB [-],2.0,2026-07-29 01:02:03.000,0.013,14.4,1.19E-02,0.007',
  '47919,STARLINK-2405 [+],5.0,68098,GLOBAL-34 [+],4.9,2026-07-30 20:53:01.605,0.014,4.5,3.42E-01,0.004',
  // Trailing newline on purpose: this stands in for a Range response whose cut
  // happened to land on a line boundary. Without it dropPartialLine would
  // discard the final row — correct behaviour, but not what these cases test.
].join('\n') + '\n';

let workDir;
const silent = { log: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'graze-socrates-'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildUserAgent', () => {
  it('is descriptive and never empty — CelesTrak blocks anonymous clients', () => {
    const ua = buildUserAgent('0.1.0', 'someone@example.com');
    expect(ua).toContain('GRAZE/0.1.0');
    expect(ua).toContain('github.com/Beak-man/GRAZE');
    expect(ua).toContain('someone@example.com');
  });
});

const ev = (id1, id2, tca, extra = {}) => ({
  noradId1: id1, name1: `OBJ${id1}`, noradId2: id2, name2: `OBJ${id2}`,
  tca: new Date(tca), minRange: 0.1, relativeSpeed: 10, maxProbability: 1e-4,
  dse1: 1, dse2: 1, ...extra,
});

describe('unionConjunctions', () => {
  it('deduplicates on (idA, idB, TCA) and records provenance', () => {
    const shared = ev(1, 2, '2026-07-29T01:00:00Z');
    const union = unionConjunctions([
      ['minRange', [shared, ev(3, 4, '2026-07-29T02:00:00Z')]],
      ['maxProb', [ev(1, 2, '2026-07-29T01:00:00Z'), ev(5, 6, '2026-07-29T03:00:00Z')]],
    ]);
    expect(union).toHaveLength(3);
    const both = union.find((r) => r.noradId1 === 1);
    expect(both.sources.sort()).toEqual(['maxProb', 'minRange']);
    expect(union.find((r) => r.noradId1 === 3).sources).toEqual(['minRange']);
    expect(union.find((r) => r.noradId1 === 5).sources).toEqual(['maxProb']);
  });

  it('treats a differing TCA as a distinct conjunction', () => {
    const union = unionConjunctions([
      ['minRange', [ev(1, 2, '2026-07-29T01:00:00Z')]],
      ['maxProb', [ev(1, 2, '2026-07-29T09:00:00Z')]],
    ]);
    expect(union).toHaveLength(2);
  });

  it('is order-stable: minRange records come first', () => {
    const union = unionConjunctions([
      ['minRange', [ev(9, 9, '2026-07-29T01:00:00Z')]],
      ['maxProb', [ev(1, 1, '2026-07-29T02:00:00Z')]],
    ]);
    expect(union[0].noradId1).toBe(9);
  });
});

describe('dropPartialLine', () => {
  it('discards the trailing incomplete row a Range response leaves', () => {
    const NL = String.fromCharCode(10);
    const out = dropPartialLine(`a,b${NL}1,2${NL}3,tru`);
    expect(out).toBe(`a,b${NL}1,2${NL}`);
    expect(out.endsWith(NL)).toBe(true);
  });

  it('returns empty string when there is no complete line at all', () => {
    expect(dropPartialLine('no newline here')).toBe('');
  });
});

describe('headerOf / totalBytesFrom', () => {
  it('extracts the header row', () => {
    const NL = String.fromCharCode(10);
    expect(headerOf(`A,B,C${NL}1,2,3${NL}`)).toBe('A,B,C');
  });

  it('reads the entity size from Content-Range', () => {
    expect(totalBytesFrom('bytes 0-65535/16932788')).toBe(16932788);
    expect(totalBytesFrom(null)).toBeNull();
  });
});

describe('buildPayload', () => {
  const sourceMeta = {
    minRange: { url: 'u/min', lastModified: '2026-07-27T23:00:00.000Z', recordCount: 2 },
    maxProb: { url: 'u/max', lastModified: '2026-07-28T23:00:00.000Z', recordCount: 2 },
  };

  it('produces the documented metadata shape at the current schemaVersion', () => {
    const p = buildPayload({
      perSource: [['minRange', [ev(1, 2, '2026-07-29T01:00:00Z')]]],
      sourceMeta,
      estimatedTotalRecords: 149500,
      now: new Date('2026-07-29T00:00:00Z'),
    });
    expect(p.schemaVersion).toBe(4);
    expect(p.generatedAt).toBe('2026-07-29T00:00:00.000Z');
    expect(p.estimatedTotalRecords).toBe(149500);
    expect(p.sources).toEqual(sourceMeta);
    expect(p.recordCount).toBe(1);
    // Top-level sourceLastModified is the NEWEST of the two files.
    expect(p.sourceLastModified).toBe('2026-07-28T23:00:00.000Z');
  });

  it('carries provenance on every record', () => {
    const p = buildPayload({
      perSource: [['minRange', [ev(1, 2, '2026-07-29T01:00:00Z')]]],
      sourceMeta,
      estimatedTotalRecords: null,
    });
    expect(p.conjunctions[0].sources).toEqual(['minRange']);
  });

  it('throws rather than publishing an empty result', () => {
    expect(() => buildPayload({ perSource: [['minRange', []]], sourceMeta })).toThrow(
      /0 conjunctions/,
    );
  });
});

describe('extractSocratesEpoch', () => {
  it('reads a leading comment timestamp when present', () => {
    expect(extractSocratesEpoch('# Generated 2026-07-27 23:30:00\nNORAD_CAT_ID_1,x\n')).toBe(
      '2026-07-27T23:30:00.000Z',
    );
  });

  it('returns null for an ordinary header-only CSV', () => {
    expect(extractSocratesEpoch(CSV)).toBeNull();
  });
});

/** A valid schemaVersion-2 payload built through the real parser. */
function goodPayload() {
  return buildPayload({
    perSource: [['minRange', parseSocratesCsv(CSV, 10)]],
    sourceMeta: { minRange: { url: 'u/min', lastModified: null, recordCount: 2 } },
    estimatedTotalRecords: 149500,
  });
}

describe('writePayloadAtomically', () => {
  it('refuses to overwrite a good file with a zero-record payload', async () => {
    const out = path.join(workDir, 'socrates.json');
    const good = goodPayload();
    await writePayloadAtomically(good, out);
    const before = await readFile(out, 'utf8');

    await expect(
      writePayloadAtomically({ ...good, recordCount: 0, conjunctions: [] }, out),
    ).rejects.toThrow(/no records/);
    expect(await readFile(out, 'utf8')).toBe(before);
  });

  it('leaves no .tmp file behind on success', async () => {
    const out = path.join(workDir, 'socrates.json');
    await writePayloadAtomically(goodPayload(), out);
    expect(existsSync(`${out}.tmp`)).toBe(false);
    expect(JSON.parse(await readFile(out, 'utf8')).recordCount).toBe(2);
  });

  it('writes minified JSON', async () => {
    const out = path.join(workDir, 'socrates.json');
    await writePayloadAtomically(goodPayload(), out);
    const text = await readFile(out, 'utf8');
    expect(text).not.toContain('\n  ');
  });
});

describe('fetchCsv', () => {
  it('sends a User-Agent and conditional headers when validators are cached', async () => {
    let seen;
    const fetchImpl = async (_url, init) => {
      seen = init.headers;
      return { status: 200, ok: true, text: async () => CSV, headers: new Headers() };
    };
    await fetchCsv({
      url: 'https://example.invalid/x.csv',
      userAgent: 'GRAZE/test (+repo; contact)',
      meta: { etag: '"abc"', lastModified: 'Mon, 27 Jul 2026 23:00:00 GMT' },
      fetchImpl,
      log: silent,
    });
    expect(seen['User-Agent']).toBe('GRAZE/test (+repo; contact)');
    expect(seen['If-None-Match']).toBe('"abc"');
    expect(seen['If-Modified-Since']).toBe('Mon, 27 Jul 2026 23:00:00 GMT');
  });

  it('omits conditional headers on a first run', async () => {
    let seen;
    const fetchImpl = async (_url, init) => {
      seen = init.headers;
      return { status: 200, ok: true, text: async () => CSV, headers: new Headers() };
    };
    await fetchCsv({ url: 'u', userAgent: 'ua', meta: {}, fetchImpl, log: silent });
    expect(seen['If-None-Match']).toBeUndefined();
    expect(seen['If-Modified-Since']).toBeUndefined();
  });

  it('treats 304 as success without a body', async () => {
    const fetchImpl = async () => ({ status: 304, ok: false, headers: new Headers() });
    const result = await fetchCsv({ url: 'u', userAgent: 'ua', meta: { etag: '"a"' }, fetchImpl, log: silent });
    expect(result).toEqual({ status: 304 });
  });

  it('retries at most 3 times, then gives up', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      throw new Error('ECONNRESET');
    };
    await expect(
      fetchCsv({ url: 'u', userAgent: 'ua', meta: {}, fetchImpl, log: silent, backoffMs: 0 }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(calls).toBe(3);
  });

  it('recovers if a later attempt succeeds', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls < 2) throw new Error('flaky');
      return { status: 200, ok: true, text: async () => CSV, headers: new Headers() };
    };
    const result = await fetchCsv({
      url: 'u',
      userAgent: 'ua',
      meta: {},
      fetchImpl,
      log: silent,
      backoffMs: 0,
    });
    expect(result.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('backs off exponentially rather than hammering in a tight loop', async () => {
    const waits = [];
    let previous = Date.now();
    const fetchImpl = async () => {
      const now = Date.now();
      waits.push(now - previous);
      previous = now;
      throw new Error('nope');
    };
    await expect(
      fetchCsv({ url: 'u', userAgent: 'ua', meta: {}, fetchImpl, log: silent, backoffMs: 40 }),
    ).rejects.toThrow();
    // First call is immediate; the two retries wait ~40 ms then ~80 ms.
    expect(waits[1]).toBeGreaterThanOrEqual(30);
    expect(waits[2]).toBeGreaterThanOrEqual(70);
  });
});

describe('meta persistence', () => {
  it('round-trips validators and tolerates a missing file', async () => {
    const metaPath = path.join(workDir, '.cache', 'socrates-meta.json');
    expect(await readMeta(metaPath)).toEqual({});
    await writeMeta({ etag: '"xyz"', lastModified: 'Mon, 27 Jul 2026 23:00:00 GMT' }, metaPath);
    expect(await readMeta(metaPath)).toEqual({
      etag: '"xyz"',
      lastModified: 'Mon, 27 Jul 2026 23:00:00 GMT',
    });
  });
});

const NL_ = String.fromCharCode(10);
/** A minimal but schema-valid SATCAT covering the ids used in CSV above. */
const SATCAT_STUB = [
  'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE',
  'ISS,1998-067A,25544,PAY,+,US,1998-11-20,TTMTR,,92.9,51.6,420,410,400,,EA,ORB',
  'DEB,2020-001B,100001,DEB,+,US,2020-01-01,AFETR,,95.0,51.6,500,480,0.1,,EA,ORB',
  'SL,2021-002A,47919,PAY,+,US,2021-01-01,AFETR,,95.5,53.0,550,540,5,,EA,ORB',
  'GL,2021-003A,68098,PAY,+,US,2021-01-01,AFETR,,96.0,53.0,560,550,5,,EA,ORB',
].join(NL_) + NL_;

/**
 * Wrap a SOCRATES-focused mock so the SATCAT request also gets a valid
 * response. Tests that care about SATCAT specifically handle it themselves and
 * this passthrough never fires.
 */
function withSatcat(fetchImpl) {
  return async (url, init) => {
    const result = await fetchImpl(url, init);
    if (url.includes('satcat') && (result === undefined || result.status === undefined)) {
      return { status: 200, ok: true, text: async () => SATCAT_STUB, headers: new Headers() };
    }
    if (url.includes('satcat') && typeof result.text === 'function') {
      // The caller returned a SOCRATES body for satcat; substitute a real one.
      const body = await result.text();
      if (!body.includes('NORAD_CAT_ID,OBJECT_TYPE')) {
        return {
          status: result.status === 304 ? 304 : 200,
          ok: true,
          text: async () => SATCAT_STUB,
          headers: result.headers ?? new Headers(),
        };
      }
    }
    return result;
  };
}

/** main() with every side effect redirected into the test's temp dir. */
function mainOptions(fetchImpl, env = {}) {
  return {
    env: { SOCRATES_MAX_RECORDS: '10', ...env },
    log: silent,
    fetchImpl: withSatcat(fetchImpl),
    outputPath: path.join(workDir, 'socrates.json'),
    metaPath: path.join(workDir, '.cache', 'socrates-meta.json'),
    backoffMs: 0,
  };
}

const failingFetch = async () => {
  throw new Error('network unreachable');
};

describe('main exit codes', () => {
  it('exits 0 on failure by default so a fresh clone still builds', async () => {
    expect(await main(mainOptions(failingFetch))).toBe(0);
  });

  it('exits non-zero under STRICT_DATA=1', async () => {
    expect(await main(mainOptions(failingFetch, { STRICT_DATA: '1' }))).toBe(1);
  });

  it('writes nothing when the fetch fails and nothing was there before', async () => {
    await main(mainOptions(failingFetch));
    expect(existsSync(path.join(workDir, 'socrates.json'))).toBe(false);
  });

  it('leaves a previously good file intact when a later fetch fails', async () => {
    const out = path.join(workDir, 'socrates.json');
    const ok = async () => ({
      status: 200,
      ok: true,
      text: async () => CSV,
      headers: new Headers({ etag: '"v1"' }),
    });
    expect(await main(mainOptions(ok))).toBe(0);
    const before = await readFile(out, 'utf8');

    expect(await main(mainOptions(failingFetch))).toBe(0);
    expect(await readFile(out, 'utf8')).toBe(before);
  });
});

describe('main end-to-end with mocked HTTP', () => {
  it('writes the payload and persists the returned validators', async () => {
    const fetchImpl = async () => ({
      status: 200,
      ok: true,
      text: async () => CSV,
      headers: new Headers({
        etag: '"v1"',
        'last-modified': 'Mon, 27 Jul 2026 23:00:00 GMT',
      }),
    });
    expect(await main(mainOptions(fetchImpl))).toBe(0);

    const written = JSON.parse(await readFile(path.join(workDir, 'socrates.json'), 'utf8'));
    expect(written.schemaVersion).toBe(4);
    // Both files return the same CSV here, so the union dedups to 2 records.
    expect(written.recordCount).toBe(2);
    expect(written.conjunctions[0].sources.sort()).toEqual(['maxProb', 'minRange']);
    expect(written.sourceLastModified).toBe('2026-07-27T23:00:00.000Z');

    // Validators are tracked per source file — they have distinct ETags.
    const meta = await readMeta(path.join(workDir, '.cache', 'socrates-meta.json'));
    expect(Object.keys(meta).sort()).toEqual(['maxProb', 'minRange', 'satcat']);
    expect(meta.minRange).toEqual({
      etag: '"v1"',
      lastModified: 'Mon, 27 Jul 2026 23:00:00 GMT',
    });
    expect(meta.maxProb).toEqual({
      etag: '"v1"',
      lastModified: 'Mon, 27 Jul 2026 23:00:00 GMT',
    });
  });

  it('on 304, reuses the existing file byte-identically and does not rewrite it', async () => {
    const out = path.join(workDir, 'socrates.json');
    const seenHeaders = [];
    const first = async (_url, init) => {
      seenHeaders.push(init.headers);
      return {
        status: 200,
        ok: true,
        text: async () => CSV,
        headers: new Headers({
          etag: '"v1"',
          'last-modified': 'Mon, 27 Jul 2026 23:00:00 GMT',
        }),
      };
    };
    await main(mainOptions(first));
    const before = await readFile(out, 'utf8');
    const mtimeBefore = (await stat(out)).mtimeMs;

    const notModified = async (_url, init) => {
      seenHeaders.push(init.headers);
      return { status: 304, ok: false, headers: new Headers() };
    };
    expect(await main(mainOptions(notModified))).toBe(0);

    // Three requests per run (minRange, maxProb, satcat), so the second run's
    // SOCRATES requests are indices 3 and 4.
    expect(seenHeaders[3]['If-None-Match']).toBe('"v1"');
    expect(seenHeaders[3]['If-Modified-Since']).toBe('Mon, 27 Jul 2026 23:00:00 GMT');
    expect(seenHeaders[4]['If-None-Match']).toBe('"v1"');
    // And the output was reused untouched — same bytes, same mtime.
    expect(await readFile(out, 'utf8')).toBe(before);
    expect((await stat(out)).mtimeMs).toBe(mtimeBefore);
  });

  it('does not clobber a good file when the source returns an empty CSV', async () => {
    const out = path.join(workDir, 'socrates.json');
    const good = async () => ({
      status: 200,
      ok: true,
      text: async () => CSV,
      headers: new Headers(),
    });
    await main(mainOptions(good));
    const before = await readFile(out, 'utf8');

    const headerOnly = CSV.split('\n')[0];
    const empty = async () => ({
      status: 200,
      ok: true,
      text: async () => headerOnly,
      headers: new Headers(),
    });
    expect(await main(mainOptions(empty))).toBe(0);
    expect(await readFile(out, 'utf8')).toBe(before);
  });
});

describe('conditional requests require an existing output file', () => {
  /**
   * The CI failure mode this guards: the cache restores .cache/ but the baked
   * file is absent (fresh workspace, or only the metadata was cached). Sending
   * If-None-Match then invites a 304 with nothing to reuse, and the deployed
   * app would have no baked data at all.
   */
  it('sends an UNCONDITIONAL GET when validators exist but the output file does not', async () => {
    const metaPath = path.join(workDir, '.cache', 'socrates-meta.json');
    const outputPath = path.join(workDir, 'socrates.json');
    await writeMeta(
      {
        minRange: { etag: '"cached-v1"', lastModified: 'Mon, 27 Jul 2026 23:00:00 GMT' },
        maxProb: { etag: '"cached-v2"', lastModified: 'Mon, 27 Jul 2026 23:00:00 GMT' },
      },
      metaPath,
    );
    expect(existsSync(outputPath)).toBe(false);

    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push(init.headers);
      return {
        status: 200,
        ok: true,
        text: async () => CSV,
        headers: new Headers({ etag: '"fresh"' }),
      };
    };

    const warnings = [];
    const code = await main({
      env: { SOCRATES_MAX_RECORDS: '10' },
      log: { log: () => {}, warn: (m) => warnings.push(m), error: () => {} },
      fetchImpl: withSatcat(fetchImpl),
      outputPath,
      metaPath,
      backoffMs: 0,
    });
    if (!existsSync(outputPath)) throw new Error('main failed: ' + warnings.join(' | '));

    expect(code).toBe(0);
    // One request per source file plus SATCAT, and NONE may carry a validator.
    expect(seen).toHaveLength(3);
    for (const headers of seen) {
      expect(headers['If-None-Match']).toBeUndefined();
      expect(headers['If-Modified-Since']).toBeUndefined();
      expect(headers['User-Agent']).toContain('GRAZE/');
    }
    // The two SOCRATES files are ranged; SATCAT is fetched whole.
    expect(seen.filter((h) => h['Range'] !== undefined)).toHaveLength(2);
    // And it actually produced the file the deploy needs.
    expect(existsSync(outputPath)).toBe(true);
    expect(JSON.parse(await readFile(outputPath, 'utf8')).recordCount).toBe(2);
  });

  it('still sends conditional headers when the output file IS present', async () => {
    const metaPath = path.join(workDir, '.cache', 'socrates-meta.json');
    const outputPath = path.join(workDir, 'socrates.json');
    await writePayloadAtomically(goodPayload(), outputPath);
    await writeMeta({ minRange: { etag: '"cached-v1"' } }, metaPath);

    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push(init.headers);
      return { status: 304, ok: false, headers: new Headers() };
    };
    const warnings = [];
    const code = await main({
      env: { SOCRATES_MAX_RECORDS: '10' },
      log: { log: () => {}, warn: (m) => warnings.push(m), error: () => {} },
      fetchImpl: withSatcat(fetchImpl),
      outputPath,
      metaPath,
      backoffMs: 0,
    });
    if (!existsSync(outputPath)) throw new Error('main failed: ' + warnings.join(' | '));
    expect(code).toBe(0);
    expect(seen[0]['If-None-Match']).toBe('"cached-v1"');
  });
});

describe('record cap', () => {
  /**
   * Regression guard. The default was 10, which silently dropped 6 of the 10
   * highest-probability events measured against live data. It must never
   * return to that.
   */
  it('does NOT default to 10', async () => {
    let requested = 0;
    const many = [CSV.split('\n')[0]]
      .concat(
        Array.from({ length: 40 }, (_, i) =>
          `${1000 + i},A${i} [+],1.0,${2000 + i},B${i} [-],1.0,` +
          `2026-07-29 0${(i % 9) + 1}:00:00.000,0.0${(i % 9) + 1},14.4,1.19E-02,0.007`,
        ),
      )
      .join('\n') + '\n';
    const fetchImpl = async () => {
      requested++;
      return { status: 206, ok: false, text: async () => many, headers: new Headers() };
    };
    await main(mainOptions(fetchImpl, { SOCRATES_MAX_RECORDS: undefined }));
    const written = JSON.parse(await readFile(path.join(workDir, 'socrates.json'), 'utf8'));
    // minRange + maxProb + satcat
    expect(requested).toBe(3);
    // With a default of 10 this would cap at 10; the real default is far higher.
    expect(written.recordCount).toBe(40);
  });
});

describe('independent per-file validators', () => {
  it('handles 304 on one file and 200 on the other', async () => {
    const out = path.join(workDir, 'socrates.json');
    const metaPath = path.join(workDir, '.cache', 'socrates-meta.json');

    // Seed a full run so both files have cached records and validators.
    const seed = async () => ({
      status: 206,
      ok: false,
      text: async () => CSV,
      headers: new Headers({ etag: '"seed"', 'last-modified': 'Mon, 27 Jul 2026 23:00:00 GMT' }),
    });
    expect(await main(mainOptions(seed))).toBe(0);
    const firstGeneratedAt = JSON.parse(await readFile(out, 'utf8')).generatedAt;

    // Now: minRange unchanged (304), maxProb changed (206 with a new record).
    const changed = [CSV.split('\n')[0],
      '55555,NEW A [+],1.0,66666,NEW B [-],1.0,2026-08-01 12:00:00.000,0.5,9.9,5.00E-03,0.01',
    ].join('\n') + '\n';
    const mixed = async (url) =>
      url.includes('minRange')
        ? { status: 304, ok: false, headers: new Headers() }
        : {
            status: 206,
            ok: false,
            text: async () => changed,
            headers: new Headers({ etag: '"fresh"' }),
          };
    expect(await main(mainOptions(mixed))).toBe(0);

    const after = JSON.parse(await readFile(out, 'utf8'));
    // The 304 file's records were reused from the previous payload...
    const fromMin = after.conjunctions.filter((c) => c.sources.includes('minRange'));
    expect(fromMin.length).toBeGreaterThan(0);
    // ...and the 200 file's new record is present.
    expect(after.conjunctions.some((c) => c.noradId1 === 55555)).toBe(true);
    // The file was genuinely rewritten, not skipped.
    expect(after.generatedAt).not.toBe(firstGeneratedAt);

    // Validators diverge: minRange keeps its old ETag, maxProb takes the new one.
    const meta = await readMeta(metaPath);
    expect(meta.minRange.etag).toBe('"seed"');
    expect(meta.maxProb.etag).toBe('"fresh"');
  });

  it('leaves the file untouched when BOTH sources return 304', async () => {
    const out = path.join(workDir, 'socrates.json');
    const seed = async () => ({
      status: 206, ok: false, text: async () => CSV,
      headers: new Headers({ etag: '"seed"' }),
    });
    await main(mainOptions(seed));
    const before = await readFile(out, 'utf8');
    const mtimeBefore = (await stat(out)).mtimeMs;

    const bothStale = async () => ({ status: 304, ok: false, headers: new Headers() });
    expect(await main(mainOptions(bothStale))).toBe(0);
    expect(await readFile(out, 'utf8')).toBe(before);
    expect((await stat(out)).mtimeMs).toBe(mtimeBefore);
  });
});

describe('SATCAT regime baking', () => {
  const NL = String.fromCharCode(10);
  const SATCAT = [
    'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE',
    'LEOSAT,2020-001A,25544,PAY,+,US,2020-01-01,AFETR,,92.9,51.6,420,410,5.0,,EA,ORB',
    'GEOSAT,2020-002A,100001,PAY,+,US,2020-01-01,AFETR,,1436.1,0.1,35800,35780,20.0,,EA,ORB',
    'MOLNIYA,2020-003A,33333,PAY,+,CIS,2020-01-01,PKMTR,,718.0,63.4,39900,500,10.0,,EA,ORB',
    'NOFIELDS,2020-004A,44444,PAY,+,US,2020-01-01,AFETR,,,,,,,,EA,ORB',
  ].join(NL) + NL;

  const classify = (row) => {
    const RE = 6378.137;
    const { periodMinutes: p, apogeeKm: a, perigeeKm: q } = row;
    if (![p, a, q].every(Number.isFinite) || p <= 0) return null;
    const e = (a + RE - (q + RE)) / (a + RE + q + RE);
    if (e > 0.25) return 'HEO';
    if (p < 225) return 'LEO';
    if (p <= 1400) return 'MEO';
    return 'GEO';
  };

  it('indexes the catalogue by NORAD id, including 6-digit ids', () => {
    const index = buildRegimeIndex(SATCAT, classify);
    expect(index.get(25544)).toBe('LEO');
    // 5-digit space exhausted ~2026-07-12, so 6-digit coverage is mandatory.
    expect(index.get(100001)).toBe('GEO');
    expect(index.get(33333)).toBe('HEO');
  });

  it('omits rows with unusable orbital fields rather than defaulting', () => {
    const index = buildRegimeIndex(SATCAT, classify);
    expect(index.has(44444)).toBe(false);
  });

  it('throws if the catalogue schema loses a required column', () => {
    expect(() => buildRegimeIndex(`OBJECT_NAME,NORAD_CAT_ID${NL}x,1${NL}`, classify)).toThrow(
      /missing NORAD_CAT_ID\/PERIOD\/APOGEE\/PERIGEE/,
    );
  });

  it('marks absent objects explicitly unknown, never silently defaulted', () => {
    const index = buildRegimeIndex(SATCAT, classify);
    const records = [
      { noradId1: 25544, noradId2: 100001 },
      { noradId1: 25544, noradId2: 44444 },
      { noradId1: 999999, noradId2: 888888 },
    ];
    const stats = applyRegimes(records, index);
    expect(records[0].regime1).toBe('LEO');
    expect(records[0].regime2).toBe('GEO');
    expect(records[1].regime2).toBe(UNKNOWN_REGIME);
    expect(records[2].regime1).toBe(UNKNOWN_REGIME);
    expect(stats.unknownRecords).toBe(2);
    expect(stats.unknownObjects).toBe(3);
  });

  it('treats only the 80000-89999 block as analyst-range', () => {
    // Closed interval, pinned at both edges.
    expect(unknownReasonFor(79999)).toBe('absent-from-catalog');
    expect(unknownReasonFor(80000)).toBe('analyst-range');
    expect(unknownReasonFor(84000)).toBe('analyst-range');
    expect(unknownReasonFor(89999)).toBe('analyst-range');
    expect(unknownReasonFor(90000)).toBe('absent-from-catalog');
  });

  it('never infers analyst provenance from catalog-number magnitude', () => {
    // The regression this guards: CelesTrak exhausted the 5-digit space in
    // July 2026, so ordinary objects now carry 6-digit ids. Calling any of
    // these "analyst" would be a domain error, not a display nit.
    for (const id of [100000, 199999, 270257, 270368, 999999]) {
      expect(unknownReasonFor(id)).toBe('absent-from-catalog');
    }
  });

  it('splits unknown objects by provenance without touching regime', () => {
    const records = [
      { noradId1: 53228, noradId2: 82448 }, // analyst-range companion
      { noradId1: 62760, noradId2: 270257 }, // expanded-space companion
      { noradId1: 65642, noradId2: 270257 }, // same object again — counted once
    ];
    const stats = applyRegimes(records, new Map([[53228, 'LEO']]));
    // Provenance is a separate axis: regime stays strictly orbital, so every
    // one of these is 'unknown' regardless of which reason applies.
    expect(records.map((r) => r.regime2)).toEqual([
      UNKNOWN_REGIME,
      UNKNOWN_REGIME,
      UNKNOWN_REGIME,
    ]);
    expect(stats.unknownObjects).toBe(4);
    expect(stats.analystObjects).toBe(1);
    expect(stats.absentObjects).toBe(3);
    expect(stats.analystObjects + stats.absentObjects).toBe(stats.unknownObjects);
  });
});

describe('three independently-validated sources', () => {
  it('fetches SATCAT once per build and tracks its validator separately', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url, headers: init.headers });
      if (url.includes('satcat')) {
        return {
          status: 200, ok: true,
          text: async () => [
            'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE',
            'A,2020-001A,25544,PAY,+,US,2020-01-01,AFETR,,92.9,51.6,420,410,5.0,,EA,ORB',
          ].join(String.fromCharCode(10)) + String.fromCharCode(10),
          headers: new Headers({ etag: '"sat-v1"' }),
        };
      }
      return { status: 206, ok: false, text: async () => CSV, headers: new Headers({ etag: '"soc-v1"' }) };
    };
    expect(await main(mainOptions(fetchImpl))).toBe(0);

    // Exactly one SATCAT request — never one per object.
    const satReqs = seen.filter((r) => r.url.includes('satcat'));
    expect(satReqs).toHaveLength(1);
    // And it is a whole-file GET, not ranged.
    expect(satReqs[0].headers.Range).toBeUndefined();
    expect(satReqs[0].headers['User-Agent']).toContain('GRAZE/');

    const meta = await readMeta(path.join(workDir, '.cache', 'socrates-meta.json'));
    expect(Object.keys(meta).sort()).toEqual(['maxProb', 'minRange', 'satcat']);
    expect(meta.satcat.etag).toBe('"sat-v1"');
    expect(meta.minRange.etag).toBe('"soc-v1"');

    const written = JSON.parse(await readFile(path.join(workDir, 'socrates.json'), 'utf8'));
    expect(written.conjunctions[0].regime1).toBe('LEO');
    expect(written).toHaveProperty('regimeUnknownRecords');
  });

  it('reuses cached regimes when SATCAT alone returns 304', async () => {
    const satcat = [
      'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE',
      'A,2020-001A,25544,PAY,+,US,2020-01-01,AFETR,,92.9,51.6,420,410,5.0,,EA,ORB',
    ].join(String.fromCharCode(10)) + String.fromCharCode(10);
    const seed = async (url) =>
      url.includes('satcat')
        ? { status: 200, ok: true, text: async () => satcat, headers: new Headers({ etag: '"s1"' }) }
        : { status: 206, ok: false, text: async () => CSV, headers: new Headers({ etag: '"c1"' }) };
    await main(mainOptions(seed));

    // SOCRATES changes, SATCAT does not.
    const mixed = async (url) =>
      url.includes('satcat')
        ? { status: 304, ok: false, headers: new Headers() }
        : { status: 206, ok: false, text: async () => CSV, headers: new Headers({ etag: '"c2"' }) };
    expect(await main(mainOptions(mixed))).toBe(0);
    const written = JSON.parse(await readFile(path.join(workDir, 'socrates.json'), 'utf8'));
    // Regimes survived the 304 by being read back out of the previous payload.
    expect(written.conjunctions[0].regime1).toBe('LEO');
  });
});

describe('schema upgrades force a rebuild', () => {
  /**
   * Regression: the "both sources unchanged" shortcut returned early before the
   * regime step, so a payload written by an older schema was served unchanged
   * forever — SOCRATES had not changed, so the shortcut kept firing. A version
   * bump must defeat it.
   */
  it('rebuilds when the cached payload predates the current schema', async () => {
    const out = path.join(workDir, 'socrates.json');
    const seed = async (url) =>
      url.includes('satcat')
        ? { status: 200, ok: true, text: async () => SATCAT_STUB, headers: new Headers({ etag: '"s"' }) }
        : { status: 206, ok: false, text: async () => CSV, headers: new Headers({ etag: '"c"' }) };
    await main(mainOptions(seed));

    // Downgrade the written payload to an older schema, as an upgrade would find it.
    const stale = JSON.parse(await readFile(out, 'utf8'));
    stale.schemaVersion = 2;
    for (const c of stale.conjunctions) {
      delete c.regime1;
      delete c.regime2;
    }
    await writeFile(out, JSON.stringify(stale));

    // Nothing upstream changed.
    const allStale = async (url) =>
      url.includes('satcat')
        ? { status: 304, ok: false, headers: new Headers() }
        : { status: 304, ok: false, headers: new Headers() };
    expect(await main(mainOptions(allStale))).toBe(0);

    const after = JSON.parse(await readFile(out, 'utf8'));
    expect(after.schemaVersion).toBe(4);
    expect(after.conjunctions[0]).toHaveProperty('regime1');
  });
});
