import { describe, expect, it } from 'vitest';
import {
  applyMatrix3,
  julianCenturiesSinceJ2000,
  precessionAngles,
  precessionMatrixJ2000ToDate,
} from '../src/precession.js';
import type { Matrix3 } from '../src/precession.js';

const ARCSEC_TO_RAD = Math.PI / (180 * 3600);
const RAD_TO_ARCSEC = 1 / ARCSEC_TO_RAD;
const J2000 = new Date(Date.UTC(2000, 0, 1, 12, 0, 0));
const MS_PER_DAY = 86_400_000;

/** A date exactly `t` Julian centuries after J2000. */
function atCenturies(t: number): Date {
  return new Date(J2000.getTime() + t * 36_525 * MS_PER_DAY);
}

function transpose(m: Matrix3): Matrix3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

function determinant(m: Matrix3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

function column(m: Matrix3, index: number): [number, number, number] {
  return [m[index] ?? 0, m[index + 3] ?? 0, m[index + 6] ?? 0];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}

describe('precessionMatrixJ2000ToDate', () => {
  it('is the identity at T = 0', () => {
    const m = precessionMatrixJ2000ToDate(J2000);
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let i = 0; i < 9; i++) {
      expect(m[i]).toBeCloseTo(identity[i] ?? 0, 12);
    }
  });

  it('is a proper rotation: orthonormal with det = +1', () => {
    const m = precessionMatrixJ2000ToDate(atCenturies(0.266));
    // det = +1 rules out a handedness flip, which would mirror the sky.
    expect(determinant(m)).toBeCloseTo(1, 12);
    for (let i = 0; i < 3; i++) {
      expect(dot(column(m, i), column(m, i))).toBeCloseTo(1, 12);
      for (let j = i + 1; j < 3; j++) {
        expect(dot(column(m, i), column(m, j))).toBeCloseTo(0, 12);
      }
    }
  });

  it('moves the J2000 pole by theta_A (~533" at T = 0.266)', () => {
    const t = 0.266;
    const m = precessionMatrixJ2000ToDate(atCenturies(t));
    const pole = applyMatrix3(m, { x: 0, y: 0, z: 1 });
    // Angular separation from the J2000 pole is exactly theta_A.
    const separation = Math.acos(Math.min(1, Math.max(-1, pole.z))) * RAD_TO_ARCSEC;
    const { thetaA } = precessionAngles(t);
    expect(separation).toBeCloseTo(thetaA * RAD_TO_ARCSEC, 6);
    expect(separation).toBeGreaterThan(532);
    expect(separation).toBeLessThan(534);
  });

  it('round-trips: transpose(R) * R * v === v', () => {
    const m = precessionMatrixJ2000ToDate(atCenturies(0.266));
    const mt = transpose(m);
    const vectors = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0.5773502692, y: 0.5773502692, z: 0.5773502692 },
      { x: -0.2672612419, y: 0.5345224838, z: -0.8017837257 },
    ];
    for (const v of vectors) {
      const back = applyMatrix3(mt, applyMatrix3(m, v));
      expect(back.x).toBeCloseTo(v.x, 12);
      expect(back.y).toBeCloseTo(v.y, 12);
      expect(back.z).toBeCloseTo(v.z, 12);
    }
  });

  it('agrees with Meeus’s explicit RA/Dec precession formulas', () => {
    // The four tests above are all satisfied by a matrix built with the wrong
    // rotation-sign convention (frame vs vector), because they only constrain
    // orthonormality and the polar angle. This one pins the convention: Meeus,
    // "Astronomical Algorithms" ch. 21, gives the equatorial reduction
    // independently of any matrix formulation.
    const t = 0.266;
    const { zetaA, zA, thetaA } = precessionAngles(t);
    const m = precessionMatrixJ2000ToDate(atCenturies(t));

    // A few well-separated directions, including one near the pole.
    const stars = [
      { ra: 45, dec: 20 },
      { ra: 200, dec: -35 },
      { ra: 310, dec: 70 },
      { ra: 5, dec: -80 },
    ];
    for (const { ra, dec } of stars) {
      const a0 = (ra * Math.PI) / 180;
      const d0 = (dec * Math.PI) / 180;

      const A = Math.cos(d0) * Math.sin(a0 + zetaA);
      const B =
        Math.cos(thetaA) * Math.cos(d0) * Math.cos(a0 + zetaA) - Math.sin(thetaA) * Math.sin(d0);
      const C =
        Math.sin(thetaA) * Math.cos(d0) * Math.cos(a0 + zetaA) + Math.cos(thetaA) * Math.sin(d0);
      const expectedRa = Math.atan2(A, B) + zA;
      const expectedDec = Math.asin(C);

      const rotated = applyMatrix3(m, {
        x: Math.cos(d0) * Math.cos(a0),
        y: Math.cos(d0) * Math.sin(a0),
        z: Math.sin(d0),
      });
      const actualRa = Math.atan2(rotated.y, rotated.x);
      const actualDec = Math.asin(Math.min(1, Math.max(-1, rotated.z)));

      // Compare RA as a wrapped difference so the 0/2pi seam cannot fail it.
      const raDelta = Math.atan2(
        Math.sin(actualRa - expectedRa),
        Math.cos(actualRa - expectedRa),
      );
      expect(Math.abs(raDelta) * RAD_TO_ARCSEC).toBeLessThan(0.001);
      expect(Math.abs(actualDec - expectedDec) * RAD_TO_ARCSEC).toBeLessThan(0.001);
    }
  });

  it('accumulates the expected ~1337" net rotation for epoch 2026', () => {
    // Sanity-check the magnitude that motivated this correction.
    const t = julianCenturiesSinceJ2000(new Date('2026-07-28T00:00:00Z'));
    expect(t).toBeCloseTo(0.2657, 3);
    const { zetaA, zA, thetaA } = precessionAngles(t);
    const net =
      Math.hypot((zetaA + zA) * RAD_TO_ARCSEC, thetaA * RAD_TO_ARCSEC);
    expect(net).toBeGreaterThan(1300);
    expect(net).toBeLessThan(1370);
    // ~0.371 deg, i.e. several pixels at the scene's 45 deg FOV.
    expect((net / 3600)).toBeCloseTo(0.371, 2);
  });
});
