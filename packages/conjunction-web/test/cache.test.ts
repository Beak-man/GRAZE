import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCache, writeCache } from '../src/cache.js';

/** Minimal in-memory Storage shim; vitest runs in node with no localStorage. */
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
  /** Test helper: overwrite a raw value (bypasses the envelope format). */
  poke(key: string, value: string): void {
    this.store.set(key, value);
  }
}

let memory: MemoryStorage;

beforeEach(() => {
  memory = new MemoryStorage();
  vi.stubGlobal('localStorage', memory);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const HOUR_MS = 60 * 60 * 1000;

describe('readCache / writeCache', () => {
  it('returns a value written within the TTL, with its savedAt', () => {
    writeCache('k', { hello: 'world' });
    const hit = readCache<{ hello: string }>('k', HOUR_MS);
    expect(hit).not.toBeNull();
    expect(hit?.data).toEqual({ hello: 'world' });
    expect(hit?.savedAt).toBeInstanceOf(Date);
  });

  it('returns null once the entry is older than the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'));
    writeCache('k', 42);
    vi.setSystemTime(new Date('2026-07-21T02:00:01Z')); // 2h + 1s later
    expect(readCache('k', 2 * HOUR_MS)).toBeNull();
  });

  it('returns null for an absent key', () => {
    expect(readCache('missing', HOUR_MS)).toBeNull();
  });

  it('treats a corrupt entry as a miss', () => {
    // Reach past the graze:v1: prefix to plant invalid JSON.
    memory.poke('graze:v1:bad', '{not json');
    expect(readCache('bad', HOUR_MS)).toBeNull();
  });

  it('runs the reviver so Date fields round-trip', () => {
    const tca = new Date('2026-07-22T16:45:00Z');
    writeCache('events', [{ name: 'X', tca }]);
    const hit = readCache<{ name: string; tca: Date }[]>('events', HOUR_MS, (rows) =>
      rows.map((row) => ({ ...row, tca: new Date(row.tca) })),
    );
    expect(hit?.data[0]?.tca).toBeInstanceOf(Date);
    expect(hit?.data[0]?.tca.getTime()).toBe(tca.getTime());
  });

  it('degrades to a miss (never throws) when storage access throws', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    });
    expect(() => writeCache('k', 1)).not.toThrow();
    expect(readCache('k', HOUR_MS)).toBeNull();
  });
});
