import { describe, expect, it } from 'vitest';
import {
  formatCountdown,
  formatKm,
  formatMinutes,
  formatProbability,
  formatRange,
  formatSpeed,
  formatTca,
} from '../src/format.js';

describe('formatRange', () => {
  it('uses meters below 1 km', () => {
    expect(formatRange(0.405)).toBe('405 m');
  });

  it('uses km at or above 1 km', () => {
    expect(formatRange(1.5)).toBe('1.50 km');
  });
});

describe('formatProbability', () => {
  it('uses scientific notation', () => {
    expect(formatProbability(2.539e-4)).toBe('2.54e-4');
  });

  it('shows an em dash for zero or missing probability', () => {
    expect(formatProbability(0)).toBe('—');
    expect(formatProbability(Number.NaN)).toBe('—');
  });
});

describe('formatTca', () => {
  it('formats as a compact UTC timestamp', () => {
    expect(formatTca(new Date('2026-06-13T04:18:46.123Z'))).toBe('2026-06-13 04:18:46 UTC');
  });
});

describe('formatSpeed', () => {
  it('formats km/s with two decimals', () => {
    expect(formatSpeed(14.219)).toBe('14.22 km/s');
  });
});

describe('formatCountdown', () => {
  it('counts down before TCA', () => {
    expect(formatCountdown(263_000)).toBe('T−04:23');
  });

  it('counts up after TCA', () => {
    expect(formatCountdown(-12_000)).toBe('T+00:12');
  });

  it('treats zero as T−00:00', () => {
    expect(formatCountdown(0)).toBe('T−00:00');
  });
});

describe('formatKm and formatMinutes', () => {
  it('format with one decimal', () => {
    expect(formatKm(417.93)).toBe('417.9 km');
    expect(formatMinutes(92.66)).toBe('92.7 min');
  });
});
