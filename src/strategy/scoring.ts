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
  for (const ref of product.format_ids ?? []) {
    if (typeof ref === 'object' && ref !== null && 'id' in ref && typeof ref.id === 'string') {
      ids.push(ref.id);
    }
  }
  for (const opt of product.format_options ?? []) {
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
  const brief_response = product.brief_relevance && product.brief_relevance.length > 0 ? 1 : 0.5;
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
  for (const sel of product.publisher_properties ?? []) {
    const one = (sel as { publisher_domain?: string }).publisher_domain;
    if (typeof one === 'string') domains.add(one);
    const many = (sel as { publisher_domains?: string[] }).publisher_domains;
    if (Array.isArray(many)) for (const d of many) domains.add(d);
  }
  if (domains.size > 0) return [...domains].sort().join(',');
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
