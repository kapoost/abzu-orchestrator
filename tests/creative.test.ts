import { describe, expect, test } from 'bun:test';
import {
  ensureIdempotencyKey,
  parseCreativeSync,
  parseStatusQuery,
} from '../src/strategy/creative.ts';

const sampleCreative = {
  creative_id: 'cr_001',
  name: 'Banner 300x250',
  format_id: { agent_url: 'https://x', id: 'display_300x250' },
  assets: {
    image_main: {
      asset_type: 'image',
      url: 'https://cdn.example/banner.png',
    },
  },
};

const baseInput = {
  seller_id: 'purrsonality-seller',
  account: { brand: { domain: 'acme.example.com' }, operator: 'acme.example.com' },
  creatives: [sampleCreative],
};

describe('parseCreativeSync', () => {
  test('accepts brand+operator account form', () => {
    const out = parseCreativeSync(baseInput);
    expect(out.creatives).toHaveLength(1);
    expect(out.dry_run).toBe(false);
  });

  test('accepts account_id form', () => {
    const out = parseCreativeSync({
      ...baseInput,
      account: { account_id: 'acct_123' },
    });
    expect((out.account as { account_id: string }).account_id).toBe('acct_123');
  });

  test('rejects mixed account form (both account_id and brand)', () => {
    expect(() =>
      parseCreativeSync({
        ...baseInput,
        account: { account_id: 'acct_123', brand: { domain: 'x.example.com' }, operator: 'x.example.com' },
      }),
    ).toThrow();
  });

  test('rejects empty creatives', () => {
    expect(() => parseCreativeSync({ ...baseInput, creatives: [] })).toThrow();
  });

  test('rejects duplicate creative_id', () => {
    expect(() =>
      parseCreativeSync({
        ...baseInput,
        creatives: [sampleCreative, { ...sampleCreative, name: 'second' }],
      }),
    ).toThrow(/duplicate creative_id/);
  });

  test('rejects operator that is not a domain', () => {
    expect(() =>
      parseCreativeSync({
        ...baseInput,
        account: { brand: { domain: 'acme.example.com' }, operator: 'not a domain' },
      }),
    ).toThrow();
  });

  test('rejects too-short idempotency_key', () => {
    expect(() => parseCreativeSync({ ...baseInput, idempotency_key: 'abc' })).toThrow();
  });

  test('preserves unknown creative fields (passthrough)', () => {
    const out = parseCreativeSync({
      ...baseInput,
      creatives: [{ ...sampleCreative, tags: ['promo', 'q3'], format_kind: 'image' }],
    });
    expect(out.creatives[0]).toMatchObject({ tags: ['promo', 'q3'] });
  });
});

describe('ensureIdempotencyKey', () => {
  test('generates UUID-based key when absent', () => {
    const input = parseCreativeSync(baseInput);
    const withKey = ensureIdempotencyKey(input);
    expect(withKey.idempotency_key).toMatch(/^abzu_[0-9a-f]{32}$/);
  });

  test('keeps explicit key', () => {
    const input = parseCreativeSync({
      ...baseInput,
      idempotency_key: 'ABZUTEST0123456789ABCDE',
    });
    expect(ensureIdempotencyKey(input).idempotency_key).toBe('ABZUTEST0123456789ABCDE');
  });
});

describe('parseStatusQuery', () => {
  test('accepts minimal seller_id only', () => {
    const q = parseStatusQuery({ seller_id: 'x' });
    expect(q.creative_ids).toEqual([]);
    expect(q.statuses).toEqual([]);
  });

  test('accepts known statuses', () => {
    const q = parseStatusQuery({
      seller_id: 'x',
      statuses: ['pending_review', 'approved'],
    });
    expect(q.statuses).toEqual(['pending_review', 'approved']);
  });

  test('rejects unknown status', () => {
    expect(() =>
      parseStatusQuery({ seller_id: 'x', statuses: ['pending'] }),
    ).toThrow();
  });
});
