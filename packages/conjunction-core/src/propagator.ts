import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  jday,
  json2satrec,
  sgp4,
} from 'satellite.js';
import type { OMMJsonObject, PositionAndVelocity, SatRec } from 'satellite.js';
import { eciDistance, getEarthRotationRadians } from './analysis.js';
import type {
  CloseApproachDetails,
  EciVector,
  OrbitalElements,
  PropagatedPosition,
} from './types.js';

/** Scene scale: 1 Three.js unit = 1000 km, so Earth's radius is ≈ 6.371 units. */
const KM_PER_SCENE_UNIT = 1000;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MINUTES_PER_DAY = 1440;

/** Fine sampling (1 s) is used within ±2 minutes of the predicted TCA. */
const FINE_WINDOW_MS = 2 * MS_PER_MINUTE;
const FINE_STEP_MS = 1 * MS_PER_SECOND;
const COARSE_STEP_MS = 10 * MS_PER_SECOND;

/**
 * Adapt our OrbitalElements to the OMM JSON shape satellite.js expects:
 * it requires OBJECT_ID and narrows EPHEMERIS_TYPE / CLASSIFICATION_TYPE to
 * literal types.
 */
function toSatrec(elements: OrbitalElements): SatRec {
  const omm: OMMJsonObject = {
    OBJECT_NAME: elements.OBJECT_NAME,
    OBJECT_ID: elements.OBJECT_ID ?? 'UNKNOWN',
    EPOCH: elements.EPOCH,
    MEAN_MOTION: elements.MEAN_MOTION,
    ECCENTRICITY: elements.ECCENTRICITY,
    INCLINATION: elements.INCLINATION,
    RA_OF_ASC_NODE: elements.RA_OF_ASC_NODE,
    ARG_OF_PERICENTER: elements.ARG_OF_PERICENTER,
    MEAN_ANOMALY: elements.MEAN_ANOMALY,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: elements.CLASSIFICATION_TYPE === 'C' ? 'C' : 'U',
    NORAD_CAT_ID: elements.NORAD_CAT_ID,
    ELEMENT_SET_NO: elements.ELEMENT_SET_NO,
    REV_AT_EPOCH: elements.REV_AT_EPOCH,
    BSTAR: elements.BSTAR,
    MEAN_MOTION_DOT: elements.MEAN_MOTION_DOT,
    MEAN_MOTION_DDOT: elements.MEAN_MOTION_DDOT,
  };
  return json2satrec(omm);
}

/**
 * Minutes since the satrec epoch for a float millisecond time — SGP4's own
 * independent variable, evaluated continuously.
 *
 * Anchored on `jday` for the whole-millisecond part so that this is *bit
 * identical* to what satellite.js `propagate(satrec, date)` computes (verified:
 * zero difference), then the sub-millisecond remainder is added directly in
 * minutes. Adding it separately is what preserves precision: the remainder is
 * < 1 ms, so it keeps full double resolution instead of being lost in the ~2.46e6
 * magnitude of an absolute Julian date, where one ULP is already ~40 us.
 *
 * Resolution measured end to end: ~1 us, i.e. ~7 mm of orbital motion. Below
 * that the double runs out, not the method.
 */
function tsinceMinutes(satrec: SatRec, epochMs: number): number {
  const wholeMs = Math.floor(epochMs);
  const fractionMs = epochMs - wholeMs;
  return (
    (jday(new Date(wholeMs)) - satrec.jdsatepoch) * MINUTES_PER_DAY + fractionMs / MS_PER_MINUTE
  );
}

/** Julian date for a float millisecond time, for the sidereal-time lookup. */
function julianDateOf(epochMs: number): number {
  const wholeMs = Math.floor(epochMs);
  return jday(new Date(wholeMs)) + (epochMs - wholeMs) / MS_PER_DAY;
}

/**
 * Propagate one object at an exact instant, expressed as float milliseconds
 * since the Unix epoch. Returns null when SGP4 fails (e.g. decayed object or
 * epoch too far away).
 *
 * This is the single propagation path: `propagateAt` is a Date-shaped wrapper
 * over it. Calling sgp4() directly rather than propagate() is deliberate —
 * propagate() takes a Date and so cannot express a sub-millisecond time, which
 * is exactly the resolution the TCA refinement needs.
 */
function propagateAtEpochMs(satrec: SatRec, epochMs: number): PropagatedPosition | null {
  let result: PositionAndVelocity | null | undefined;
  try {
    result = sgp4(satrec, tsinceMinutes(satrec, epochMs));
  } catch {
    return null;
  }
  if (
    result === null ||
    result === undefined ||
    typeof result.position === 'boolean' ||
    typeof result.velocity === 'boolean'
  ) {
    return null;
  }
  const { position, velocity } = result;
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
    return null;
  }
  const gmst = gstime(julianDateOf(epochMs));
  const geodetic = eciToGeodetic(position, gmst);
  return {
    // Date cannot hold the sub-millisecond part; epochMs below is authoritative.
    timestamp: new Date(Math.round(epochMs)),
    epochMs,
    latitude: degreesLat(geodetic.latitude),
    longitude: degreesLong(geodetic.longitude),
    altitude: geodetic.height,
    positionEci: { x: position.x, y: position.y, z: position.z },
    velocityEci: { x: velocity.x, y: velocity.y, z: velocity.z },
  };
}

/** Propagate at a Date instant (whole milliseconds). */
function propagateAt(satrec: SatRec, time: Date): PropagatedPosition | null {
  return propagateAtEpochMs(satrec, time.getTime());
}

/**
 * Propagate an object from startTime to endTime (inclusive) at fixed steps.
 * Steps where SGP4 fails are skipped, so the result may have fewer points
 * than requested.
 */
export function propagateOrbit(
  elements: OrbitalElements,
  startTime: Date,
  endTime: Date,
  stepSeconds = 30,
): PropagatedPosition[] {
  if (stepSeconds <= 0) {
    throw new Error(`stepSeconds must be positive, got ${stepSeconds}`);
  }
  const satrec = toSatrec(elements);
  const stepMs = stepSeconds * MS_PER_SECOND;
  const positions: PropagatedPosition[] = [];
  for (let t = startTime.getTime(); t <= endTime.getTime(); t += stepMs) {
    const point = propagateAt(satrec, new Date(t));
    if (point !== null) {
      positions.push(point);
    }
  }
  return positions;
}

/** Sample times across ±window around TCA: 1 s steps near TCA, 10 s outside. */
function buildSampleTimes(tca: Date, windowMinutes: number): number[] {
  const tcaMs = tca.getTime();
  const halfMs = windowMinutes * MS_PER_MINUTE;
  const fineMs = Math.min(FINE_WINDOW_MS, halfMs);
  const times: number[] = [];
  for (let t = tcaMs - halfMs; t < tcaMs - fineMs; t += COARSE_STEP_MS) {
    times.push(t);
  }
  for (let t = tcaMs - fineMs; t <= tcaMs + fineMs; t += FINE_STEP_MS) {
    times.push(t);
  }
  for (let t = tcaMs + fineMs + COARSE_STEP_MS; t <= tcaMs + halfMs; t += COARSE_STEP_MS) {
    times.push(t);
  }
  return times;
}

/**
 * Insert a sample into an already time-sorted trajectory, keeping it sorted.
 *
 * Ordered on `epochMs`, NOT on `timestamp`: the refined TCA carries a
 * sub-millisecond time, and two points can round to the same Date while being
 * genuinely ordered. Comparing Dates here would make the sort depend on
 * rounding.
 */
function insertByEpochMs(orbit: PropagatedPosition[], point: PropagatedPosition): void {
  let low = 0;
  let high = orbit.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((orbit[mid]?.epochMs ?? Number.NEGATIVE_INFINITY) <= point.epochMs) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  orbit.splice(low, 0, point);
}

/**
 * Vertex of the parabola through three points, or null when they do not
 * describe a minimum.
 *
 * Used on SQUARED distances, not distances. Near a close approach the relative
 * motion is locally linear, so
 *     d(t)² = d_min² + |v_rel|² (t - t*)²
 * is exactly a parabola in t, while d(t) itself is a hyperbola. Fitting d²
 * therefore recovers t* exactly for linear relative motion instead of
 * approximately.
 *
 * The general (unequal-spacing) form is used because the sample grid changes
 * step size at the fine/coarse boundary, so the minimum can land next to
 * neighbours that are not equally spaced.
 *
 * Returns null when the fit is not a strict minimum (a >= 0 means flat or
 * concave — a co-orbital pair with a nearly constant separation lands here),
 * leaving the caller to keep the coarse sample.
 */
export function parabolicVertex(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number | null {
  // Shift to the middle sample before squaring: absolute epoch milliseconds are
  // ~1.8e12, and squaring those loses most of the mantissa to cancellation.
  const a0 = x0 - x1;
  const a2 = x2 - x1;
  const denominator = a0 * a2 * (a0 - a2);
  if (denominator === 0 || !Number.isFinite(denominator)) {
    return null;
  }
  // Quadratic coefficients of y = A·u² + B·u + y1, with u = x - x1.
  const A = (a2 * (y0 - y1) - a0 * (y2 - y1)) / denominator;
  const B = (a0 * a0 * (y2 - y1) - a2 * a2 * (y0 - y1)) / denominator;
  if (!Number.isFinite(A) || !Number.isFinite(B) || A <= 0) {
    return null; // not a strict minimum
  }
  const vertex = x1 - B / (2 * A);
  return Number.isFinite(vertex) ? vertex : null;
}

/**
 * Refine a predicted conjunction: propagate both objects across
 * ±windowMinutes (default 30) around the predicted TCA and locate the actual
 * minimum-separation point.
 *
 * The coarse sweep alone reports the best *grid sample*, which biases the miss
 * distance high by up to half a step of relative motion — at a 1 s fine step
 * and ~15 km/s LEO closing speed that is ~7.5 km. A parabolic sub-sample
 * refinement follows the sweep and re-propagates at the recovered instant.
 */
export function computeCloseApproach(
  elements1: OrbitalElements,
  elements2: OrbitalElements,
  tca: Date,
  windowMinutes = 30,
): CloseApproachDetails {
  if (windowMinutes <= 0) {
    throw new Error(`windowMinutes must be positive, got ${windowMinutes}`);
  }
  const satrec1 = toSatrec(elements1);
  const satrec2 = toSatrec(elements2);

  const orbit1: PropagatedPosition[] = [];
  const orbit2: PropagatedPosition[] = [];
  /** Every sample where BOTH objects propagated, in time order. */
  const paired: { timeMs: number; range: number; point1: PropagatedPosition; point2: PropagatedPosition }[] =
    [];
  let bestIndex = -1;

  for (const timeMs of buildSampleTimes(tca, windowMinutes)) {
    const time = new Date(timeMs);
    const point1 = propagateAt(satrec1, time);
    const point2 = propagateAt(satrec2, time);
    if (point1 !== null) {
      orbit1.push(point1);
    }
    if (point2 !== null) {
      orbit2.push(point2);
    }
    if (point1 !== null && point2 !== null) {
      const range = eciDistance(point1.positionEci, point2.positionEci);
      if (bestIndex === -1 || range < (paired[bestIndex]?.range ?? Infinity)) {
        bestIndex = paired.length;
      }
      paired.push({ timeMs, range, point1, point2 });
    }
  }

  const coarse = bestIndex === -1 ? null : paired[bestIndex];
  if (coarse === undefined || coarse === null) {
    throw new Error(
      `Propagation failed for NORAD ${elements1.NORAD_CAT_ID} / ${elements2.NORAD_CAT_ID} across the entire window around ${tca.toISOString()}`,
    );
  }

  let best: { range: number; point1: PropagatedPosition; point2: PropagatedPosition } = coarse;

  /*
   * Sub-sample refinement. The coarse minimum is bracketed by its immediate
   * neighbours; fitting a parabola to the three SQUARED distances gives the
   * vertex time analytically. Skipped at the window edges (no bracket) and when
   * the fit is not a strict minimum.
   */
  const before = paired[bestIndex - 1];
  const after = paired[bestIndex + 1];
  if (before !== undefined && after !== undefined) {
    const vertexMs = parabolicVertex(
      before.timeMs,
      before.range * before.range,
      coarse.timeMs,
      coarse.range * coarse.range,
      after.timeMs,
      after.range * after.range,
    );
    if (vertexMs !== null && vertexMs > before.timeMs && vertexMs < after.timeMs) {
      /*
       * Evaluated at the exact float instant — no rounding to the millisecond
       * grid. propagateAtEpochMs drives SGP4 through its own continuous
       * variable (minutes since epoch), so the only floor is double precision:
       * ~1 us, about 7 mm of orbital motion.
       */
      const refined1 = propagateAtEpochMs(satrec1, vertexMs);
      const refined2 = propagateAtEpochMs(satrec2, vertexMs);
      if (refined1 !== null && refined2 !== null) {
        const refinedRange = eciDistance(refined1.positionEci, refined2.positionEci);
        // Never regress: a pathological fit must not worsen the reported miss.
        if (refinedRange < best.range) {
          best = { range: refinedRange, point1: refined1, point2: refined2 };
          // Keep the sampled trajectories passing through the true minimum, so
          // the animator interpolates across it instead of cutting the corner.
          insertByEpochMs(orbit1, refined1);
          insertByEpochMs(orbit2, refined2);
        }
      }
    }
  }

  const relativeVelocity: EciVector = {
    x: best.point1.velocityEci.x - best.point2.velocityEci.x,
    y: best.point1.velocityEci.y - best.point2.velocityEci.y,
    z: best.point1.velocityEci.z - best.point2.velocityEci.z,
  };

  return {
    actualMinRange: best.range,
    actualTca: best.point1.timestamp,
    actualTcaEpochMs: best.point1.epochMs,
    relativeVelocityAtTca: Math.sqrt(
      relativeVelocity.x ** 2 + relativeVelocity.y ** 2 + relativeVelocity.z ** 2,
    ),
    position1AtTca: best.point1,
    position2AtTca: best.point2,
    orbit1,
    orbit2,
  };
}

/**
 * Map an ECI position (km) into Three.js scene space.
 *
 * Scale: 1 scene unit = 1000 km (Earth radius ≈ 6.371 units).
 * Axes: ECI is right-handed z-up; Three.js is right-handed y-up, so
 * (x, y, z) → (x, z, -y), putting Earth's rotation axis along scene +Y.
 */
export function eciToThreeJs(positionEci: EciVector): EciVector {
  return {
    x: positionEci.x / KM_PER_SCENE_UNIT,
    y: positionEci.z / KM_PER_SCENE_UNIT,
    z: -positionEci.y / KM_PER_SCENE_UNIT,
  };
}

/** Geographic point directly beneath a satellite (geocentric latitude). */
export interface SubSatellitePoint {
  /** Geocentric latitude, degrees (-90..90). Differs from geodetic by ≤ ~0.2°. */
  latitude: number;
  /** Longitude, degrees (-180..180). Identical to geodetic longitude. */
  longitude: number;
}

/**
 * Geographic point under a satellite, derived by *inverting the render
 * transform* rather than by the usual geodetic conversion.
 *
 * The scene is ECI-aligned and the globe mesh is spun by
 * `getEarthRotationRadians(date)` about scene +Y (see the Earth mesh setup in
 * conjunction-web/src/scene/earth.ts). So undoing that spin on a satellite's
 * scene position yields its position in the mesh's own (Earth-fixed) frame,
 * where — verified against satellite.js geodeticToEcf/ecfToEci — mesh-local
 * +X is longitude 0, -Z is longitude 90°E, and +Y is north.
 *
 * This exists as an independent second path to the same answer: propagateOrbit
 * reports latitude/longitude via satellite.js `eciToGeodetic`, and the unit
 * tests assert the two agree. That cross-check is what proves a satellite is
 * drawn over the ground track it actually flies, and it fails loudly if the
 * axis mapping, the rotation direction, or the GMST offset ever regress.
 */
export function subSatellitePoint(positionEci: EciVector, date: Date): SubSatellitePoint {
  const scene = eciToThreeJs(positionEci);
  const theta = getEarthRotationRadians(date);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // Ry(-theta) applied to the scene position.
  const xLocal = scene.x * cos - scene.z * sin;
  const zLocal = scene.x * sin + scene.z * cos;
  const yLocal = scene.y;
  const radius = Math.hypot(xLocal, yLocal, zLocal);
  return {
    latitude: radius === 0 ? 0 : (Math.asin(yLocal / radius) * 180) / Math.PI,
    longitude: (Math.atan2(-zLocal, xLocal) * 180) / Math.PI,
  };
}
