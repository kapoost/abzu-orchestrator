import postgres from 'postgres';
import type { KnownPlanEntry, KnownPlansAdapter } from './client.ts';

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS abzu_known_plans (
    plan_id TEXT PRIMARY KEY,
    brand_domain TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_abzu_known_plans_synced
    ON abzu_known_plans (synced_at DESC)
`;

// TTL for the in-memory list() cache. Every open abzu-gui tab polls
// /governance/plans on a 15s setInterval, so an unattended dashboard was
// firing a SELECT every 15s per viewer forever — enough to exhaust the
// Neon compute quota on abzu's project. Backing the read with a 30s cache
// caps that to ~2 queries/min regardless of viewer count; writes invalidate
// so newly-registered plans still show up immediately for the poster.
const LIST_CACHE_TTL_MS = 30_000;

export async function createPostgresKnownPlans(databaseUrl: string): Promise<KnownPlansAdapter> {
  const sql = postgres(databaseUrl, { onnotice: () => {} });
  // Best-effort DDL — the table has existed for months; if Neon is degraded
  // (compute quota exhausted, connection refused, etc.) we must NOT wedge
  // the whole abzu process at boot. Log and continue; list()/remember() will
  // surface the error at request time where it can be handled per-endpoint.
  try {
    await sql.unsafe(CREATE_SQL);
    await sql.unsafe(CREATE_INDEX_SQL);
  } catch (err) {
    console.warn('[abzu/known-plans] DDL skipped:', err instanceof Error ? err.message : String(err));
  }

  let cache: { at: number; entries: KnownPlanEntry[] } | null = null;
  let inflight: Promise<KnownPlanEntry[]> | null = null;

  async function fetchFresh(): Promise<KnownPlanEntry[]> {
    const rows = await sql<Array<{ plan_id: string; brand_domain: string | null; synced_at: Date }>>`
      SELECT plan_id, brand_domain, synced_at
      FROM abzu_known_plans
      ORDER BY synced_at DESC
    `;
    return rows.map((r) => {
      const entry: KnownPlanEntry = {
        plan_id: r.plan_id,
        synced_at: r.synced_at.toISOString(),
      };
      if (r.brand_domain) entry.brand_domain = r.brand_domain;
      return entry;
    });
  }

  return {
    async remember(planId, brandDomain) {
      await sql`
        INSERT INTO abzu_known_plans (plan_id, brand_domain, synced_at)
        VALUES (${planId}, ${brandDomain ?? null}, NOW())
        ON CONFLICT (plan_id) DO UPDATE
          SET brand_domain = EXCLUDED.brand_domain,
              synced_at = EXCLUDED.synced_at
      `;
      cache = null;
    },
    async list() {
      const now = Date.now();
      if (cache && now - cache.at < LIST_CACHE_TTL_MS) return cache.entries;
      // Coalesce concurrent misses so 10 parallel viewers = 1 query, not 10.
      if (inflight) return inflight;
      inflight = fetchFresh()
        .then((entries) => {
          cache = { at: Date.now(), entries };
          return entries;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
