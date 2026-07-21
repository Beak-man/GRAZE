import { describe, expect, it } from 'vitest';
import { computeCloseApproach, eciToThreeJs, propagateOrbit } from '../src/propagator.js';
import type { OrbitalElements } from '../src/types.js';

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
