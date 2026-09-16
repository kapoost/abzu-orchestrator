import type { Product } from '@adcp/sdk';
import type { BriefIntake } from './brief.ts';

export type ScoreBreakdown = {
  format_match: number;
  channel_match: number;
  delivery_match: number;
  brief_response: number;
};

export type ScoredProduct = {
  seller_id: string;
  product: Product;
  score: number;
  breakdown: ScoreBreakdown;
};

function formatIds(product: Product): string[] {
  const ids: string[] = [];
  // Products from legacy sellers may still carry format_ids at runtime even
  // though the CanonicalProduct type asserts never — we accept both shapes.
  const legacyRefs = (product as { format_ids?: ReadonlyArray<unknown> }).format_ids;
  for (const ref of legacyRefs ?? []) {
    if (typeof ref === 'string') {
      ids.push(ref);
    } else if (typeof ref === 'object' && ref !== null && 'id' in ref && typeof (ref as { id?: unknown }).id === 'string') {
      ids.push((ref as { id: string }).id);
    }
  }
  const canonical = (product as { format_options?: ReadonlyArray<unknown> }).format_options;
  for (const opt of canonical ?? []) {
    const maybeId = (opt as { format_option_id?: unknown }).format_option_id;
    if (typeof maybeId === 'string') ids.push(maybeId);
    const params = (opt as { params?: { id?: unknown } }).params;
    if (params && typeof params.id === 'string') ids.push(params.id);
  }
  return ids;
}

function overlapScore(wanted: string[], offered: string[]): number {
  if (wanted.length === 0) return 1;
  if (offered.length === 0) return 0;
  const offeredSet = new Set(offered);
  const hit = wanted.some((w) => offeredSet.has(w));
  return hit ? 1 : 0;
}

export function scoreProduct(product: Product, brief: BriefIntake): ScoreBreakdown {
  const format_match = overlapScore(brief.formats, formatIds(product));
  const channel_match = overlapScore(brief.channels, (product.channels ?? []) as string[]);
  const delivery_match =
    brief.preferred_delivery_types.length === 0
      ? 1
      : brief.preferred_delivery_types.includes(
            product.delivery_type as (typeof brief.preferred_delivery_types)[number],
          )
        ? 1
        : 0;
  const briefRelevance = (product as { brief_relevance?: string }).brief_relevance;
  const brief_response = briefRelevance && briefRelevance.length > 0 ? 1 : 0.5;
  return { format_match, channel_match, delivery_match, brief_response };
}

export function totalScore(breakdown: ScoreBreakdown): number {
  return (
    (breakdown.format_match +
      breakdown.channel_match +
      breakdown.delivery_match +
      breakdown.brief_response) /
    4
  );
}

export function publisherKey(product: Product, fallbackSellerId?: string): string {
  const domains = new Set<string>();
  const pubProps = (product as { publisher_properties?: ReadonlyArray<unknown> }).publisher_properties;
  for (const sel of pubProps ?? []) {
    const one = (sel as { publisher_domain?: string }).publisher_domain;
    if (typeof one === 'string') domains.add(one);
    // The compact plural form is rejected on products per core/product.json
    // ("SDK implementers MUST enforce singular-only at runtime"), but it is
    // read here anyway: a seller that emits it should still be deduped
    // rather than silently treated as publisher-less.
    const many = (sel as { publisher_domains?: string[] }).publisher_domains;
    if (Array.isArray(many)) for (const d of many) domains.add(d);
  }

  // Preferred key: publisher-referenced placements. core/placement.json
  // defines `kind: "publisher_ref"` as identifying a placement by
  // {publisher_domain, placement_id}, with placement_id living in the
  // PUBLISHER's namespace — so two sellers reselling the same inventory cite
  // the same pair, and that is exactly the collapse this dedupe exists for.
  // Different placements of one publisher carry different placement_ids and
  // stay distinct, which is what ea7ca29 added product_id to protect.
  const refs = new Set<string>();
  const placements = (product as { placements?: ReadonlyArray<unknown> }).placements;
  for (const raw of placements ?? []) {
    const pl = raw as { kind?: string; placement_id?: string; publisher_domain?: string };
    if (pl.kind !== 'publisher_ref' || typeof pl.placement_id !== 'string') continue;
    // publisher_domain is required on publisher_ref; fall back to the
    // product's own domains when a seller omits it, so a partially-populated
    // product still keys on something publisher-scoped.
    const domain = pl.publisher_domain ?? [...domains].sort()[0] ?? '';
    refs.add(`${domain}#${pl.placement_id}`);
  }
  if (refs.size > 0) return `pubref::${[...refs].sort().join(',')}`;

  // Fallback: no publisher-scoped placement identity available — either the
  // product declares no placements, or only `seller_inline` ones, whose ids
  // are the seller's own invention and say nothing about whether two
  // sellers are offering the same inventory.
  //
  // product_id stays in the key here on purpose. It is seller-local, so it
  // will NOT collapse the same inventory across two sellers — but claiming
  // such a collapse from a seller-local id would be a guess, and the
  // opposite failure (a publisher's second placement vanishing from the
  // ranking, which is what ea7ca29 fixed) is the worse one. Under-collapsing
  // shows the buyer a duplicate; over-collapsing hides inventory entirely.
  if (domains.size > 0) return [...domains].sort().join(',') + '::' + product.product_id;
  return fallbackSellerId
    ? `__sellerlocal__::${fallbackSellerId}::${product.product_id}`
    : `__no_publisher__::${product.product_id}`;
}

export function deduplicateScored(scored: ReadonlyArray<ScoredProduct>): ScoredProduct[] {
  const best = new Map<string, ScoredProduct>();
  for (const entry of scored) {
    const key = publisherKey(entry.product, entry.seller_id);
    const incumbent = best.get(key);
    if (!incumbent || entry.score > incumbent.score) {
      best.set(key, entry);
    }
  }
  return [...best.values()];
}

export function rankProposals(
  candidates: ReadonlyArray<{ seller_id: string; product: Product }>,
  brief: BriefIntake,
): ScoredProduct[] {
  const scored = candidates.map(({ seller_id, product }) => {
    const breakdown = scoreProduct(product, brief);
    return { seller_id, product, breakdown, score: totalScore(breakdown) };
  });
  const deduped = deduplicateScored(scored);
  deduped.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.seller_id.localeCompare(b.seller_id);
  });
  return deduped.slice(0, brief.top_n);
}
