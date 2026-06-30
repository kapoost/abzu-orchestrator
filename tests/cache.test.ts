import { describe, expect, test } from 'bun:test';
import { TtlCache } from '../src/orchestrator/cache.ts';

function makeClock(initial = 1_000_000) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('TtlCache', () => {
  test('returns stored value before expiry', () => {
    const clock = makeClock();
    const cache = new TtlCache<string, number>(1000, clock.now);
    cache.set('a', 1);
    clock.advance(500);
    expect(cache.get('a')).toBe(1);
  });

  test('evicts entries past TTL', () => {
    const clock = makeClock();
    const cache = new TtlCache<string, number>(1000, clock.now);
    cache.set('a', 1);
    clock.advance(1001);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  test('updates expiry on set', () => {
    const clock = makeClock();
    const cache = new TtlCache<string, number>(1000, clock.now);
    cache.set('a', 1);
    clock.advance(900);
    cache.set('a', 2);
    clock.advance(900);
    expect(cache.get('a')).toBe(2);
  });

  test('rejects non-positive TTL', () => {
    expect(() => new TtlCache<string, number>(0)).toThrow();
    expect(() => new TtlCache<string, number>(-1)).toThrow();
  });
});
