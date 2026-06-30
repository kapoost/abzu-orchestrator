import { describe, expect, test } from 'bun:test';
import { composeBriefString, parseBrief } from '../src/strategy/brief.ts';

function minimal(overrides: Record<string, unknown> = {}) {
  return {
    advertiser: { name: 'Acme' },
    brief: 'awareness campaign for new product',
    budget: { amount: 10000, currency: 'USD' },
    flight: { start: '2026-07-01', end: '2026-07-31' },
    ...overrides,
  };
}

describe('parseBrief', () => {
  test('accepts minimal payload with defaults', () => {
    const b = parseBrief(minimal());
    expect(b.top_n).toBe(10);
    expect(b.time_budget_seconds).toBe(30);
    expect(b.budget.period).toBe('flight');
    expect(b.channels).toEqual([]);
  });

  test('rejects flight where end is before start', () => {
    expect(() =>
      parseBrief(minimal({ flight: { start: '2026-07-31', end: '2026-07-01' } })),
    ).toThrow(/flight.start/);
  });

  test('rejects non-ISO date', () => {
    expect(() =>
      parseBrief(minimal({ flight: { start: '07/01/2026', end: '07/31/2026' } })),
    ).toThrow();
  });

  test('rejects non-ISO 4217 currency', () => {
    expect(() => parseBrief(minimal({ budget: { amount: 1, currency: 'usd' } }))).toThrow();
  });

  test('rejects brief shorter than 10 chars', () => {
    expect(() => parseBrief(minimal({ brief: 'short' }))).toThrow();
  });

  test('coerces preferred_delivery_types enum', () => {
    const b = parseBrief(minimal({ preferred_delivery_types: ['guaranteed'] }));
    expect(b.preferred_delivery_types).toEqual(['guaranteed']);
    expect(() => parseBrief(minimal({ preferred_delivery_types: ['sponsored'] }))).toThrow();
  });
});

describe('composeBriefString', () => {
  test('includes core fields', () => {
    const b = parseBrief(
      minimal({
        audience: 'cat owners 25-44',
        channels: ['display', 'ctv'],
        formats: ['display_300x250'],
        kpis: ['CTR > 0.5%', 'CPM < $5'],
      }),
    );
    const s = composeBriefString(b);
    expect(s).toContain('awareness campaign');
    expect(s).toContain('Acme');
    expect(s).toContain('cat owners 25-44');
    expect(s).toContain('10000 USD');
    expect(s).toContain('2026-07-01');
    expect(s).toContain('display, ctv');
    expect(s).toContain('display_300x250');
    expect(s).toContain('CTR > 0.5%');
  });

  test('omits empty optional lines', () => {
    const s = composeBriefString(parseBrief(minimal()));
    expect(s).not.toContain('Audience:');
    expect(s).not.toContain('KPIs:');
    expect(s).not.toContain('Preferred channels:');
  });
});
