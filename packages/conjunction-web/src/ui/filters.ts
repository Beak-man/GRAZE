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
  /** Hide events whose orbital elements are not baked, so cannot be rendered. */
  visualizableOnly: boolean;
}

/** Regime of a catalog object, or undefined while GP data hasn't arrived. */
export type RegimeLookup = (noradId: number) => OrbitRegime | undefined;

/**
 * Whether an event can be rendered, or undefined when the bake could not say
 * (an older payload, or a run whose GP step failed).
 */
export type PlottableLookup = (event: ConjunctionEvent) => boolean | undefined;

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
  isPlottable: PlottableLookup = () => undefined,
): boolean {
  if (filters.visualizableOnly && isPlottable(event) === false) {
    // Only a definite false hides a row. Unknown stays visible: hiding what we
    // merely failed to classify would be a silent omission, the same rule the
    // regime gate follows.
    return false;
  }
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
