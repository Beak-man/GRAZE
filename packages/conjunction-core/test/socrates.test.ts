import { describe, expect, it } from 'vitest';
import { parseSocratesCsv } from '../src/socrates.js';

const SAMPLE_CSV = `NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION
25544,ISS (ZARYA),0.527,47853,FENGYUN 1C DEB,1.255,2026-06-13 04:18:46.123,0.405,14.219,2.539E-04,1.139E-02
43013,"NOAA 20 (JPSS-1)",1.118,33442,COSMOS 2251 DEB,3.470,2026-06-13 11:02:13.456,0.812,11.804,7.121E-05,4.022E-03
100001,"OBJ, WITH COMMA",0.100,123456,OTHER OBJECT,0.200,2026-06-14 00:00:00.000,1.500,9.500,,5.000E-03
`;

describe('parseSocratesCsv', () => {
  it('parses every data row', () => {
    const events = parseSocratesCsv(SAMPLE_CSV);
    expect(events).toHaveLength(3);
  });

  it('maps all fields of a row', () => {
    const [event] = parseSocratesCsv(SAMPLE_CSV);
    expect(event).toBeDefined();
    expect(event?.noradId1).toBe(25544);
    expect(event?.name1).toBe('ISS (ZARYA)');
    expect(event?.noradId2).toBe(47853);
    expect(event?.name2).toBe('FENGYUN 1C DEB');
    expect(event?.tca).toEqual(new Date('2026-06-13T04:18:46.123Z'));
    expect(event?.minRange).toBeCloseTo(0.405);
    expect(event?.relativeSpeed).toBeCloseTo(14.219);
    expect(event?.maxProbability).toBeCloseTo(2.539e-4);
    expect(event?.dse1).toBeCloseTo(0.527);
    expect(event?.dse2).toBeCloseTo(1.255);
  });

  it('handles quoted names, including embedded commas', () => {
    const events = parseSocratesCsv(SAMPLE_CSV);
    expect(events[1]?.name1).toBe('NOAA 20 (JPSS-1)');
    expect(events[2]?.name1).toBe('OBJ, WITH COMMA');
  });

  it('handles 6-digit catalog numbers (post-July-2026 objects)', () => {
    const events = parseSocratesCsv(SAMPLE_CSV);
    expect(events[2]?.noradId1).toBe(100001);
    expect(events[2]?.noradId2).toBe(123456);
  });

  it('treats an empty MAX_PROB as probability 0', () => {
    const events = parseSocratesCsv(SAMPLE_CSV);
    expect(events[2]?.maxProbability).toBe(0);
  });

  it('parses TCA as UTC', () => {
    const events = parseSocratesCsv(SAMPLE_CSV);
    expect(events[1]?.tca.toISOString()).toBe('2026-06-13T11:02:13.456Z');
  });

  it('stops after maxRows data rows when given a limit', () => {
    const events = parseSocratesCsv(SAMPLE_CSV, 2);
    expect(events).toHaveLength(2);
    expect(events[1]?.noradId1).toBe(43013);
  });

  it('returns an empty array for a header-only document', () => {
    const headerOnly = SAMPLE_CSV.split('\n')[0] ?? '';
    expect(parseSocratesCsv(headerOnly)).toEqual([]);
  });

  it('throws when a required column is missing', () => {
    expect(() => parseSocratesCsv('FOO,BAR\n1,2\n')).toThrow(/missing expected column/);
  });
});
