/** Format a range in km, switching to meters below 1 km. */
export function formatRange(km: number): string {
  if (km < 1) {
    return `${Math.round(km * 1000)} m`;
  }
  return `${km.toFixed(2)} km`;
}

/** Format a collision probability, or an em dash when it is unavailable. */
export function formatProbability(probability: number): string {
  if (!(probability > 0)) {
    return '—';
  }
  return probability.toExponential(2);
}

/** Format a date as a compact UTC timestamp. */
export function formatTca(date: Date): string {
  return `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/** Format a speed in km/s. */
export function formatSpeed(kmPerSecond: number): string {
  return `${kmPerSecond.toFixed(2)} km/s`;
}

/**
 * Format a time offset relative to TCA as a countdown, e.g. "T−04:23" before
 * and "T+00:12" after.
 */
export function formatCountdown(millisecondsToTca: number): string {
  const sign = millisecondsToTca >= 0 ? '−' : '+';
  const totalSeconds = Math.round(Math.abs(millisecondsToTca) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `T${sign}${mm}:${ss}`;
}

/** Format an altitude/height in km with one decimal. */
export function formatKm(km: number): string {
  return `${km.toFixed(1)} km`;
}

/** Format a duration in minutes. */
export function formatMinutes(minutes: number): string {
  return `${minutes.toFixed(1)} min`;
}
