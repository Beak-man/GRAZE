import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatCountdown,
  formatKm,
  formatMinutes,
  formatProbability,
  formatRange,
  formatSpeed,
  formatTca,
} from '../src/format.js';

const AGE_STRINGS = {
  justNow: 'less than an hour',
  hours: (n: number) => `${n} hour${n === 1 ? '' : 's'}`,
  days: (n: number) => `${n} day${n === 1 ? '' : 's'}`,
};

describe('formatAge', () => {
  const HOUR = 3_600_000;

  it('collapses anything under an hour', () => {
    expect(formatAge(0, AGE_STRINGS)).toBe('less than an hour');
    expect(formatAge(59 * 60_000, AGE_STRINGS)).toBe('less than an hour');
  });

  it('reports hours below two days', () => {
    expect(formatAge(HOUR, AGE_STRINGS)).toBe('1 hour');
    expect(formatAge(9 * HOUR, AGE_STRINGS)).toBe('9 hours');
    expect(formatAge(47 * HOUR, AGE_STRINGS)).toBe('47 hours');
  });

  it('switches to days at 48 hours', () => {
    expect(formatAge(48 * HOUR, AGE_STRINGS)).toBe('2 days');
    expect(formatAge(30 * 24 * HOUR, AGE_STRINGS)).toBe('30 days');
  });
});

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
