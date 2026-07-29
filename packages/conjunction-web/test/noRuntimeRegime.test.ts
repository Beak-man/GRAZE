import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for a defect that shipped: regime classification used to run
 * in the browser, one CelesTrak GP request per unique object. With the 1389-record
 * union that meant ~1,838 requests per visitor, and a 60-object cap "fixed" the
 * volume by leaving ~97.8% of records unclassified while the filter still looked
 * functional.
 *
 * Regimes are now baked at build time from a single SATCAT request. Nothing in
 * the client may reintroduce a per-object lookup.
 */
const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (...p: string[]) => readFileSync(path.join(SRC, ...p), 'utf8');

describe('no runtime regime classification', () => {
  const main = read('main.ts');

  it('main.ts does not import the element-set regime classifier', () => {
    // classifyOrbitRegime operates on GP element sets — importing it in the
    // client implies fetching those element sets per object.
    expect(main).not.toMatch(/\bclassifyOrbitRegime\b/);
  });

  it('main.ts has no regime-classification fan-out or cap', () => {
    expect(main).not.toMatch(/classifyRegimes/);
    expect(main).not.toMatch(/CLASSIFY_LIMIT|CLASSIFY_CONCURRENCY/);
  });

  it('the sidebar takes regimes in bulk, not one id at a time', () => {
    const sidebar = read('ui', 'sidebar.ts');
    expect(sidebar).toMatch(/setBakedRegimes/);
    expect(sidebar).toMatch(/setRegimesUnavailable/);
    // The old per-object setter is gone.
    expect(sidebar).not.toMatch(/setRegime\(noradId/);
  });

  it('regimes are read from the baked payload', () => {
    expect(read('data', 'socratesSource.ts')).toMatch(/regimeIndexOf/);
    expect(main).toMatch(/regimeIndexOf/);
  });
});
