/**
 * CRITICAL: CelesTrak exhausts 5-digit NORAD catalog numbers (~69999) around
 * 2026-07-12. Objects with IDs >= 100000 exist only in OMM/JSON format — they
 * cannot be represented in TLE. This module must therefore always request
 * FORMAT=JSON, propagation must always go through satellite.json2satrec()
 * (never twoline2satrec()), and catalog numbers must never be padded,
 * truncated, or otherwise assumed to be 5 digits.
 */
import type { OrbitalElements } from './types.js';

export interface FetchOrbitalElementsOptions {
  /**
   * Origin to fetch from (default 'https://celestrak.org'). Pass '' in the
   * browser to go through a same-origin dev-server proxy.
   */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://celestrak.org';

/** Fetch current OMM orbital elements for one object from the CelesTrak GP API. */
export async function fetchOrbitalElements(
  noradCatId: number,
  options: FetchOrbitalElementsOptions = {},
): Promise<OrbitalElements> {
  const { baseUrl = DEFAULT_BASE_URL } = options;
  const url = `${baseUrl}/NORAD/elements/gp.php?CATNR=${noradCatId}&FORMAT=JSON`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `CelesTrak GP request for NORAD ${noradCatId} failed: ${response.status} ${response.statusText}`,
    );
  }
  // The GP API returns the literal string "No GP data found" (not JSON) for
  // unknown catalog numbers, so parse defensively.
  const body = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`No GP data found for NORAD ${noradCatId}: ${body.slice(0, 100)}`);
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No orbital elements returned for NORAD ${noradCatId}`);
  }
  const [first] = data as OrbitalElements[];
  if (first === undefined) {
    throw new Error(`No orbital elements returned for NORAD ${noradCatId}`);
  }
  return first;
}
