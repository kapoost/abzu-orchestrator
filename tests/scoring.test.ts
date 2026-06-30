import { describe, expect, test } from 'bun:test';
import type { Product } from '@adcp/sdk';
import {
  deduplicateScored,
  publisherKey,
  rankProposals,
  scoreProduct,
  totalScore,
} from '../src/strategy/scoring.ts';
import type { BriefIntake } from '../src/strategy/brief.ts';
import { parseBrief } from '../src/strategy/brief.ts';

function makeBrief(overrides: Partial<BriefIntake> = {}): BriefIntake {
  return parseBrief({
    advertiser: { name: 'Acme' },
    brief: 'awareness campaign for new product line',
    budget: { amount: 10000, currency: 'USD' },
    flight: { start: '2026-07-01', end: '2026-07-31' },
    ...overrides,
  }) as BriefIntake;
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    product_id: 'p1',
    name: 'Product 1',
    description: 'desc',
    publisher_properties: [],
    delivery_type: 'non_guaranteed',
    pricing_options: [],
    reporting_capabilities: {} as Product['reporting_capabilities'],
    channels: ['display'],
    format_ids: [{ agent_url: 'https://x', id: 'display_300x250' }],
    ...overrides,
  } as Product;
}

describe('scoreProduct', () => {
  test('all dimensions 1 when brief has no preferences and brief_relevance present', () => {
    const product = makeProduct({ brief_relevance: 'matches' });
    const breakdown = scoreProduct(product, makeBrief());
    expect(breakdown.format_match).toBe(1);
    expect(breakdown.channel_match).toBe(1);
    expect(breakdown.delivery_match).toBe(1);
    expect(breakdown.brief_response).toBe(1);
    expect(totalScore(breakdown)).toBe(1);
  });

  test('format mismatch yields zero on format dimension', () => {
    const breakdown = scoreProduct(makeProduct(), makeBrief({ formats: ['video_vast_15s'] }));
    expect(breakdown.format_match).toBe(0);
  });

  test('format hit when product format_ids overlap brief.formats', () => {
    const breakdown = scoreProduct(makeProduct(), makeBrief({ formats: ['display_300x250'] }));
    expect(breakdown.format_match).toBe(1);
  });

  test('channel mismatch zeros channel dimension', () => {
    const breakdown = scoreProduct(makeProduct(), makeBrief({ channels: ['ctv'] }));
    expect(breakdown.channel_match).toBe(0);
  });

  test('delivery mismatch zeros delivery dimension', () => {
    const breakdown = scoreProduct(
      makeProduct({ delivery_type: 'non_guaranteed' }),
      makeBrief({ preferred_delivery_types: ['guaranteed'] }),
    );
    expect(breakdown.delivery_match).toBe(0);
  });

  test('brief_response defaults to 0.5 when seller skipped brief_relevance', () => {
    const breakdown = scoreProduct(makeProduct(), makeBrief());
    expect(breakdown.brief_response).toBe(0.5);
  });
});

describe('publisherKey + deduplicateScored', () => {
  test('publisherKey concatenates sorted unique domains', () => {
    const p = makeProduct({
      publisher_properties: [
        { publisher_domain: 'b.example', selection_type: 'all' as const },
        { publisher_domains: ['a.example', 'b.example'], selection_type: 'all' as const },
      ],
    });
    expect(publisherKey(p)).toBe('a.example,b.example');
  });

  test('publisherKey falls back to product_id when no publisher domain', () => {
    const p = makeProduct({ publisher_properties: [], product_id: 'pZ' });
    expect(publisherKey(p)).toBe('__no_publisher__::pZ');
  });

  test('deduplicateScored keeps highest score per publisher key', () => {
    const brief = makeBrief();
    const props = [{ publisher_domain: 'x.example', selection_type: 'all' as const }];
    const scored = [
      {
        seller_id: 'a',
        product: makeProduct({ publisher_properties: props }),
        breakdown: scoreProduct(makeProduct({ publisher_properties: props }), brief),
        score: 0.5,
      },
      {
        seller_id: 'b',
        product: makeProduct({ publisher_properties: props }),
        breakdown: scoreProduct(makeProduct({ publisher_properties: props }), brief),
        score: 0.9,
      },
    ];
    const deduped = deduplicateScored(scored);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.seller_id).toBe('b');
  });
});

describe('rankProposals', () => {
  test('sorts by score desc, breaks ties by seller_id asc', () => {
    const brief = makeBrief();
    const product = makeProduct({ brief_relevance: 'matches' });
    const ranked = rankProposals(
      [
        { seller_id: 'b', product },
        { seller_id: 'a', product },
      ],
      brief,
    );
    expect(ranked[0]!.seller_id).toBe('a');
    expect(ranked[1]!.seller_id).toBe('b');
  });

  test('top_n caps result size', () => {
    const brief = makeBrief({ top_n: 1 });
    const ranked = rankProposals(
      [
        { seller_id: 'a', product: makeProduct({ brief_relevance: 'matches' }) },
        { seller_id: 'b', product: makeProduct({ brief_relevance: 'matches' }) },
      ],
      brief,
    );
    expect(ranked).toHaveLength(1);
  });

  test('cross-seller dedup keeps higher-scored when publisher domains overlap', () => {
    const brief = makeBrief();
    const sharedProperties = [
      { publisher_domain: 'news.example.com', selection_type: 'all' as const },
    ];
    const ranked = rankProposals(
      [
        {
          seller_id: 'high',
          product: makeProduct({
            publisher_properties: sharedProperties,
            brief_relevance: 'fits',
          }),
        },
        {
          seller_id: 'low',
          product: makeProduct({ publisher_properties: sharedProperties }),
        },
      ],
      brief,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.seller_id).toBe('high');
  });

  test('lower-scored product ranks below higher-scored', () => {
    const brief = makeBrief({ formats: ['display_300x250'] });
    const ranked = rankProposals(
      [
        {
          seller_id: 'low',
          product: makeProduct({
            format_ids: [{ agent_url: 'https://x', id: 'video' }],
          }),
        },
        {
          seller_id: 'high',
          product: makeProduct({ brief_relevance: 'matches' }),
        },
      ],
      brief,
    );
    expect(ranked[0]!.seller_id).toBe('high');
    expect(ranked[1]!.seller_id).toBe('low');
  });
});
