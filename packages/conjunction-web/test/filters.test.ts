import { describe, expect, it } from 'vitest';
import { eventPassesFilters } from '../src/ui/filters.js';
import type { ConjunctionFilters, RegimeLookup } from '../src/ui/filters.js';
import type { ConjunctionEvent, OrbitRegime } from 'conjunction-core';

const EVENT: ConjunctionEvent = {
  noradId1: 25544,
  name1: 'ISS (ZARYA)',
  noradId2: 30259,
  name2: 'FENGYUN 1C DEB [-]',
  tca: new Date('2026-06-14T07:12:07.053Z'),
  minRange: 0.013,
  relativeSpeed: 14.441,
  maxProbability: 1.193e-2,
  dse1: 3.03,
  dse2: 3.396,
};

const SHOW_ALL: ConjunctionFilters = {
  regimes: new Set(['LEO', 'MEO', 'GEO', 'HEO']),
  types: new Set(['payload', 'debris', 'rocket-body']),
  maxMissKm: 5,
  minProbability: Number.NEGATIVE_INFINITY,
};

const allLeo: RegimeLookup = () => 'LEO';
const unknownRegime: RegimeLookup = () => undefined;

describe('eventPassesFilters', () => {
  it('passes with show-all filters', () => {
    expect(eventPassesFilters(EVENT, SHOW_ALL, allLeo)).toBe(true);
  });

  it('filters by miss distance', () => {
    expect(eventPassesFilters(EVENT, { ...SHOW_ALL, maxMissKm: 0.01 }, allLeo)).toBe(false);
  });

  it('filters by probability threshold, exclusive', () => {
    expect(eventPassesFilters(EVENT, { ...SHOW_ALL, minProbability: 1e-4 }, allLeo)).toBe(true);
    expect(eventPassesFilters(EVENT, { ...SHOW_ALL, minProbability: 1e-1 }, allLeo)).toBe(false);
  });

  it('shows zero-probability events only with show-all', () => {
    const noProb = { ...EVENT, maxProbability: 0 };
    expect(eventPassesFilters(noProb, SHOW_ALL, allLeo)).toBe(true);
    expect(eventPassesFilters(noProb, { ...SHOW_ALL, minProbability: 1e-7 }, allLeo)).toBe(false);
  });

  it('passes the type filter when either object matches', () => {
    const payloadOnly = { ...SHOW_ALL, types: new Set(['payload'] as const) };
    expect(eventPassesFilters(EVENT, payloadOnly, allLeo)).toBe(true); // ISS is a payload
    const rocketOnly = { ...SHOW_ALL, types: new Set(['rocket-body'] as const) };
    expect(eventPassesFilters(EVENT, rocketOnly, allLeo)).toBe(false);
  });

  it('filters by regime when both objects are classified', () => {
    const geoOnly = { ...SHOW_ALL, regimes: new Set(['GEO'] as const) };
    expect(eventPassesFilters(EVENT, geoOnly, allLeo)).toBe(false);
    const mixed: RegimeLookup = (id) => (id === 25544 ? 'LEO' : ('GEO' as OrbitRegime));
    expect(eventPassesFilters(EVENT, geoOnly, mixed)).toBe(true);
  });

  it('does not hide events whose regimes are still unknown', () => {
    const geoOnly = { ...SHOW_ALL, regimes: new Set(['GEO'] as const) };
    expect(eventPassesFilters(EVENT, geoOnly, unknownRegime)).toBe(true);
  });
});
