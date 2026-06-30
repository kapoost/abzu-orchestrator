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

export async function createPostgresKnownPlans(databaseUrl: string): Promise<KnownPlansAdapter> {
  const sql = postgres(databaseUrl, { onnotice: () => {} });
  await sql.unsafe(CREATE_SQL);
  await sql.unsafe(CREATE_INDEX_SQL);

  return {
    async remember(planId, brandDomain) {
      await sql`
        INSERT INTO abzu_known_plans (plan_id, brand_domain, synced_at)
        VALUES (${planId}, ${brandDomain ?? null}, NOW())
        ON CONFLICT (plan_id) DO UPDATE
          SET brand_domain = EXCLUDED.brand_domain,
              synced_at = EXCLUDED.synced_at
      `;
    },
    async list() {
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
    },
  };
}
