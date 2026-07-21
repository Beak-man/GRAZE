import { gstime } from 'satellite.js';
import type { EciVector, OrbitalElements, PropagatedPosition } from './types.js';

/** Standard gravitational parameter of Earth, km^3/s^2 (WGS-84). */
const MU_EARTH = 398600.4418;
/** Earth equatorial radius, km (WGS-84). */
const EARTH_EQUATORIAL_RADIUS_KM = 6378.137;
const SECONDS_PER_DAY = 86_400;
const MINUTES_PER_DAY = 1440;

/** Human-oriented orbit parameters derived from an element set. */
export interface OrbitSummary {
  inclinationDeg: number;
  /** Apogee height above the equatorial radius, km. */
  apogeeKm: number;
  /** Perigee height above the equatorial radius, km. */
  perigeeKm: number;
  periodMinutes: number;
}

/** Derive apogee/perigee/period from mean motion and eccentricity. */
export function summarizeOrbit(elements: OrbitalElements): OrbitSummary {
  const meanMotionRadS = (elements.MEAN_MOTION * 2 * Math.PI) / SECONDS_PER_DAY;
  const semiMajorAxisKm = Math.cbrt(MU_EARTH / (meanMotionRadS * meanMotionRadS));
  const e = elements.ECCENTRICITY;
  return {
    inclinationDeg: elements.INCLINATION,
    apogeeKm: semiMajorAxisKm * (1 + e) - EARTH_EQUATORIAL_RADIUS_KM,
    perigeeKm: semiMajorAxisKm * (1 - e) - EARTH_EQUATORIAL_RADIUS_KM,
    periodMinutes: MINUTES_PER_DAY / elements.MEAN_MOTION,
  };
}

export type OrbitRegime = 'LEO' | 'MEO' | 'GEO' | 'HEO';

/**
 * Classify an orbit regime from mean motion and eccentricity:
 * HEO (highly elliptical, e > 0.25) takes precedence, then by period —
 * LEO < 225 min, MEO 225–1400 min, GEO 1400–1500 min. The handful of
 * super-synchronous objects (> 1500 min) are lumped with GEO.
 */
export function classifyOrbitRegime(elements: OrbitalElements): OrbitRegime {
  if (elements.ECCENTRICITY > 0.25) {
    return 'HEO';
  }
  const periodMinutes = MINUTES_PER_DAY / elements.MEAN_MOTION;
  if (periodMinutes < 225) {
    return 'LEO';
  }
  if (periodMinutes <= 1400) {
    return 'MEO';
  }
  return 'GEO';
}

const DEG_TO_RAD = Math.PI / 180;
const MS_PER_DAY = 86_400_000;
/** J2000.0 epoch: 2000-01-01 12:00 TT (UTC is close enough at this accuracy). */
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

function wrapDegrees(degrees: number): number {
  return degrees - 360 * Math.floor(degrees / 360);
}

/**
 * Unit vector from Earth's center to the Sun in the ECI (equatorial) frame,
 * using the simplified solar position from Jean Meeus, "Astronomical
 * Algorithms" (accuracy ~0.01°).
 */
export function getSunDirectionEci(date: Date): EciVector {
  const daysSinceJ2000 = (date.getTime() - J2000_MS) / MS_PER_DAY;
  const meanLongitude = wrapDegrees(280.46 + 0.9856474 * daysSinceJ2000);
  const meanAnomaly = wrapDegrees(357.528 + 0.9856003 * daysSinceJ2000) * DEG_TO_RAD;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) *
    DEG_TO_RAD;
  const obliquity = (23.439 - 0.0000004 * daysSinceJ2000) * DEG_TO_RAD;
  return {
    x: Math.cos(eclipticLongitude),
    y: Math.cos(obliquity) * Math.sin(eclipticLongitude),
    z: Math.sin(obliquity) * Math.sin(eclipticLongitude),
  };
}

/**
 * Earth's rotation angle (Greenwich Mean Sidereal Time), radians, measured
 * from the ECI x-axis (vernal equinox) to the Greenwich meridian. Rotating an
 * Earth-fixed mesh by this angle about the ECI z-axis — scene +Y, per
 * eciToThreeJs — keeps it aligned with ECI-frame positions (satellites, Sun
 * direction) at any instant.
 */
export function getEarthRotationRadians(date: Date): number {
  return gstime(date);
}

/** Euclidean distance between two ECI positions, km. */
export function eciDistance(a: EciVector, b: EciVector): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** ECI state linearly interpolated between two propagation samples. */
export interface InterpolatedState {
  timestamp: Date;
  positionEci: EciVector;
  velocityEci: EciVector;
}

function lerpVector(a: EciVector, b: EciVector, t: number): EciVector {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function toState(point: PropagatedPosition): InterpolatedState {
  return {
    timestamp: point.timestamp,
    positionEci: point.positionEci,
    velocityEci: point.velocityEci,
  };
}

/**
 * Linearly interpolate an orbit's ECI state at an arbitrary time. Times
 * outside the sampled range clamp to the nearest end. Returns null for an
 * empty orbit. The samples are assumed to be sorted by timestamp, as
 * produced by propagateOrbit / computeCloseApproach.
 */
export function interpolateStateAt(
  orbit: PropagatedPosition[],
  time: Date,
): InterpolatedState | null {
  const first = orbit[0];
  const last = orbit[orbit.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  const targetMs = time.getTime();
  if (targetMs <= first.timestamp.getTime()) {
    return toState(first);
  }
  if (targetMs >= last.timestamp.getTime()) {
    return toState(last);
  }

  // Binary search for the last sample at or before the target time.
  let low = 0;
  let high = orbit.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    const midPoint = orbit[mid];
    if (midPoint === undefined || midPoint.timestamp.getTime() <= targetMs) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const before = orbit[low];
  const after = orbit[high];
  if (before === undefined || after === undefined) {
    return null;
  }
  const beforeMs = before.timestamp.getTime();
  const afterMs = after.timestamp.getTime();
  const t = afterMs === beforeMs ? 0 : (targetMs - beforeMs) / (afterMs - beforeMs);
  return {
    timestamp: new Date(targetMs),
    positionEci: lerpVector(before.positionEci, after.positionEci, t),
    velocityEci: lerpVector(before.velocityEci, after.velocityEci, t),
  };
}
