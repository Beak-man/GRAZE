/**
 * IAU 1976 (Lieske et al. 1977) precession of the equator: the rotation from
 * the J2000 mean equator and equinox to the mean equator and equinox of date.
 *
 * Why GRAZE needs it: the Hipparcos star catalogue is expressed in ICRS, which
 * is aligned to the J2000 mean equator and equinox to within ~25 mas, while
 * SGP4 emits TEME — referred to the *mean equinox of date*. Plotting catalogue
 * directions unprecessed leaves the starfield rotated by the accumulated
 * precession: ~1337" ≈ 0.371° for epoch 2026, which is several pixels at the
 * scene's 45° field of view.
 *
 * Deliberately omitted:
 *  - **Nutation.** The short-period wobble of the true equator about the mean
 *    equator, ≤ ~17.2" in longitude ≈ 0.005° ≈ 0.1 px here. TEME is referred to
 *    a mean equinox, so mean-of-date is in fact the frame we want.
 *  - **Equation of the equinoxes.** Only relates mean to *apparent* sidereal
 *    time; not applicable to a mean-equinox frame like TEME.
 *  - **Proper motion.** A separate effect governed by the catalogue's J1991.25
 *    observation epoch, not by the frame equinox. Under ~100 mas/yr for bright
 *    stars, so ~3" over three decades — two orders of magnitude below the
 *    precession this module corrects.
 */
import type { EciVector } from './types.js';

/** Row-major 3x3 matrix: [m00, m01, m02, m10, m11, m12, m20, m21, m22]. */
export type Matrix3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const ARCSEC_TO_RAD = Math.PI / (180 * 3600);
const MS_PER_DAY = 86_400_000;
const DAYS_PER_JULIAN_CENTURY = 36_525;
/** J2000.0: 2000-01-01 12:00 TT (UTC is close enough at this accuracy). */
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** Julian centuries of TT elapsed since J2000.0. */
export function julianCenturiesSinceJ2000(date: Date): number {
  return (date.getTime() - J2000_MS) / (MS_PER_DAY * DAYS_PER_JULIAN_CENTURY);
}

/**
 * The three equatorial precession angles, radians, from the full IAU 1976
 * polynomials (Lieske et al. 1977) including the T² and T³ terms.
 */
export interface PrecessionAngles {
  zetaA: number;
  zA: number;
  thetaA: number;
}

export function precessionAngles(centuriesSinceJ2000: number): PrecessionAngles {
  const t = centuriesSinceJ2000;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    zetaA: (2306.2181 * t + 0.30188 * t2 + 0.017998 * t3) * ARCSEC_TO_RAD,
    zA: (2306.2181 * t + 1.09468 * t2 + 0.018203 * t3) * ARCSEC_TO_RAD,
    thetaA: (2004.3109 * t - 0.42665 * t2 - 0.041833 * t3) * ARCSEC_TO_RAD,
  };
}

/*
 * ROT2/ROT3 below are *frame* rotations (the astronomical convention used by
 * Vallado and the Explanatory Supplement), i.e. the transpose of the more
 * common vector-rotation matrices. Writing them this way lets the composition
 * below read exactly like the textbook formula
 *     P = ROT3(-z_A) · ROT2(theta_A) · ROT3(-zeta_A)
 * instead of silently flipping signs. The convention is pinned by a test that
 * cross-checks the result against Meeus's explicit RA/Dec precession formulas.
 */
function rot2(angle: number): Matrix3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, -s, 0, 1, 0, s, 0, c];
}

function rot3(angle: number): Matrix3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Array<number>(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += (a[row * 3 + k] ?? 0) * (b[k * 3 + col] ?? 0);
      }
      out[row * 3 + col] = sum;
    }
  }
  return out as unknown as Matrix3;
}

/**
 * Rotation from the J2000 mean equator/equinox to the mean equator/equinox of
 * `date`. Apply to a J2000 (≈ ICRS) direction to obtain its mean-of-date
 * direction, which is the frame SGP4's TEME output is referred to.
 */
export function precessionMatrixJ2000ToDate(date: Date): Matrix3 {
  const { zetaA, zA, thetaA } = precessionAngles(julianCenturiesSinceJ2000(date));
  return multiply(rot3(-zA), multiply(rot2(thetaA), rot3(-zetaA)));
}

/** Multiply a row-major 3x3 matrix by an ECI vector. */
export function applyMatrix3(m: Matrix3, v: EciVector): EciVector {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}
