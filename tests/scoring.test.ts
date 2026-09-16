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

function makeProduct(overrides: Record<string, unknown> = {}): Product {
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
  } as unknown as Product;
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
  test('publisherKey concatenates sorted unique domains and keeps product_id', () => {
    const p = makeProduct({
      publisher_properties: [
        { publisher_domain: 'b.example', selection_type: 'all' as const },
        { publisher_domains: ['a.example', 'b.example'], selection_type: 'all' as const },
      ],
    });
    expect(publisherKey(p)).toBe('a.example,b.example::p1');
  });

  test('publisherKey falls back to product_id when no publisher domain', () => {
    const p = makeProduct({ publisher_properties: [], product_id: 'pZ' });
    expect(publisherKey(p)).toBe('__no_publisher__::pZ');
  });

  test('deduplicateScored collapses the same publisher placement across sellers', () => {
    // The case dedupe exists for. Two sellers resell one publisher placement
    // under their OWN product ids — which is how AdCP works, product_id being
    // seller-local. They cite the same publisher_ref {publisher_domain,
    // placement_id}, so the buyer must see the inventory once, at the better
    // score.
    //
    // The previous version of this test passed by accident: both entries used
    // makeProduct()'s default product_id 'p1', so they collided on the
    // seller-local id rather than on any publisher identity, and would have
    // gone on passing while the cross-seller case it claimed to guard was
    // broken.
    const brief = makeBrief();
    const props = [{ publisher_domain: 'x.example', selection_type: 'all' as const }];
    const placements = [
      { kind: 'publisher_ref' as const, placement_id: 'leaderboard', publisher_domain: 'x.example', mode: 'guaranteed' },
    ];
    const productA = makeProduct({ product_id: 'sellerA-leaderboard', publisher_properties: props, placements });
    const productB = makeProduct({ product_id: 'sellerB-leaderboard', publisher_properties: props, placements });
    const scored = [
      { seller_id: 'a', product: productA, breakdown: scoreProduct(productA, brief), score: 0.5 },
      { seller_id: 'b', product: productB, breakdown: scoreProduct(productB, brief), score: 0.9 },
    ];
    const deduped = deduplicateScored(scored);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.seller_id).toBe('b');
  });

  test('deduplicateScored keeps two placements of one publisher distinct', () => {
    // The opposite failure, and the worse one: collapsing here would drop a
    // publisher's second placement out of the ranking entirely. This is what
    // ea7ca29 added product_id to the key to protect, and the publisher_ref
    // path has to preserve it.
    const brief = makeBrief();
    const props = [{ publisher_domain: 'x.example', selection_type: 'all' as const }];
    const mk = (placementId: string, productId: string) =>
      makeProduct({
        product_id: productId,
        publisher_properties: props,
        placements: [
          { kind: 'publisher_ref' as const, placement_id: placementId, publisher_domain: 'x.example', mode: 'guaranteed' },
        ],
      });
    const landing = mk('landing', 'p-landing');
    const results = mk('results', 'p-results');
    const scored = [
      { seller_id: 'a', product: landing, breakdown: scoreProduct(landing, brief), score: 0.5 },
      { seller_id: 'a', product: results, breakdown: scoreProduct(results, brief), score: 0.9 },
    ];
    expect(deduplicateScored(scored)).toHaveLength(2);
  });

  test('seller_inline placements do not claim cross-seller identity', () => {
    // seller_inline placement ids are the seller's own invention, so two
    // sellers using the same string say nothing about the inventory being
    // the same. Falling back to the seller-local key leaves both visible:
    // a duplicate shown is recoverable, inventory hidden is not.
    const brief = makeBrief();
    const props = [{ publisher_domain: 'x.example', selection_type: 'all' as const }];
    const mk = (productId: string) =>
      makeProduct({
        product_id: productId,
        publisher_properties: props,
        placements: [
          { kind: 'seller_inline' as const, placement_id: 'top', name: 'Top slot', mode: 'guaranteed' },
        ],
      });
    const a = mk('sellerA-top');
    const b = mk('sellerB-top');
    const scored = [
      { seller_id: 'a', product: a, breakdown: scoreProduct(a, brief), score: 0.5 },
      { seller_id: 'b', product: b, breakdown: scoreProduct(b, brief), score: 0.9 },
    ];
    expect(deduplicateScored(scored)).toHaveLength(2);
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
