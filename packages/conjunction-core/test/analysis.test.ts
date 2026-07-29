import { describe, expect, it } from 'vitest';
import {
  classifyOrbitRegime,
  classifyOrbitRegimeFromCatalog,
  regimeFromPeriodAndEccentricity,
  eciDistance,
  getEarthRotationRadians,
  getSunDirectionEci,
  interpolateStateAt,
  sharesOrbitSolution,
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

describe('getEarthRotationRadians', () => {
  it('matches the known GMST at the J2000.0 epoch (~280.46°)', () => {
    const gmst = getEarthRotationRadians(new Date('2000-01-01T12:00:00Z'));
    expect(gmst).toBeCloseTo(280.46061837504728 * (Math.PI / 180), 4);
  });

  it('returns to the same angle after one sidereal day (~23h56m4s)', () => {
    const start = new Date('2026-06-12T00:00:00Z');
    const siderealDayMs = 86_164_090.5;
    const end = new Date(start.getTime() + siderealDayMs);
    // A full sidereal day is one complete rotation, so GMST wraps back to
    // (approximately) the same angle — pick a start well clear of the 0/2π
    // seam so the wrapped values are directly comparable.
    expect(getEarthRotationRadians(start)).toBeGreaterThan(1);
    expect(getEarthRotationRadians(start)).toBeLessThan(2 * Math.PI - 1);
    expect(getEarthRotationRadians(end)).toBeCloseTo(getEarthRotationRadians(start), 5);
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

describe('sharesOrbitSolution', () => {
  /**
   * Real values from CelesTrak's public GP endpoint on 2026-07-27: NORAD 67689
   * (2026-024A, "PRC TEST SPACECRAFT 4") and 69673 (2026-024H, "CZ-2F DEB")
   * are two pieces of one launch published with the *same* orbit solution.
   * Only identity and bookkeeping fields differ.
   */
  const PIECE_A: OrbitalElements = {
    OBJECT_NAME: 'PRC TEST SPACECRAFT 4',
    OBJECT_ID: '2026-024A',
    EPOCH: '2026-07-27T23:04:00.103584',
    MEAN_MOTION: 14.91844734,
    ECCENTRICITY: 0.00047138,
    INCLINATION: 49.9944,
    RA_OF_ASC_NODE: 84.325,
    ARG_OF_PERICENTER: 191.4754,
    MEAN_ANOMALY: 168.6081,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: 67689,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 2552,
    BSTAR: 3.6361674e-5,
    MEAN_MOTION_DOT: 1.27e-6,
    MEAN_MOTION_DDOT: 0,
  };
  const PIECE_H: OrbitalElements = {
    ...PIECE_A,
    OBJECT_NAME: 'CZ-2F DEB',
    OBJECT_ID: '2026-024H',
    NORAD_CAT_ID: 69673,
    REV_AT_EPOCH: 2598,
  };

  it('detects the real shared-solution pair', () => {
    expect(sharesOrbitSolution(PIECE_A, PIECE_H)).toBe(true);
  });

  it('ignores identity and bookkeeping differences', () => {
    // Exactly the four fields that differ upstream must not affect the verdict.
    expect(sharesOrbitSolution(PIECE_A, { ...PIECE_A, NORAD_CAT_ID: 1 })).toBe(true);
    expect(sharesOrbitSolution(PIECE_A, { ...PIECE_A, OBJECT_NAME: 'OTHER' })).toBe(true);
    expect(sharesOrbitSolution(PIECE_A, { ...PIECE_A, OBJECT_ID: '1999-001Z' })).toBe(true);
    expect(sharesOrbitSolution(PIECE_A, { ...PIECE_A, REV_AT_EPOCH: 1 })).toBe(true);
  });

  it('is false when any propagated field differs, however slightly', () => {
    const fields = [
      ['EPOCH', '2026-07-27T23:04:00.103585'],
      ['MEAN_MOTION', 14.91844735],
      ['ECCENTRICITY', 0.00047139],
      ['INCLINATION', 49.9945],
      ['RA_OF_ASC_NODE', 84.326],
      ['ARG_OF_PERICENTER', 191.4755],
      ['MEAN_ANOMALY', 168.6082],
      ['BSTAR', 3.6361675e-5],
      ['MEAN_MOTION_DOT', 1.28e-6],
      ['MEAN_MOTION_DDOT', 1e-9],
    ] as const;
    for (const [field, value] of fields) {
      expect(sharesOrbitSolution(PIECE_A, { ...PIECE_A, [field]: value })).toBe(false);
    }
  });

  it('is true for an element set compared with itself', () => {
    expect(sharesOrbitSolution(PIECE_A, PIECE_A)).toBe(true);
  });
});

describe('regime boundaries', () => {
  /**
   * Boundaries are GRAZE's own convention, defined once in analysis.ts:
   *   HEO e > 0.25 | LEO period < 225 | MEO 225..1400 | GEO > 1400 (min)
   * Both entry points must agree on them, so both are exercised here.
   */
  const catalog = (periodMinutes: number, apogeeKm: number, perigeeKm: number) =>
    classifyOrbitRegimeFromCatalog({ periodMinutes, apogeeKm, perigeeKm });

  it('places the LEO/MEO boundary at 225 minutes', () => {
    expect(regimeFromPeriodAndEccentricity(224.999, 0)).toBe('LEO');
    expect(regimeFromPeriodAndEccentricity(225, 0)).toBe('MEO');
  });

  it('places the MEO/GEO boundary at 1400 minutes', () => {
    expect(regimeFromPeriodAndEccentricity(1400, 0)).toBe('MEO');
    expect(regimeFromPeriodAndEccentricity(1400.001, 0)).toBe('GEO');
  });

  it('treats eccentricity > 0.25 as HEO regardless of period', () => {
    expect(regimeFromPeriodAndEccentricity(0.25, 0.25)).toBe('LEO'); // at, not over
    expect(regimeFromPeriodAndEccentricity(100, 0.2500001)).toBe('HEO');
    expect(regimeFromPeriodAndEccentricity(1500, 0.9)).toBe('HEO');
  });

  it('derives eccentricity from apsides for catalogue rows', () => {
    // Circular LEO: apogee == perigee -> e = 0.
    expect(catalog(96, 400, 400)).toBe('LEO');
    // Molniya-like: very eccentric, ~718 min -> HEO wins over period.
    expect(catalog(718, 39900, 500)).toBe('HEO');
    // Near-circular GEO.
    expect(catalog(1436, 35786, 35786)).toBe('GEO');
    // Near-circular MEO (GPS-like, ~718 min).
    expect(catalog(718, 20200, 20180)).toBe('MEO');
  });

  it('agrees with the element-set path at the same period', () => {
    // 1440 / meanMotion = period; pick meanMotion for exactly 225 min.
    const elements = { ...ISS_LIKE, MEAN_MOTION: 1440 / 225, ECCENTRICITY: 0 };
    expect(classifyOrbitRegime(elements)).toBe(regimeFromPeriodAndEccentricity(225, 0));
  });

  it('returns null — not a default — when catalogue fields are unusable', () => {
    expect(catalog(Number.NaN, 400, 400)).toBeNull();
    expect(catalog(96, Number.NaN, 400)).toBeNull();
    expect(catalog(0, 400, 400)).toBeNull();
  });
});
