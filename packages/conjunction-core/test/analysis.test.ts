import { describe, expect, it } from 'vitest';
import {
  classifyOrbitRegime,
  eciDistance,
  getSunDirectionEci,
  interpolateStateAt,
  summarizeOrbit,
} from '../src/analysis.js';
import { classifyObjectType } from '../src/socrates.js';
import type { OrbitalElements, PropagatedPosition } from '../src/types.js';

const ISS_LIKE: OrbitalElements = {
  OBJECT_NAME: 'ISS (ZARYA)',
  OBJECT_ID: '1998-067A',
  EPOCH: '2026-06-01T12:00:00.000000',
  MEAN_MOTION: 15.54,
  ECCENTRICITY: 0.0004976,
  INCLINATION: 51.6416,
  RA_OF_ASC_NODE: 247.4627,
  ARG_OF_PERICENTER: 130.536,
  MEAN_ANOMALY: 325.0288,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 50000,
  BSTAR: 3.3e-5,
  MEAN_MOTION_DOT: 2.02e-5,
  MEAN_MOTION_DDOT: 0,
};

describe('summarizeOrbit', () => {
  const summary = summarizeOrbit(ISS_LIKE);

  it('passes inclination through', () => {
    expect(summary.inclinationDeg).toBeCloseTo(51.6416);
  });

  it('derives a plausible ISS apogee and perigee', () => {
    expect(summary.perigeeKm).toBeGreaterThan(395);
    expect(summary.perigeeKm).toBeLessThan(415);
    expect(summary.apogeeKm).toBeGreaterThan(summary.perigeeKm);
    expect(summary.apogeeKm).toBeLessThan(420);
  });

  it('derives the period from mean motion', () => {
    expect(summary.periodMinutes).toBeCloseTo(1440 / 15.54, 5);
  });
});

describe('classifyOrbitRegime', () => {
  const withMotion = (meanMotion: number, eccentricity = 0.001): OrbitalElements => ({
    ...ISS_LIKE,
    MEAN_MOTION: meanMotion,
    ECCENTRICITY: eccentricity,
  });

  it('classifies the ISS as LEO', () => {
    expect(classifyOrbitRegime(ISS_LIKE)).toBe('LEO');
  });

  it('classifies a 12-hour orbit as MEO', () => {
    expect(classifyOrbitRegime(withMotion(2.0))).toBe('MEO'); // 720 min
  });

  it('classifies a geosynchronous orbit as GEO', () => {
    expect(classifyOrbitRegime(withMotion(1.0027))).toBe('GEO'); // ~1436 min
  });

  it('classifies highly elliptical orbits as HEO regardless of period', () => {
    expect(classifyOrbitRegime(withMotion(2.0, 0.74))).toBe('HEO'); // Molniya-like
  });
});

describe('classifyObjectType', () => {
  it('detects debris from a DEB token', () => {
    expect(classifyObjectType('FENGYUN 1C DEB [-]')).toBe('debris');
    expect(classifyObjectType('COSMOS 2251 DEB')).toBe('debris');
  });

  it('detects rocket bodies from R/B', () => {
    expect(classifyObjectType('CZ-4B R/B')).toBe('rocket-body');
    expect(classifyObjectType('SL-12 R/B(2)')).toBe('rocket-body');
  });

  it('treats everything else as payload, even names containing DEB as a substring', () => {
    expect(classifyObjectType('ISS (ZARYA)')).toBe('payload');
    expect(classifyObjectType('DEBUT (ORIZURU)')).toBe('payload');
  });
});

describe('getSunDirectionEci', () => {
  it('returns a unit vector', () => {
    const sun = getSunDirectionEci(new Date('2026-06-12T00:00:00Z'));
    expect(Math.hypot(sun.x, sun.y, sun.z)).toBeCloseTo(1, 6);
  });

  it('points at the vernal equinox direction (+X) on 2026-03-20', () => {
    // March equinox 2026 occurs at ~14:46 UTC.
    const sun = getSunDirectionEci(new Date('2026-03-20T14:46:00Z'));
    expect(sun.x).toBeGreaterThan(0.9999);
    expect(Math.abs(sun.y)).toBeLessThan(0.01);
    expect(Math.abs(sun.z)).toBeLessThan(0.01);
  });

  it('points at the summer solstice direction on 2026-06-21', () => {
    // June solstice 2026 occurs at ~08:24 UTC: ecliptic longitude 90°, so the
    // direction is (0, cos ε, sin ε) with ε ≈ 23.44°.
    const sun = getSunDirectionEci(new Date('2026-06-21T08:24:00Z'));
    expect(Math.abs(sun.x)).toBeLessThan(0.01);
    expect(sun.y).toBeCloseTo(Math.cos(23.437 * (Math.PI / 180)), 2);
    expect(sun.z).toBeCloseTo(Math.sin(23.437 * (Math.PI / 180)), 2);
  });
});

describe('eciDistance', () => {
  it('computes euclidean distance in km', () => {
    expect(eciDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })).toBe(5);
  });
});

function samplePoint(timeMs: number, x: number): PropagatedPosition {
  return {
    timestamp: new Date(timeMs),
    latitude: 0,
    longitude: 0,
    altitude: 400,
    positionEci: { x, y: 0, z: 0 },
    velocityEci: { x: 0, y: 7.7, z: 0 },
  };
}

describe('interpolateStateAt', () => {
  const orbit = [samplePoint(0, 100), samplePoint(30_000, 130), samplePoint(60_000, 190)];

  it('interpolates linearly between samples', () => {
    const state = interpolateStateAt(orbit, new Date(15_000));
    expect(state?.positionEci.x).toBeCloseTo(115);
    expect(state?.timestamp.getTime()).toBe(15_000);
  });

  it('returns exact samples at sample times', () => {
    expect(interpolateStateAt(orbit, new Date(30_000))?.positionEci.x).toBeCloseTo(130);
  });

  it('clamps to the nearest end outside the range', () => {
    expect(interpolateStateAt(orbit, new Date(-5_000))?.positionEci.x).toBe(100);
    expect(interpolateStateAt(orbit, new Date(90_000))?.positionEci.x).toBe(190);
  });

  it('returns null for an empty orbit', () => {
    expect(interpolateStateAt([], new Date(0))).toBeNull();
  });
});
