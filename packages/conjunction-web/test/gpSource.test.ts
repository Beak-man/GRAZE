import { describe, expect, it, vi } from 'vitest';
import {
  BAKED_GP_URL,
  GpFileMissingError,
  GpUnavailableError,
  elementsFor,
  loadBakedGp,
  parseBakedGp,
} from '../src/data/gpSource.js';
import type { BakedGp } from '../src/data/gpSource.js';

const RECORD = {
  OBJECT_NAME: 'ISS (ZARYA)',
  OBJECT_ID: '1998-067A',
  NORAD_CAT_ID: 25544,
  EPOCH: '2026-07-29T01:00:00',
  MEAN_MOTION: 15.5,
  ECCENTRICITY: 0.0004,
  INCLINATION: 51.64,
  RA_OF_ASC_NODE: 100.1,
  ARG_OF_PERICENTER: 90.2,
  MEAN_ANOMALY: 270.3,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U',
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 40000,
  BSTAR: 0.0001,
  MEAN_MOTION_DOT: 1e-5,
  MEAN_MOTION_DDOT: 0,
};

const BAKED: BakedGp = {
  schemaVersion: 1,
  generatedAt: '2026-07-29T03:00:00.000Z',
  sourceUrl: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json',
  sourceLastModified: null,
  requestedCount: 2,
  recordCount: 1,
  catalogSize: 11000,
  records: { '25544': RECORD },
};

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe('baked GP source', () => {
  it('reads the baked file, never CelesTrak', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(BAKED));
    await loadBakedGp(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(BAKED_GP_URL);
    expect(url).not.toMatch(/celestrak/);
    expect(url).not.toMatch(/gp\.php|CATNR/);
  });

  it('returns elements for a baked object', () => {
    expect(elementsFor(BAKED, 25544).OBJECT_NAME).toBe('ISS (ZARYA)');
  });

  it('throws GpUnavailableError for an object the group omitted', () => {
    // The debris case: absent by design, and there is nothing to retry.
    expect(() => elementsFor(BAKED, 100001)).toThrow(GpUnavailableError);
    try {
      elementsFor(BAKED, 100001);
    } catch (error) {
      expect((error as GpUnavailableError).noradId).toBe(100001);
    }
  });

  it('distinguishes a missing file from a missing object', async () => {
    const notFound = async () => ({ ok: false, status: 404 }) as unknown as Response;
    await expect(loadBakedGp(notFound as unknown as typeof fetch)).rejects.toThrow(
      GpFileMissingError,
    );
    const offline = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(loadBakedGp(offline as unknown as typeof fetch)).rejects.toThrow(
      GpFileMissingError,
    );
  });

  it('rejects a payload with no records map rather than reporting every object missing', () => {
    // A truncated or wrong-shaped deploy must surface as an error, not as
    // "1575 objects unavailable", which would look like a data problem.
    expect(() => parseBakedGp({ schemaVersion: 1 })).toThrow(/no records map/);
    expect(() => parseBakedGp(null)).toThrow(/not an object/);
  });

  it('tolerates missing optional metadata', () => {
    const parsed = parseBakedGp({ records: { '1': RECORD } });
    expect(parsed.recordCount).toBe(0);
    expect(parsed.records['1']).toBeDefined();
  });
});
