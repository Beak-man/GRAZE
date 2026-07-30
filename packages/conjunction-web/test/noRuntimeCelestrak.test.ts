import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Lockdown guard for the last runtime CelesTrak dependency.
 *
 * The client used to call gp.php?CATNR=<id> for both objects on every
 * conjunction click. Orbital elements are now baked into gp-active.json by
 * scripts/fetch-socrates.mjs from one bulk request per build, and nothing in
 * this package may reintroduce a per-object lookup.
 *
 * The one permitted CelesTrak reference is the SOCRATES *conjunction list*
 * fallback, which CLAUDE.md's resolution order defines and which runs only on
 * a fresh clone or an explicit "Fetch latest" click. That is asserted narrowly
 * below rather than blanket-allowed.
 */
const SRC = path.join(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const files = sourceFiles(SRC);
const read = (file: string): string => readFileSync(file, 'utf8');

describe('no runtime CelesTrak GP requests', () => {
  it('no source file builds a per-object GP URL', () => {
    // Comments may mention the old endpoint; code may not construct it. Strip
    // line and block comments before matching so the guard tracks real code.
    for (const file of files) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, path.basename(file)).not.toMatch(/gp\.php/);
      expect(code, path.basename(file)).not.toMatch(/CATNR/);
    }
  });

  it('does not import the per-object element fetcher from core', () => {
    for (const file of files) {
      expect(read(file), path.basename(file)).not.toMatch(/\bfetchOrbitalElements\b/);
    }
  });

  it('mentions celestrak.org only for the SOCRATES list fallback', () => {
    const offenders = files.filter((f) => /celestrak\.org/.test(read(f).replace(/\/\*[\s\S]*?\*\//g, '')));
    expect(offenders.map((f) => path.basename(f))).toEqual(['main.ts']);
    // And in main.ts it is bound to a SOCRATES-scoped name, not a generic base.
    const main = read(path.join(SRC, 'main.ts'));
    expect(main).toMatch(/SOCRATES_FALLBACK_BASE_URL\s*=/);
    expect(main).not.toMatch(/CELESTRAK_BASE_URL/);
  });

  it('reads elements from the baked file', () => {
    const gp = read(path.join(SRC, 'data', 'gpSource.ts'));
    expect(gp).toMatch(/\/data\/gp-active\.json/);
    const main = read(path.join(SRC, 'main.ts'));
    expect(main).toMatch(/loadBakedGp/);
    expect(main).toMatch(/GpUnavailableError/);
  });

  it('keeps no Cloudflare Worker proxy guidance', () => {
    for (const file of files) {
      expect(read(file).toLowerCase(), path.basename(file)).not.toMatch(/cloudflare/);
      expect(read(file), path.basename(file)).not.toMatch(/VITE_CELESTRAK_BASE/);
    }
  });
});
