import { classifyObjectType } from 'conjunction-core';
import type { ConjunctionEvent, ObjectType, OrbitRegime } from 'conjunction-core';

export interface ConjunctionFilters {
  /** Orbit regimes to show. */
  regimes: ReadonlySet<OrbitRegime>;
  /** Object types to show. */
  types: ReadonlySet<ObjectType>;
  /** Maximum miss distance, km. */
  maxMissKm: number;
  /**
   * Exclusive lower bound on max probability. Use Number.NEGATIVE_INFINITY
   * for "show all" so events with probability 0 still pass.
   */
  minProbability: number;
}

/** Regime of a catalog object, or undefined while GP data hasn't arrived. */
export type RegimeLookup = (noradId: number) => OrbitRegime | undefined;

/**
 * Whether an event passes the active filters. Type and regime filters pass
 * when either of the two objects matches. Regimes are only filtered once
 * both objects are classified — unknown regimes are shown rather than
 * silently hidden.
 */
export function eventPassesFilters(
  event: ConjunctionEvent,
  filters: ConjunctionFilters,
  lookupRegime: RegimeLookup,
): boolean {
  if (event.minRange > filters.maxMissKm) {
    return false;
  }
  if (!(event.maxProbability > filters.minProbability)) {
    return false;
  }
  const type1 = classifyObjectType(event.name1);
  const type2 = classifyObjectType(event.name2);
  if (!filters.types.has(type1) && !filters.types.has(type2)) {
    return false;
  }
  const regime1 = lookupRegime(event.noradId1);
  const regime2 = lookupRegime(event.noradId2);
  if (regime1 !== undefined && regime2 !== undefined) {
    if (!filters.regimes.has(regime1) && !filters.regimes.has(regime2)) {
      return false;
    }
  }
  return true;
}
