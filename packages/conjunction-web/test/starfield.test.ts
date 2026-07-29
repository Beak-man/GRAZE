import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eciToThreeJs } from 'conjunction-core';
import { buildStarPoints } from '../src/scene/starfield.js';

/**
 * Guards that starfield.ts actually *applies* the precession correction.
 *
 * The precession matrix itself is covered in conjunction-core, but every one of
 * those tests exercises the matrix in isolation — a refactor could drop the call
 * here and the whole core suite would stay green. This asserts the rendered
 * star directions really are rotated away from the raw catalogue directions.
 */

const CATALOG_PATH = path.join(import.meta.dirname, '..', 'public', 'stars.json');
/** Fixed so the expected displacements stay deterministic (they grow ~50"/yr). */
const EPOCH = new Date('2026-07-28T00:00:00Z');
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_ARCSEC = (180 * 3600) / Math.PI;

interface StarCatalog {
  metadata: { name: string }[];
  data: (number | null)[][];
}

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as StarCatalog;

function columnIndex(name: string): number {
  return catalog.metadata.findIndex((column) => column.name === name);
}

const vmagIndex = columnIndex('vmag');
const raIndex = columnIndex('ra');
const decIndex = columnIndex('dec');

/** Catalogue rows with usable coordinates, brightest first (vmag ascends). */
const stars = (
  catalog.data.filter((row) => {
    return (
      typeof row[vmagIndex] === 'number' &&
      typeof row[raIndex] === 'number' &&
      typeof row[decIndex] === 'number'
    );
  }) as number[][]
).sort((a, b) => (a[vmagIndex] ?? 0) - (b[vmagIndex] ?? 0));

/**
 * Raw (uncorrected) catalogue direction in scene axes, recomputed here from the
 * catalogue rather than hardcoded, so a catalogue refresh doesn't invalidate the
 * test. eciToThreeJs is a proper rotation, so angles are preserved by it.
 */
function rawSceneDirection(star: number[]): [number, number, number] {
  const ra = (star[raIndex] ?? 0) * DEG_TO_RAD;
  const dec = (star[decIndex] ?? 0) * DEG_TO_RAD;
  const v = eciToThreeJs({
    x: Math.cos(dec) * Math.cos(ra),
    y: Math.cos(dec) * Math.sin(ra),
    z: Math.sin(dec),
  });
  const length = Math.hypot(v.x, v.y, v.z);
  return [v.x / length, v.y / length, v.z / length];
}

/** Angular separation, arcseconds, between two unit vectors. */
function separationArcsec(a: readonly number[], b: readonly number[]): number {
  const dot = (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  return Math.acos(Math.min(1, Math.max(-1, dot))) * RAD_TO_ARCSEC;
}

describe('buildStarPoints precession', () => {
  const points = buildStarPoints(catalog, EPOCH);
  const positions = points.geometry.getAttribute('position');

  /** Rendered direction of the nth-brightest star, as a unit vector. */
  function renderedDirection(rank: number): [number, number, number] {
    const target = stars[rank];
    expect(target).toBeDefined();
    // buildStarPoints preserves catalogue order, so locate the row by identity.
    const index = (
      catalog.data.filter(
        (row) =>
          typeof row[vmagIndex] === 'number' &&
          typeof row[raIndex] === 'number' &&
          typeof row[decIndex] === 'number',
      ) as number[][]
    ).indexOf(target as number[]);
    expect(index).toBeGreaterThanOrEqual(0);
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length];
  }

  it('rotates Sirius by the precession accumulated since J2000', () => {
    const sirius = stars[0];
    expect(sirius).toBeDefined();
    // Sanity-check we picked the star we think we did before asserting on it.
    expect(sirius?.[vmagIndex]).toBeLessThan(-1);
    const moved = separationArcsec(renderedDirection(0), rawSceneDirection(sirius as number[]));
    // ~1029" for 2026-07-28. A dropped precession call gives 0".
    expect(moved).toBeGreaterThan(1010);
    expect(moved).toBeLessThan(1050);
  });

  it('rotates Canopus by its own (smaller) displacement', () => {
    // Canopus lies much nearer the precession axis than Sirius, so it moves far
    // less — checking a second, different magnitude catches a constant offset
    // being applied to everything instead of a real rotation.
    const canopus = stars[1];
    expect(canopus).toBeDefined();
    const moved = separationArcsec(renderedDirection(1), rawSceneDirection(canopus as number[]));
    // ~326" for 2026-07-28.
    expect(moved).toBeGreaterThan(310);
    expect(moved).toBeLessThan(345);
  });

  it('does not mutate the catalogue: rebuilding gives identical positions', () => {
    // The correction must rotate the emitted directions, not the source rows —
    // an in-place mutation would compound every time the starfield is rebuilt.
    const rebuilt = buildStarPoints(catalog, EPOCH).geometry.getAttribute('position');
    expect(rebuilt.count).toBe(positions.count);
    for (const index of [0, 1, 42, Math.floor(positions.count / 2), positions.count - 1]) {
      expect(rebuilt.getX(index)).toBeCloseTo(positions.getX(index), 9);
      expect(rebuilt.getY(index)).toBeCloseTo(positions.getY(index), 9);
      expect(rebuilt.getZ(index)).toBeCloseTo(positions.getZ(index), 9);
    }
  });
});
