import { describe, expect, test } from 'bun:test';
import { parseBuyIntake } from '../src/strategy/buy.ts';

function base(overrides: Record<string, unknown> = {}) {
  return {
    seller_id: 'purrsonality-seller',
    plan_id: 'plan_001',
    account: { brand: { domain: 'acme.example.com' }, operator: 'acme.example.com' },
    brand: { domain: 'acme.example.com' },
    product_id: 'p_001',
    pricing_option_id: 'po_cpm_v1',
    budget: 1000,
    currency: 'USD',
    flight: { start: '2026-07-15T00:00:00Z', end: '2026-08-15T23:59:59Z' },
    ...overrides,
  };
}

describe('parseBuyIntake', () => {
  test('accepts minimal valid payload', () => {
    const b = parseBuyIntake(base());
    expect(b.budget).toBe(1000);
    expect(b.creative_ids).toEqual([]);
    expect(b.accept_conditions).toBe(false);
  });

  test('rejects ISO date (no time component)', () => {
    expect(() =>
      parseBuyIntake(base({ flight: { start: '2026-07-15', end: '2026-08-15' } })),
    ).toThrow(/ISO 8601 datetime/);
  });

  test('rejects flight where end is before start', () => {
    expect(() =>
      parseBuyIntake(
        base({ flight: { start: '2026-08-15T00:00:00Z', end: '2026-07-15T00:00:00Z' } }),
      ),
    ).toThrow(/flight.start/);
  });

  test('rejects negative budget', () => {
    expect(() => parseBuyIntake(base({ budget: -1 }))).toThrow();
  });

  test('rejects non-ISO currency', () => {
    expect(() => parseBuyIntake(base({ currency: 'usd' }))).toThrow();
  });

  test('rejects mixed account form (both account_id and brand)', () => {
    expect(() =>
      parseBuyIntake(
        base({
          account: { account_id: 'a', brand: { domain: 'x.example.com' }, operator: 'x.example.com' },
        }),
      ),
    ).toThrow();
  });

  test('rejects extra top-level fields (strict)', () => {
    expect(() => parseBuyIntake(base({ extra_field: 'nope' }))).toThrow();
  });

  test('accepts both account forms', () => {
    expect(parseBuyIntake(base({ account: { account_id: 'acct_42' } })).account).toEqual({
      account_id: 'acct_42',
    });
  });
});
