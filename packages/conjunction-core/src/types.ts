/** A predicted conjunction (close approach) between two orbiting objects. */
export interface ConjunctionEvent {
  noradId1: number;
  name1: string;
  noradId2: number;
  name2: string;
  /** Time of closest approach (UTC). */
  tca: Date;
  /** Predicted minimum range at TCA, in km. */
  minRange: number;
  /** Relative speed at TCA, in km/s. */
  relativeSpeed: number;
  /** Maximum collision probability (dimensionless). */
  maxProbability: number;
  /** Days since epoch of object 1's element set at TCA. */
  dse1: number;
  /** Days since epoch of object 2's element set at TCA. */
  dse2: number;
}

/** Orbital elements as returned by the CelesTrak GP API in OMM JSON format. */
export interface OrbitalElements {
  OBJECT_NAME: string;
  OBJECT_ID?: string;
  NORAD_CAT_ID: number;
  /** Element set epoch, ISO 8601 UTC (no trailing Z), e.g. "2026-06-01T12:00:00.000000". */
  EPOCH: string;
  /** Revolutions per day. */
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  /** Degrees. */
  INCLINATION: number;
  /** Right ascension of the ascending node, degrees. */
  RA_OF_ASC_NODE: number;
  /** Argument of pericenter, degrees. */
  ARG_OF_PERICENTER: number;
  /** Degrees. */
  MEAN_ANOMALY: number;
  /** Drag term, 1/earth-radii. */
  BSTAR: number;
  /** First derivative of mean motion, rev/day^2 (divided by 2 in TLE convention). */
  MEAN_MOTION_DOT: number;
  /** Second derivative of mean motion, rev/day^3 (divided by 6 in TLE convention). */
  MEAN_MOTION_DDOT: number;
  REV_AT_EPOCH: number;
  ELEMENT_SET_NO: number;
  CLASSIFICATION_TYPE: string;
  EPHEMERIS_TYPE: number;
}

/** A cartesian vector in the ECI (TEME) frame. Position in km, velocity in km/s. */
export interface EciVector {
  x: number;
  y: number;
  z: number;
}

/** State of an object at a single propagation step. */
export interface PropagatedPosition {
  timestamp: Date;
  /** Geodetic latitude, degrees (-90..90). */
  latitude: number;
  /** Geodetic longitude, degrees (-180..180). */
  longitude: number;
  /** Height above the WGS84 ellipsoid, km. */
  altitude: number;
  /** ECI position, km. */
  positionEci: EciVector;
  /** ECI velocity, km/s. */
  velocityEci: EciVector;
}

/** Result of refining a conjunction around its predicted TCA. */
export interface CloseApproachDetails {
  /** Minimum separation found in the sampled window, km. */
  actualMinRange: number;
  /** Time at which the minimum separation occurs. */
  actualTca: Date;
  /** Magnitude of the relative velocity at the actual TCA, km/s. */
  relativeVelocityAtTca: number;
  position1AtTca: PropagatedPosition;
  position2AtTca: PropagatedPosition;
  /** Sampled trajectory of object 1 across the whole window. */
  orbit1: PropagatedPosition[];
  /** Sampled trajectory of object 2 across the whole window. */
  orbit2: PropagatedPosition[];
}
