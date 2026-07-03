import { z } from 'zod';

const envSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(8787),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  VERSION: z.string().default('0.0.1'),
  SELLERS_CONFIG_PATH: z.string().default('sellers.json'),
  SIGNALS_CONFIG_PATH: z.string().default('signals.json'),
  DISCOVERY_FORMATS_TTL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  GOVERNANCE_AGENT_URI: z.url().optional(),
  GOVERNANCE_AUTH_TOKEN: z.string().min(8).optional(),
  // Hybrid auth: clients may present either an RS256 JWT minted by the
  // rocketscience-auth IdP OR a static bearer token matching
  // ABZU_ORCHESTRATOR_AUTH_TOKEN. JWT is the future path (auto-rotation,
  // audit log via IdP); the static fallback exists because AAO's
  // `save_agent oauth_client_credentials` slot currently returns success
  // without persisting the credentials (verified 2026-06-30 — AAO accepts
  // the call, list_saved_agents subsequently reports "No token").
  OAUTH_ISSUER: z.string().url().default('https://auth.rocketscience.pl'),
  OAUTH_JWKS_URI: z.string().url().default('https://auth.rocketscience.pl/.well-known/jwks.json'),
  OAUTH_AUDIENCE: z.string().url().default('https://api.rocketscience.pl'),
  ABZU_ORCHESTRATOR_AUTH_TOKEN: z.string().min(8).optional(),
  // AAO MCP bearer used by /brands proxy for live brand-registry search.
  // When unset, /brands returns 503 — the GUI falls back to the static
  // brands.json snapshot shipped with abzu-gui.
  AAO_BEARER_TOKEN: z.string().min(8).optional(),
  // Creative generative agent — build_creative fan-out target for the
  // "Generate creatives" button in Sam view. When unset the /creative
  // proxy endpoints return 503. Bearer is stored server-side; the GUI
  // never sees it. Trust-key gate is handled per-call by the caller
  // passing X-Creative-Trust-Key through.
  CREATIVE_AGENT_URI: z.url().optional(),
  CREATIVE_AGENT_AUTH_TOKEN: z.string().min(8).optional(),
  DATABASE_URL: z
    .string()
    .optional()
    .transform((s) => {
      const trimmed = s?.trim() ?? '';
      return trimmed.length > 0 ? trimmed : undefined;
    }),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(source);
}
