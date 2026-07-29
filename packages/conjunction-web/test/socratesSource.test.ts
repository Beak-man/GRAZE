import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_AGE_HOURS,
  dataEpochOf,
  isUpstreamQuiet,
  loadBaked,
  perFileCount,
  readSourceConfig,
  roundEstimate,
  scopeDisclosure,
  selectSource,
} from '../src/data/socratesSource.js';
import type { BakedSocrates, SourceConfig } from '../src/data/socratesSource.js';

const NOW = new Date('2026-07-28T12:00:00Z');
const HOUR = 3_600_000;

function config(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    mode: 'auto',
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
    isDev: false,
    useLocalSocrates: false,
    ...overrides,
  };
}

/** A baked probe whose *pipeline* run (generatedAt) is `hours` before NOW. */
function agedBy(hours: number): { generatedAt: string } {
  return { generatedAt: new Date(NOW.getTime() - hours * HOUR).toISOString() };
}

describe('selectSource', () => {
  it('branch 1: dev + VITE_USE_LOCAL_SOCRATES uses bundled data', () => {
    const selection = selectSource(
      config({ isDev: true, useLocalSocrates: true }),
      agedBy(1),
      NOW,
    );
    expect(selection.kind).toBe('local');
  });

  it('branch 1 is NOT age-gated: very stale local data still stays local', () => {
    // The point of the guard: a freshness check here would push routine dev
    // traffic onto CelesTrak, which is what the whole refactor exists to avoid.
    const selection = selectSource(
      config({ isDev: true, useLocalSocrates: true }),
      agedBy(24 * 365),
      NOW,
    );
    expect(selection.kind).toBe('local');
  });

  it('branch 1 holds even with no baked file at all (no network fallback)', () => {
    const selection = selectSource(config({ isDev: true, useLocalSocrates: true }), null, NOW);
    expect(selection.kind).toBe('local');
  });

  it('branch 2: fresh baked file is used', () => {
    const selection = selectSource(config(), agedBy(2), NOW);
    expect(selection.kind).toBe('baked');
    expect(selection.kind === 'baked' && selection.ageMs).toBeCloseTo(2 * HOUR, -2);
  });

  it('branch 2 boundary: exactly at MAX_AGE is still fresh', () => {
    const selection = selectSource(config({ maxAgeHours: 8 }), agedBy(8), NOW);
    expect(selection.kind).toBe('baked');
  });

  it('branch 3: stale baked file still renders, flagged stale', () => {
    const selection = selectSource(config({ maxAgeHours: 8 }), agedBy(30), NOW);
    expect(selection.kind).toBe('baked-stale');
    expect(selection.kind === 'baked-stale' && selection.ageMs).toBeGreaterThan(8 * HOUR);
  });

  it('branch 4: no baked file falls back to a runtime fetch', () => {
    expect(selectSource(config(), null, NOW).kind).toBe('runtime');
  });

  it('mode=baked never networks, even with nothing baked', () => {
    expect(selectSource(config({ mode: 'baked' }), null, NOW).kind).toBe('baked');
  });

  it('mode=baked never reports stale (it has no fallback to offer)', () => {
    expect(selectSource(config({ mode: 'baked' }), agedBy(500), NOW).kind).toBe('baked');
  });

  it('mode=runtime ignores the baked file entirely', () => {
    expect(selectSource(config({ mode: 'runtime' }), agedBy(1), NOW).kind).toBe('runtime');
  });

  it('mode=runtime wins even in dev with local data requested', () => {
    const selection = selectSource(
      config({ mode: 'runtime', isDev: true, useLocalSocrates: true }),
      agedBy(1),
      NOW,
    );
    expect(selection.kind).toBe('runtime');
  });

  it('an undated or unparseable baked file is usable but never stale', () => {
    expect(selectSource(config(), { generatedAt: null }, NOW).kind).toBe('baked');
    expect(selectSource(config(), { generatedAt: 'not-a-date' }, NOW).kind).toBe('baked');
  });

  it('production ignores useLocalSocrates (the dev bypass is dev-only)', () => {
    const selection = selectSource(
      config({ isDev: false, useLocalSocrates: true }),
      agedBy(1),
      NOW,
    );
    expect(selection.kind).toBe('baked');
  });
});

describe('readSourceConfig', () => {
  it('defaults to auto mode and a 24 hour max age', () => {
    const parsed = readSourceConfig({}, false);
    expect(parsed.mode).toBe('auto');
    expect(parsed.maxAgeHours).toBe(DEFAULT_MAX_AGE_HOURS);
    expect(parsed.useLocalSocrates).toBe(false);
  });

  it('reads each supported override', () => {
    const parsed = readSourceConfig(
      {
        VITE_DATA_MODE: 'runtime',
        VITE_MAX_DATA_AGE_HOURS: '3',
        VITE_USE_LOCAL_SOCRATES: 'true',
      },
      true,
    );
    expect(parsed).toEqual({
      mode: 'runtime',
      maxAgeHours: 3,
      isDev: true,
      useLocalSocrates: true,
    });
  });

  it('falls back to defaults on nonsense values', () => {
    const parsed = readSourceConfig(
      { VITE_DATA_MODE: 'wat', VITE_MAX_DATA_AGE_HOURS: '-5' },
      false,
    );
    expect(parsed.mode).toBe('auto');
    expect(parsed.maxAgeHours).toBe(DEFAULT_MAX_AGE_HOURS);
  });
});

function bakedFixture(overrides: Partial<BakedSocrates> = {}): BakedSocrates {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-28T00:00:00.000Z',
    sourceUrl: 'https://celestrak.org/SOCRATES/sort-minRange.csv',
    sourceLastModified: '2026-07-27T23:00:00.000Z',
    socratesEpoch: null,
    recordCount: 1,
    conjunctions: [
      {
        noradId1: 25544,
        name1: 'ISS (ZARYA)',
        noradId2: 100001,
        name2: 'TEST DEB',
        tca: new Date('2026-07-29T01:02:03.000Z'),
        minRange: 0.42,
        relativeSpeed: 12.3,
        maxProbability: 1e-4,
        dse1: 1,
        dse2: 2,
      },
    ],
    ...overrides,
  };
}

describe('dataEpochOf', () => {
  it('prefers socratesEpoch when present', () => {
    const baked = bakedFixture({ socratesEpoch: '2026-07-26T00:00:00.000Z' });
    expect(dataEpochOf(baked)).toBe('2026-07-26T00:00:00.000Z');
  });

  it('falls back to sourceLastModified', () => {
    expect(dataEpochOf(bakedFixture())).toBe('2026-07-27T23:00:00.000Z');
  });

  it('is null when neither is known', () => {
    expect(dataEpochOf(bakedFixture({ sourceLastModified: null }))).toBeNull();
  });
});

describe('loadBaked', () => {
  /** All HTTP here is mocked; no test may reach CelesTrak. */
  function mockFetch(body: unknown, ok = true): typeof fetch {
    return vi.fn(async () =>
      Promise.resolve({
        ok,
        json: async () => Promise.resolve(body),
      }),
    ) as unknown as typeof fetch;
  }

  it('revives tca into a Date', async () => {
    const wire = JSON.parse(JSON.stringify(bakedFixture())) as unknown;
    const loaded = await loadBaked('/data/socrates.json', mockFetch(wire));
    expect(loaded).not.toBeNull();
    expect(loaded?.conjunctions[0]?.tca).toBeInstanceOf(Date);
    expect(loaded?.conjunctions[0]?.tca.toISOString()).toBe('2026-07-29T01:02:03.000Z');
  });

  it('returns null for a missing file rather than throwing', async () => {
    expect(await loadBaked('/data/socrates.json', mockFetch({}, false))).toBeNull();
  });

  it('returns null for a malformed or empty payload', async () => {
    expect(await loadBaked('/x.json', mockFetch({ nope: true }))).toBeNull();
    expect(
      await loadBaked('/x.json', mockFetch(bakedFixture({ conjunctions: [] }))),
    ).toBeNull();
  });

  it('returns null when the request throws (offline)', async () => {
    const throwing = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await loadBaked('/data/socrates.json', throwing)).toBeNull();
  });
});

describe('staleness is keyed on generatedAt, not sourceLastModified', () => {
  /**
   * The two questions are different:
   *   generatedAt        -> "is OUR bake pipeline alive"  (drives the banner)
   *   sourceLastModified -> "is CELESTRAK publishing"     (informational only)
   *
   * Conflating them produced false "stale" banners whenever CelesTrak ran long,
   * and every one of those invited a click that re-fetched an identical file.
   */
  it('is fresh when the pipeline ran recently, however old upstream is', () => {
    const selection = selectSource(config(), { generatedAt: agedBy(2).generatedAt }, NOW);
    expect(selection.kind).toBe('baked');
  });

  it('defaults to a 24h threshold, not the 8h scheduler cadence', () => {
    // 8h would flip to stale on a single late run; 24h tolerates three.
    expect(DEFAULT_MAX_AGE_HOURS).toBe(24);
    expect(selectSource(config(), agedBy(9), NOW).kind).toBe('baked');
    expect(selectSource(config(), agedBy(25), NOW).kind).toBe('baked-stale');
  });

  it('flags stale only once the pipeline itself has gone quiet', () => {
    expect(selectSource(config(), agedBy(23), NOW).kind).toBe('baked');
    expect(selectSource(config(), agedBy(48), NOW).kind).toBe('baked-stale');
  });
});

describe('isUpstreamQuiet', () => {
  const quietFixture = (upstreamHoursAgo: number): BakedSocrates =>
    bakedFixture({
      generatedAt: new Date(NOW.getTime() - HOUR).toISOString(),
      sourceLastModified: new Date(NOW.getTime() - upstreamHoursAgo * HOUR).toISOString(),
      socratesEpoch: null,
    });

  it('reports quiet when upstream has not published for over a day', () => {
    expect(isUpstreamQuiet(quietFixture(30), NOW)).toBe(true);
  });

  it('is silent when upstream is recent', () => {
    expect(isUpstreamQuiet(quietFixture(3), NOW)).toBe(false);
  });

  it('is silent when upstream time is unknown', () => {
    expect(
      isUpstreamQuiet(bakedFixture({ sourceLastModified: null, socratesEpoch: null }), NOW),
    ).toBe(false);
  });

  /**
   * The case that motivated the split: CelesTrak quiet for days while our bake
   * ran an hour ago. That is NOT a fault, so it must not produce a stale
   * selection — which is what puts a "Fetch latest" button on screen.
   */
  it('old upstream + fresh pipeline => no stale banner, so no fetch button', () => {
    const baked = quietFixture(72);
    expect(isUpstreamQuiet(baked, NOW)).toBe(true);
    const selection = selectSource(config(), { generatedAt: baked.generatedAt }, NOW);
    expect(selection.kind).toBe('baked');
    expect(selection.kind).not.toBe('baked-stale');
  });
});

describe('scopeDisclosure', () => {
  it('reports what is shown against the full screening run', () => {
    const baked = bakedFixture({ recordCount: 1389, estimatedTotalRecords: 149500 });
    expect(scopeDisclosure(baked, 1000)).toEqual({
      shown: 1389,
      // Rounded: the total is a size-derived estimate, not a count.
      total: 150000,
      perFile: 1000,
    });
  });

  it('tolerates an unknown total', () => {
    expect(scopeDisclosure(bakedFixture({ recordCount: 5 }), 1000).total).toBeNull();
  });
});

describe('roundEstimate', () => {
  /**
   * estimatedTotalRecords comes from bytes / mean-row-length. Presenting it as
   * "~149,751" implies a count; it is an estimate good to ~2 significant figures.
   */
  it('rounds to the nearest thousand', () => {
    expect(roundEstimate(149751)).toBe(150000);
    expect(roundEstimate(149400)).toBe(149000);
  });

  it('passes through unknowns as null', () => {
    expect(roundEstimate(null)).toBeNull();
    expect(roundEstimate(undefined)).toBeNull();
    expect(roundEstimate(Number.NaN)).toBeNull();
  });

  it('feeds the disclosure a rounded total', () => {
    const baked = bakedFixture({ recordCount: 1389, estimatedTotalRecords: 149751 });
    expect(scopeDisclosure(baked, 1000).total).toBe(150000);
  });
});

describe('perFileCount', () => {
  /**
   * Regression: `sources` also carries satcat (the regime catalogue, ~68k rows).
   * Taking the max across all of them made the disclosure read "the 68081
   * closest approaches" instead of 1000.
   */
  const withSources = () =>
    bakedFixture({
      recordCount: 1389,
      sources: {
        minRange: { url: 'u/min', lastModified: null, recordCount: 1000 },
        maxProb: { url: 'u/max', lastModified: null, recordCount: 1000 },
        satcat: { url: 'u/satcat', lastModified: null, recordCount: 68081 },
      },
    });

  it('counts only the SOCRATES orderings, never the catalogue', () => {
    expect(perFileCount(withSources())).toBe(1000);
  });

  it('feeds the disclosure the ordering count', () => {
    expect(scopeDisclosure(withSources()).perFile).toBe(1000);
  });

  it('is zero when no ordering metadata exists', () => {
    expect(perFileCount(bakedFixture())).toBe(0);
  });
});
