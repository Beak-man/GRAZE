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

/**
 * The fields SGP4 actually propagates from. Identity and bookkeeping fields
 * (NORAD_CAT_ID, OBJECT_NAME, OBJECT_ID, REV_AT_EPOCH, ELEMENT_SET_NO) are
 * excluded because they do not influence the trajectory.
 */
const SGP4_FIELDS = [
  'EPOCH',
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'BSTAR',
  'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT',
] as const satisfies readonly (keyof OrbitalElements)[];

/**
 * True when two element sets describe the same orbit solution, so SGP4 will
 * propagate them to identical positions at every instant.
 *
 * This happens upstream: CelesTrak's public GP endpoint sometimes publishes one
 * shared solution for several pieces of a recent launch that have not been
 * individually resolved yet (e.g. 2026-024A and 2026-024H). A conjunction
 * between two such objects computes to exactly 0 m separation at 0 km/s, which
 * would otherwise render as a single track with a meaningless "0 km" readout —
 * so callers should detect this and explain it rather than display it.
 *
 * Note SOCRATES itself may report a real, non-zero miss for the same pair; its
 * screening uses better-resolved orbits than the public GP API exposes.
 */
export function sharesOrbitSolution(a: OrbitalElements, b: OrbitalElements): boolean {
  return SGP4_FIELDS.every((field) => a[field] === b[field]);
}

export type OrbitRegime = 'LEO' | 'MEO' | 'GEO' | 'HEO';

/**
 * Orbit-regime boundaries, in one place because two callers need them: element
 * sets (mean motion + eccentricity, from GP) and catalogue rows (period +
 * apogee/perigee, from SATCAT). These are GRAZE's own conventions, chosen to
 * match how the regimes are commonly described rather than any single standard:
 *
 *   HEO  eccentricity > 0.25          (highly elliptical takes precedence)
 *   LEO  period < 225 min
 *   MEO  225 min <= period <= 1400 min
 *   GEO  period > 1400 min            (super-synchronous lumped in with GEO)
 *
 * The GEO floor sits below the true geosynchronous period (~1436 min) so that
 * near-GEO drift orbits classify as GEO rather than MEO.
 */
export const REGIME_MAX_ECCENTRICITY_NON_HEO = 0.25;
export const REGIME_LEO_MAX_PERIOD_MIN = 225;
export const REGIME_MEO_MAX_PERIOD_MIN = 1400;

/** Earth equatorial radius, km (WGS-84) — for apogee/perigee to eccentricity. */
const EARTH_RADIUS_KM = EARTH_EQUATORIAL_RADIUS_KM;

/**
 * The single decision shared by both classification entry points. Period in
 * minutes, eccentricity dimensionless.
 */
export function regimeFromPeriodAndEccentricity(
  periodMinutes: number,
  eccentricity: number,
): OrbitRegime {
  if (eccentricity > REGIME_MAX_ECCENTRICITY_NON_HEO) {
    return 'HEO';
  }
  if (periodMinutes < REGIME_LEO_MAX_PERIOD_MIN) {
    return 'LEO';
  }
  if (periodMinutes <= REGIME_MEO_MAX_PERIOD_MIN) {
    return 'MEO';
  }
  return 'GEO';
}

/**
 * Classify an orbit regime from an element set (mean motion + eccentricity).
 */
export function classifyOrbitRegime(elements: OrbitalElements): OrbitRegime {
  return regimeFromPeriodAndEccentricity(
    MINUTES_PER_DAY / elements.MEAN_MOTION,
    elements.ECCENTRICITY,
  );
}

/**
 * Classify from a catalogue row (CelesTrak SATCAT: PERIOD, APOGEE, PERIGEE).
 * Eccentricity is derived from the apsides:
 *   e = (ra - rp) / (ra + rp),  r = altitude + Earth radius
 * Returns null when any input is missing or non-finite, so callers can record
 * an explicit "unknown" rather than defaulting silently.
 */
export function classifyOrbitRegimeFromCatalog(row: {
  periodMinutes: number;
  apogeeKm: number;
  perigeeKm: number;
}): OrbitRegime | null {
  const { periodMinutes, apogeeKm, perigeeKm } = row;
  if (
    !Number.isFinite(periodMinutes) ||
    !Number.isFinite(apogeeKm) ||
    !Number.isFinite(perigeeKm) ||
    periodMinutes <= 0
  ) {
    return null;
  }
  const ra = apogeeKm + EARTH_RADIUS_KM;
  const rp = perigeeKm + EARTH_RADIUS_KM;
  if (ra + rp <= 0) {
    return null;
  }
  return regimeFromPeriodAndEccentricity(periodMinutes, (ra - rp) / (ra + rp));
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
 *
 * FRAME: mean equinox **of date**, not J2000 — the mean-longitude rate below
 * is 360°/tropical year, i.e. referred to the moving equinox, and the obliquity
 * is of date. That already matches TEME, so do NOT apply
 * precessionMatrixJ2000ToDate to this vector: it is not a J2000 quantity, and
 * double-correcting would swing the terminator by ~0.371° (~41 km at the
 * equator). Precession applies to the star catalogue, which *is* J2000.
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
 * empty orbit. The samples are assumed to be sorted by time, as produced by
 * propagateOrbit / computeCloseApproach.
 *
 * Ordering and weighting use `epochMs`, not `timestamp`: computeCloseApproach
 * splices a sub-millisecond refined TCA sample into the trajectory, and a Date
 * cannot represent it. Comparing Dates would collapse that sample onto its
 * neighbour and produce a zero-width interval.
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
  if (targetMs <= first.epochMs) {
    return toState(first);
  }
  if (targetMs >= last.epochMs) {
    return toState(last);
  }

  // Binary search for the last sample at or before the target time.
  let low = 0;
  let high = orbit.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    const midPoint = orbit[mid];
    if (midPoint === undefined || midPoint.epochMs <= targetMs) {
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
  const beforeMs = before.epochMs;
  const afterMs = after.epochMs;
  const t = afterMs === beforeMs ? 0 : (targetMs - beforeMs) / (afterMs - beforeMs);
  return {
    timestamp: new Date(targetMs),
    positionEci: lerpVector(before.positionEci, after.positionEci, t),
    velocityEci: lerpVector(before.velocityEci, after.velocityEci, t),
  };
}
