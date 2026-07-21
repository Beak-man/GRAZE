import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
} from 'satellite.js';
import type { OMMJsonObject, PositionAndVelocity, SatRec } from 'satellite.js';
import { eciDistance } from './analysis.js';
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
 * Propagate one object at a single instant. Returns null when SGP4 fails
 * (e.g. decayed object or epoch too far away).
 */
function propagateAt(satrec: SatRec, time: Date): PropagatedPosition | null {
  // The named export is typed as always returning, but the implementation can
  // return null (and older versions returned boolean false) on SGP4 failure.
  let result: PositionAndVelocity | null | undefined;
  try {
    result = propagate(satrec, time);
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
  const gmst = gstime(time);
  const geodetic = eciToGeodetic(position, gmst);
  return {
    timestamp: new Date(time.getTime()),
    latitude: degreesLat(geodetic.latitude),
    longitude: degreesLong(geodetic.longitude),
    altitude: geodetic.height,
    positionEci: { x: position.x, y: position.y, z: position.z },
    velocityEci: { x: velocity.x, y: velocity.y, z: velocity.z },
  };
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
 * Refine a predicted conjunction: propagate both objects across
 * ±windowMinutes (default 30) around the predicted TCA and locate the actual
 * minimum-separation point.
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
  let best: { range: number; point1: PropagatedPosition; point2: PropagatedPosition } | null = null;

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
      if (best === null || range < best.range) {
        best = { range, point1, point2 };
      }
    }
  }

  if (best === null) {
    throw new Error(
      `Propagation failed for NORAD ${elements1.NORAD_CAT_ID} / ${elements2.NORAD_CAT_ID} across the entire window around ${tca.toISOString()}`,
    );
  }

  const relativeVelocity: EciVector = {
    x: best.point1.velocityEci.x - best.point2.velocityEci.x,
    y: best.point1.velocityEci.y - best.point2.velocityEci.y,
    z: best.point1.velocityEci.z - best.point2.velocityEci.z,
  };

  return {
    actualMinRange: best.range,
    actualTca: best.point1.timestamp,
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
