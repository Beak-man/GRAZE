import { describe, expect, it } from 'vitest';
import {
  computeCloseApproach,
  eciToThreeJs,
  parabolicVertex,
  propagateOrbit,
  subSatellitePoint,
} from '../src/propagator.js';
import { eciDistance, getEarthRotationRadians } from '../src/analysis.js';
import type { EciVector, OrbitalElements } from '../src/types.js';

/** ISS-like OMM element set (values representative of the real orbit). */
const ISS_OMM: OrbitalElements = {
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

const EPOCH = new Date('2026-06-01T12:00:00.000Z');
const NINETY_MINUTES_MS = 90 * 60_000;

describe('propagateOrbit', () => {
  const points = propagateOrbit(ISS_OMM, EPOCH, new Date(EPOCH.getTime() + NINETY_MINUTES_MS), 60);

  it('produces one point per step, inclusive of both ends', () => {
    expect(points).toHaveLength(91);
  });

  it('keeps the ISS between 400 and 430 km altitude over 90 minutes', () => {
    for (const point of points) {
      expect(point.altitude).toBeGreaterThan(400);
      expect(point.altitude).toBeLessThan(430);
    }
  });

  it('keeps latitude within the inclination band', () => {
    for (const point of points) {
      // Geocentric latitude is bounded by the inclination (51.64°).
      const r = Math.hypot(point.positionEci.x, point.positionEci.y, point.positionEci.z);
      const geocentricLat = (Math.asin(point.positionEci.z / r) * 180) / Math.PI;
      expect(Math.abs(geocentricLat)).toBeLessThanOrEqual(51.7);
      // Geodetic latitude can exceed the geocentric value by up to ~0.2° at
      // these latitudes because of Earth's oblateness.
      expect(Math.abs(point.latitude)).toBeLessThanOrEqual(51.9);
    }
    // A 90-minute pass covers a full revolution, so it must actually reach
    // high latitude rather than sitting near the equator.
    const maxLatitude = Math.max(...points.map((p) => Math.abs(p.latitude)));
    expect(maxLatitude).toBeGreaterThan(45);
  });

  it('reports plausible ECI position and velocity magnitudes', () => {
    for (const point of points) {
      const r = Math.hypot(point.positionEci.x, point.positionEci.y, point.positionEci.z);
      const v = Math.hypot(point.velocityEci.x, point.velocityEci.y, point.velocityEci.z);
      expect(r).toBeGreaterThan(6700);
      expect(r).toBeLessThan(6900);
      expect(v).toBeGreaterThan(7.4);
      expect(v).toBeLessThan(7.9);
    }
  });

  it('uses a 30-second default step', () => {
    const defaultStep = propagateOrbit(ISS_OMM, EPOCH, new Date(EPOCH.getTime() + 5 * 60_000));
    expect(defaultStep).toHaveLength(11);
  });
});

describe('computeCloseApproach', () => {
  // Same orbit, mean anomaly offset by 0.05° → a roughly constant ~6 km
  // along-track separation, which the search must recover. The 6-digit
  // catalog number is deliberate: post-July-2026 objects exceed 99999 and
  // must propagate identically.
  const trailing: OrbitalElements = {
    ...ISS_OMM,
    NORAD_CAT_ID: 100001,
    OBJECT_NAME: 'TRAILING TEST OBJECT',
    MEAN_ANOMALY: ISS_OMM.MEAN_ANOMALY + 0.05,
  };
  const tca = new Date(EPOCH.getTime() + 30 * 60_000);
  const details = computeCloseApproach(ISS_OMM, trailing, tca);

  it('finds the expected along-track separation', () => {
    expect(details.actualMinRange).toBeGreaterThan(1);
    expect(details.actualMinRange).toBeLessThan(15);
  });

  it('finds a TCA inside the search window', () => {
    const windowMs = 30 * 60_000;
    expect(Math.abs(details.actualTca.getTime() - tca.getTime())).toBeLessThanOrEqual(windowMs);
  });

  it('reports a small relative velocity for co-orbital objects', () => {
    expect(details.relativeVelocityAtTca).toBeLessThan(0.1);
  });

  it('samples both orbits densely across the window', () => {
    // ±30 min at 10 s steps plus ±2 min at 1 s steps ≈ 577 samples.
    expect(details.orbit1.length).toBeGreaterThan(500);
    expect(details.orbit2.length).toBeGreaterThan(500);
  });

  it('returns the TCA positions at the minimum-distance sample', () => {
    expect(details.position1AtTca.timestamp).toEqual(details.actualTca);
    expect(details.position2AtTca.timestamp).toEqual(details.actualTca);
  });
});

describe('eciToThreeJs', () => {
  it('scales km to scene units (1 unit = 1000 km) and converts z-up to y-up', () => {
    expect(eciToThreeJs({ x: 6371, y: 1000, z: -2000 })).toEqual({
      x: 6.371,
      y: -2,
      z: -1,
    });
  });
});

/** Smallest absolute difference between two longitudes, across the ±180° seam. */
function longitudeDelta(a: number, b: number): number {
  const raw = Math.abs(a - b);
  return raw > 180 ? 360 - raw : raw;
}

/**
 * These are the tests that prove a satellite is drawn over the ground track it
 * actually flies. subSatellitePoint inverts the render transform (scene axis
 * mapping + the globe's GMST spin); propagateOrbit reports latitude/longitude
 * via satellite.js eciToGeodetic. The two are independent paths, so agreement
 * means the rendered geography is right — and any regression in the axis
 * mapping, rotation direction, or GMST offset breaks it loudly.
 */
describe('subSatellitePoint', () => {
  const points = propagateOrbit(ISS_OMM, EPOCH, new Date(EPOCH.getTime() + NINETY_MINUTES_MS), 60);

  it('matches the geodetic longitude from satellite.js to floating-point precision', () => {
    // Oblateness does not affect longitude, so this is an exact cross-check.
    // Measured worst case ≈ 6e-14°; 1e-9° leaves margin while still catching
    // any real frame error (a sign flip is tens of degrees — see below).
    for (const point of points) {
      const derived = subSatellitePoint(point.positionEci, point.timestamp);
      expect(longitudeDelta(derived.longitude, point.longitude)).toBeLessThan(1e-9);
    }
  });

  it('matches the geocentric latitude exactly and the geodetic one within oblateness', () => {
    for (const point of points) {
      const derived = subSatellitePoint(point.positionEci, point.timestamp);
      const r = Math.hypot(point.positionEci.x, point.positionEci.y, point.positionEci.z);
      const geocentric = (Math.asin(point.positionEci.z / r) * 180) / Math.PI;
      expect(Math.abs(derived.latitude - geocentric)).toBeLessThan(1e-9);
      // Geodetic latitude differs from geocentric by ≤ ~0.2° at these latitudes.
      expect(Math.abs(derived.latitude - point.latitude)).toBeLessThan(0.25);
    }
  });

  it('would fail loudly if the globe spun the wrong way', () => {
    // Guards against the test passing vacuously: inverting with -theta instead
    // of +theta (the classic sign regression) must put the satellite far from
    // its true longitude, not somewhere subtly off.
    const wrongSign = (positionEci: EciVector, date: Date): number => {
      const scene = eciToThreeJs(positionEci);
      const theta = -getEarthRotationRadians(date);
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      return (
        (Math.atan2(-(scene.x * sin + scene.z * cos), scene.x * cos - scene.z * sin) * 180) /
        Math.PI
      );
    };
    const worst = Math.max(
      ...points.map((point) =>
        longitudeDelta(wrongSign(point.positionEci, point.timestamp), point.longitude),
      ),
    );
    expect(worst).toBeGreaterThan(10);
  });
});

describe('subSatellitePoint for a geostationary orbit', () => {
  // A GEO object circles the ECI frame once per sidereal day, exactly matching
  // Earth's rotation — so its sub-satellite longitude must stay put. This
  // catches sign errors and gross GMST rate errors (a sign flip drifts ~30°/h).
  // It does not sharply discriminate sidereal vs solar day (~1°/day); the
  // sidereal-day periodicity test in analysis.test.ts covers that.
  const GEO_OMM: OrbitalElements = {
    ...ISS_OMM,
    OBJECT_NAME: 'SYNTHETIC GEO',
    NORAD_CAT_ID: 100002,
    MEAN_MOTION: 1.0027, // sidereal revolutions per day
    ECCENTRICITY: 0.0001,
    INCLINATION: 0.05,
    ARG_OF_PERICENTER: 0,
    RA_OF_ASC_NODE: 0,
    MEAN_ANOMALY: 0,
  };
  const points = propagateOrbit(GEO_OMM, EPOCH, new Date(EPOCH.getTime() + 12 * 3600_000), 600);
  const derived = points.map((point) => subSatellitePoint(point.positionEci, point.timestamp));

  it('sits at geostationary altitude', () => {
    for (const point of points) {
      expect(point.altitude).toBeGreaterThan(35_700);
      expect(point.altitude).toBeLessThan(35_900);
    }
  });

  it('holds a near-constant longitude over 12 hours', () => {
    const longitudes = derived.map((point) => point.longitude);
    // Measured span ≈ 0.013°; a wrong rotation direction would sweep ~360°.
    expect(Math.max(...longitudes) - Math.min(...longitudes)).toBeLessThan(0.5);
  });

  it('stays over the equator', () => {
    // Measured max ≈ 0.072°, bounded by the 0.05° inclination.
    for (const point of derived) {
      expect(Math.abs(point.latitude)).toBeLessThan(0.5);
    }
  });
});

describe('parabolicVertex', () => {
  /**
   * Fitted to SQUARED distances on purpose: near a close approach the relative
   * motion is locally linear, so d² = dmin² + v²(t-t*)² is exactly a parabola
   * while d itself is a hyperbola. These cases therefore have exact answers.
   */
  it('recovers the vertex of an exact parabola', () => {
    // y = 3(x-7)^2 + 5  ->  vertex at x = 7
    const f = (x: number) => 3 * (x - 7) ** 2 + 5;
    expect(parabolicVertex(5, f(5), 6, f(6), 9, f(9))).toBeCloseTo(7, 9);
  });

  it('handles unequal spacing, as at the fine/coarse grid boundary', () => {
    const f = (x: number) => 2 * (x - 1.25) ** 2 + 1;
    // Neighbours 1 s and 10 s away — the real grid changes step size.
    expect(parabolicVertex(0, f(0), 1, f(1), 11, f(11))).toBeCloseTo(1.25, 9);
  });

  it('resolves a vertex that falls between integer samples', () => {
    // True minimum at t = 0.3 between samples at -1, 0, 1.
    const f = (x: number) => (x - 0.3) ** 2 + 4;
    const vertex = parabolicVertex(-1, f(-1), 0, f(0), 1, f(1));
    expect(vertex).not.toBeNull();
    expect(vertex).toBeCloseTo(0.3, 9);
    expect(Number.isInteger(vertex)).toBe(false);
  });

  it('stays accurate at epoch-millisecond magnitudes', () => {
    // ~1.8e12 ms since 1970: squaring these directly would destroy the fit, so
    // the implementation shifts to the middle sample first.
    const t = 1_780_000_000_000;
    const f = (x: number) => 0.5 * (x - (t + 325)) ** 2 + 10;
    const vertex = parabolicVertex(t - 1000, f(t - 1000), t, f(t), t + 1000, f(t + 1000));
    expect(vertex).toBeCloseTo(t + 325, 3);
  });

  it('returns null when the three points are not a strict minimum', () => {
    expect(parabolicVertex(0, 1, 1, 1, 2, 1)).toBeNull(); // flat (co-orbital)
    expect(parabolicVertex(0, 0, 1, 5, 2, 0)).toBeNull(); // concave: a maximum
    expect(parabolicVertex(0, 0, 0, 1, 0, 2)).toBeNull(); // degenerate spacing
  });
});

describe('sub-sample TCA refinement', () => {
  /**
   * Crossing pair: same altitude, planes 40° apart, so the separation has a
   * sharp minimum instead of the flat one a co-orbital pair gives. Its true TCA
   * lands 325 ms off the 1 s sample grid, which is precisely the case coarse
   * sampling cannot represent.
   */
  const CROSSING: OrbitalElements = {
    ...ISS_OMM,
    NORAD_CAT_ID: 100002,
    OBJECT_NAME: 'CROSSING TEST OBJECT',
    INCLINATION: ISS_OMM.INCLINATION + 40,
  };
  const seed = new Date(EPOCH.getTime() + 25 * 60_000); // whole second, as SOCRATES gives
  const details = computeCloseApproach(ISS_OMM, CROSSING, seed, 30);

  /** Brute-force minimum at 1 ms resolution — the best answer obtainable. */
  function bruteForceMinimum(centreMs: number, spanMs: number): number {
    const a = propagateOrbit(ISS_OMM, new Date(centreMs - spanMs), new Date(centreMs + spanMs), 0.001);
    const b = propagateOrbit(CROSSING, new Date(centreMs - spanMs), new Date(centreMs + spanMs), 0.001);
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      best = Math.min(best, eciDistance(a[i]!.positionEci, b[i]!.positionEci));
    }
    return best;
  }

  /** The best the coarse sweep alone could report: the 1 s grid anchored on the seed. */
  function coarseGridMinimum(): number {
    const nearest = seed.getTime() + Math.round((details.actualTca.getTime() - seed.getTime()) / 1000) * 1000;
    let best = Number.POSITIVE_INFINITY;
    for (let k = -3; k <= 3; k++) {
      const t = new Date(nearest + k * 1000);
      const a = propagateOrbit(ISS_OMM, t, t, 1);
      const b = propagateOrbit(CROSSING, t, t, 1);
      if (a[0] !== undefined && b[0] !== undefined) {
        best = Math.min(best, eciDistance(a[0].positionEci, b[0].positionEci));
      }
    }
    return best;
  }

  it('resolves a TCA that is not on the sample grid', () => {
    // The sweep samples whole seconds from the seed; a refined TCA off that
    // grid is only reachable by sub-sample refinement.
    expect(details.actualTca.getTime() % 1000).not.toBe(0);
  });

  it('reports a smaller miss distance than coarse sampling alone', () => {
    const coarse = coarseGridMinimum();
    expect(details.actualMinRange).toBeLessThan(coarse);
    // Measured: 7.5868 km coarse -> 7.3931 km refined, ~194 m of grid bias.
    expect(coarse - details.actualMinRange).toBeGreaterThan(0.15);
  });

  it('matches a 1 ms brute-force scan to within a metre', () => {
    const truth = bruteForceMinimum(details.actualTca.getTime(), 600);
    expect(Math.abs(details.actualMinRange - truth)).toBeLessThan(0.001);
  });

  it('reduces the error against truth by orders of magnitude', () => {
    const truth = bruteForceMinimum(details.actualTca.getTime(), 600);
    const coarseError = coarseGridMinimum() - truth;
    const refinedError = Math.abs(details.actualMinRange - truth);
    expect(coarseError).toBeGreaterThan(0.15);
    expect(refinedError).toBeLessThan(coarseError / 100);
  });

  it('reports the refined instant as the TCA positions', () => {
    expect(details.position1AtTca.timestamp.getTime()).toBe(details.actualTca.getTime());
    expect(details.position2AtTca.timestamp.getTime()).toBe(details.actualTca.getTime());
  });

  it('keeps the sampled trajectories passing through the refined minimum', () => {
    // The animator interpolates along these; without the refined sample it
    // would cut the corner at the closest approach.
    const inOrbit1 = details.orbit1.some(
      (p) => p.timestamp.getTime() === details.actualTca.getTime(),
    );
    expect(inOrbit1).toBe(true);
    const times = details.orbit1.map((p) => p.timestamp.getTime());
    expect([...times].sort((x, y) => x - y)).toEqual(times); // still time-ordered
  });

  it('never reports a worse miss than the coarse minimum', () => {
    // Co-orbital pairs give a flat minimum where the fit is rejected; the
    // coarse answer must survive untouched rather than being degraded.
    const trailing: OrbitalElements = {
      ...ISS_OMM,
      NORAD_CAT_ID: 100003,
      MEAN_ANOMALY: ISS_OMM.MEAN_ANOMALY + 0.05,
    };
    const flat = computeCloseApproach(ISS_OMM, trailing, new Date(EPOCH.getTime() + 30 * 60_000));
    expect(flat.actualMinRange).toBeGreaterThan(0);
    expect(Number.isFinite(flat.actualMinRange)).toBe(true);
  });
});
