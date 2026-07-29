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
  buildPayload,
  buildUserAgent,
  extractSocratesEpoch,
  fetchCsv,
  main,
  readMeta,
  writeMeta,
  writePayloadAtomically,
} from './fetch-socrates.mjs';
import { parseSocratesCsv } from '../packages/conjunction-core/dist/index.js';

const CSV = [
  'NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION',
  '25544,ISS (ZARYA) [+],1.0,100001,TEST DEB [-],2.0,2026-07-29 01:02:03.000,0.013,14.4,1.19E-02,0.007',
  '47919,STARLINK-2405 [+],5.0,68098,GLOBAL-34 [+],4.9,2026-07-30 20:53:01.605,0.014,4.5,3.42E-01,0.004',
].join('\n');

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

describe('buildPayload', () => {
  it('produces the documented metadata shape including schemaVersion', () => {
    const payload = buildPayload({
      csv: CSV,
      url: 'https://example.invalid/sort-minRange.csv',
      lastModified: 'Mon, 27 Jul 2026 23:00:00 GMT',
      maxRecords: 10,
      parseSocratesCsv,
      now: new Date('2026-07-28T00:00:00Z'),
    });
    expect(payload.schemaVersion).toBe(1);
    expect(payload.generatedAt).toBe('2026-07-28T00:00:00.000Z');
    expect(payload.sourceUrl).toBe('https://example.invalid/sort-minRange.csv');
    expect(payload.sourceLastModified).toBe('2026-07-27T23:00:00.000Z');
    expect(payload).toHaveProperty('socratesEpoch');
    expect(payload.recordCount).toBe(2);
    expect(payload.conjunctions).toHaveLength(2);
  });

  it('keeps only the fields the app reads', () => {
    const payload = buildPayload({ csv: CSV, url: 'u', maxRecords: 1, parseSocratesCsv });
    expect(Object.keys(payload.conjunctions[0]).sort()).toEqual(
      [
        'dse1',
        'dse2',
        'maxProbability',
        'minRange',
        'name1',
        'name2',
        'noradId1',
        'noradId2',
        'relativeSpeed',
        'tca',
      ].sort(),
    );
    // DILUTION is present in the CSV and deliberately dropped.
    expect(payload.conjunctions[0]).not.toHaveProperty('DILUTION');
  });

  it('honours the record cap', () => {
    expect(buildPayload({ csv: CSV, url: 'u', maxRecords: 1, parseSocratesCsv }).recordCount).toBe(1);
  });

  it('throws rather than publishing an empty result', () => {
    const headerOnly = CSV.split('\n')[0];
    expect(() => buildPayload({ csv: headerOnly, url: 'u', maxRecords: 10, parseSocratesCsv })).toThrow(
      /0 conjunctions/,
    );
  });

  it('reports a null socratesEpoch when the CSV carries none', () => {
    expect(buildPayload({ csv: CSV, url: 'u', maxRecords: 10, parseSocratesCsv }).socratesEpoch).toBeNull();
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

describe('writePayloadAtomically', () => {
  it('refuses to overwrite a good file with a zero-record payload', async () => {
    const out = path.join(workDir, 'socrates.json');
    const good = buildPayload({ csv: CSV, url: 'u', maxRecords: 10, parseSocratesCsv });
    await writePayloadAtomically(good, out);
    const before = await readFile(out, 'utf8');

    await expect(
      writePayloadAtomically({ ...good, recordCount: 0, conjunctions: [] }, out),
    ).rejects.toThrow(/no records/);
    expect(await readFile(out, 'utf8')).toBe(before);
  });

  it('leaves no .tmp file behind on success', async () => {
    const out = path.join(workDir, 'socrates.json');
    await writePayloadAtomically(
      buildPayload({ csv: CSV, url: 'u', maxRecords: 10, parseSocratesCsv }),
      out,
    );
    expect(existsSync(`${out}.tmp`)).toBe(false);
    expect(JSON.parse(await readFile(out, 'utf8')).recordCount).toBe(2);
  });

  it('writes minified JSON', async () => {
    const out = path.join(workDir, 'socrates.json');
    await writePayloadAtomically(
      buildPayload({ csv: CSV, url: 'u', maxRecords: 10, parseSocratesCsv }),
      out,
    );
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

/** main() with every side effect redirected into the test's temp dir. */
function mainOptions(fetchImpl, env = {}) {
  return {
    env: { SOCRATES_MAX_RECORDS: '10', ...env },
    log: silent,
    fetchImpl,
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
    expect(written.schemaVersion).toBe(1);
    expect(written.recordCount).toBe(2);
    expect(written.sourceLastModified).toBe('2026-07-27T23:00:00.000Z');

    expect(await readMeta(path.join(workDir, '.cache', 'socrates-meta.json'))).toEqual({
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

    // Conditional headers were sent on the second run, from the stored meta.
    expect(seenHeaders[1]['If-None-Match']).toBe('"v1"');
    expect(seenHeaders[1]['If-Modified-Since']).toBe('Mon, 27 Jul 2026 23:00:00 GMT');
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
      { etag: '"cached-v1"', lastModified: 'Mon, 27 Jul 2026 23:00:00 GMT' },
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

    const code = await main({
      env: { SOCRATES_MAX_RECORDS: '10' },
      log: silent,
      fetchImpl,
      outputPath,
      metaPath,
      backoffMs: 0,
    });

    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]['If-None-Match']).toBeUndefined();
    expect(seen[0]['If-Modified-Since']).toBeUndefined();
    // Still a proper request, just unconditional.
    expect(seen[0]['User-Agent']).toContain('GRAZE/');
    // And it actually produced the file the deploy needs.
    expect(existsSync(outputPath)).toBe(true);
    expect(JSON.parse(await readFile(outputPath, 'utf8')).recordCount).toBe(2);
  });

  it('still sends conditional headers when the output file IS present', async () => {
    const metaPath = path.join(workDir, '.cache', 'socrates-meta.json');
    const outputPath = path.join(workDir, 'socrates.json');
    await writePayloadAtomically(
      buildPayload({ csv: CSV, url: 'u', maxRecords: 10, parseSocratesCsv }),
      outputPath,
    );
    await writeMeta({ etag: '"cached-v1"' }, metaPath);

    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push(init.headers);
      return { status: 304, ok: false, headers: new Headers() };
    };
    const code = await main({
      env: { SOCRATES_MAX_RECORDS: '10' },
      log: silent,
      fetchImpl,
      outputPath,
      metaPath,
      backoffMs: 0,
    });
    expect(code).toBe(0);
    expect(seen[0]['If-None-Match']).toBe('"cached-v1"');
  });
});
