import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { CreativeClient, DiscoveryClient, ExecutionClient, PlanningClient } from '../orchestrator/index.ts';
import type { GovernanceClient, KnownPlansAdapter } from '../governance/client.ts';
import { parseBrief } from '../strategy/brief.ts';
import { parseBuyIntake } from '../strategy/buy.ts';
import { parseCreativeSync, parseStatusQuery } from '../strategy/creative.ts';

export type McpDeps = {
  discovery: DiscoveryClient;
  planning: PlanningClient;
  creative: CreativeClient;
  execution?: ExecutionClient;
  governance?: GovernanceClient;
  knownPlans: KnownPlansAdapter;
  version: string;
};

// v3 envelope — `status` is REQUIRED on every task response per
// core/protocol-envelope.json. On MCP, envelope fields are siblings of
// payload fields at the root of structuredContent (flat-on-wire convention).
const ADCP_VERSION = '3.1';

// Envelope fields every task input MAY carry per the v3 spec (version-envelope
// + idempotency_key + context). Tools accept and ignore them when not relevant.
const envelopeInput = {
  adcp_version: z.string().optional(),
  adcp_major_version: z.number().int().optional(),
  idempotency_key: z.string().optional(),
  context: z.unknown().optional(),
} as const;

type EnvelopeInput = {
  adcp_version?: string;
  idempotency_key?: string;
  context?: unknown;
};

function readEnvelope(args: unknown): EnvelopeInput {
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    const out: EnvelopeInput = {};
    if (typeof a.adcp_version === 'string') out.adcp_version = a.adcp_version;
    if (typeof a.idempotency_key === 'string') out.idempotency_key = a.idempotency_key;
    if (a.context !== undefined) out.context = a.context;
    return out;
  }
  return {};
}

// Build the v3 envelope — payload spreads FIRST so envelope fields always win
// at the root (a payload's own `status: "active"` from a seller media_buy must
// not collide with the task-status `completed` AAO grades against).
function ok<T extends object>(payload: T, env: EnvelopeInput = {}) {
  const envelope = {
    ...(payload as Record<string, unknown>),
    adcp_version: env.adcp_version ?? ADCP_VERSION,
    status: 'completed' as const,
    timestamp: new Date().toISOString(),
    ...(env.context !== undefined ? { context: env.context } : {}),
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as Record<string, unknown>,
  };
}

function err(message: string, code = 'orchestrator_error', env: EnvelopeInput = {}) {
  const envelope = {
    adcp_version: env.adcp_version ?? ADCP_VERSION,
    status: 'failed' as const,
    timestamp: new Date().toISOString(),
    adcp_error: { code, message },
    errors: [{ code, message, severity: 'error' as const }],
    ...(env.context !== undefined ? { context: env.context } : {}),
  };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${code}: ${message}` }],
    structuredContent: envelope as Record<string, unknown>,
  };
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({
    name: 'abzu-orchestrator',
    version: deps.version,
  });

  // 1. get_adcp_capabilities — protocol-level capability discovery (v3 envelope).
  // Schema: protocol/get-adcp-capabilities-response.json. The `adcp` object and
  // `supported_protocols` are required. Per-protocol blocks (media_buy, etc.) are
  // returned only when the protocol is in supported_protocols and (optionally)
  // requested by the input filter.
  server.registerTool(
    'get_adcp_capabilities',
    {
      description:
        'AdCP 3.1 protocol-level capability discovery for the Abzu buyer-side orchestrator. Returns the protocol envelope, the buyer composition contract Abzu enforces (loop invariants), the seller registry it composes over, and whether a governance agent is wired. Pass `protocols` to filter to specific protocol blocks.',
      inputSchema: {
        ...envelopeInput,
        protocols: z
          .array(z.enum(['media_buy', 'signals', 'governance', 'sponsored_intelligence', 'creative']))
          .optional(),
      },
    },
    async (args) => {
      const env = readEnvelope(args);
      const sellers = deps.discovery.listAgents();
      const requested = (args as { protocols?: string[] }).protocols;
      const orchestratorBlock = {
        agent: {
          name: 'abzu-orchestrator',
          version: deps.version,
          role: 'buyer-side orchestrator',
        },
        buyer_composition_contract: {
          gate_before_seller: true,
          conditions_acknowledgement_required: true,
          outcome_reported_on_every_buy: true,
          partial_failure_resilient: true,
          persistence: 'postgres',
        },
        sellers: sellers.map((s) => ({ id: s.id, name: s.name, agent_uri: s.agent_uri, tags: s.tags })),
        governance_configured: Boolean(deps.governance),
        execution_available: Boolean(deps.execution),
      };
      const all_protocols = ['media_buy', 'creative', 'governance'] as const;
      const filtered = requested ? all_protocols.filter((p) => requested.includes(p)) : all_protocols;
      const protocolBlocks: Record<string, unknown> = {};
      if (filtered.includes('media_buy')) {
        protocolBlocks.media_buy = {
          buying_modes: ['brief'],
          // Abzu orchestrates buyer-side fan-out; portfolio reflects sellers we route to.
          // Channels are seller-declared, not orchestrator-declared — omit primary_channels.
          portfolio: {
            publisher_domains: sellers.map((s) => new URL(s.agent_uri).hostname),
          },
        };
      }
      if (filtered.includes('creative')) {
        protocolBlocks.creative = {
          // Proxy-only — assets validate at the seller.
          orchestrator_proxy: true,
        };
      }
      if (filtered.includes('governance')) {
        protocolBlocks.governance = {
          governance_agent_configured: Boolean(deps.governance),
        };
      }
      return ok({
        adcp: {
          major_versions: [3],
          supported_versions: ['3.1'],
          idempotency: { supported: false },
        },
        supported_protocols: ['media_buy', 'creative', 'governance'],
        ...protocolBlocks,
        ext: {
          'rocketscience.pl': orchestratorBlock,
        },
      }, env);
    },
  );

  // 2. intake_brief — submit campaign brief, get ranked proposals
  server.registerTool(
    'intake_brief',
    {
      description:
        'Submit a campaign brief. The orchestrator fans out get_products in parallel across all configured sellers, scores returned products on 4 dimensions (format match, channel match, delivery match, brief response), and returns ranked proposals with per-seller diagnostics.',
      inputSchema: {
        ...envelopeInput,
        advertiser: z.object({ name: z.string(), domain: z.string().optional(), id: z.string().optional() }).passthrough(),
        brief: z.string(),
        budget: z.object({ amount: z.number(), currency: z.string() }).passthrough(),
        flight: z.object({ start: z.string(), end: z.string() }).passthrough(),
        channels: z.array(z.string()).optional(),
        formats: z.array(z.string()).optional(),
        audience: z.string().optional(),
        kpis: z.array(z.string()).optional(),
        top_n: z.number().int().optional(),
        time_budget_seconds: z.number().int().optional(),
      },
    },
    async (args) => {
      const env = readEnvelope(args);
      try {
        const intake = parseBrief(args);
        const plan = await deps.planning.planFromBrief(intake);
        return ok(plan, env);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 'invalid_brief', env);
      }
    },
  );

  // 3. register_plan — sync a governance plan (operator pre-flight)
  server.registerTool(
    'register_plan',
    {
      description:
        'Register one or more governance plans with the paired governance agent. Plans define budget authority, flight, brand, and reallocation threshold — all subsequent check_governance calls evaluate against the matching plan_id.',
      inputSchema: {
        ...envelopeInput,
        plans: z.array(z.object({ plan_id: z.string() }).passthrough()).min(1),
      },
    },
    async (args) => {
      const env = readEnvelope(args);
      if (!deps.governance) return err('governance not configured', 'not_configured', env);
      try {
        const out = await deps.governance.syncPlans((args as unknown as { plans: never }).plans);
        for (const p of (args as { plans: Array<{ plan_id?: string; brand?: { domain?: string } }> }).plans) {
          if (p?.plan_id) await deps.knownPlans.remember(p.plan_id, p.brand?.domain);
        }
        return ok(out, env);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 'sync_plans_failed', env);
      }
    },
  );

  // 4. execute_media_buy — full check → buy → outcome loop
  server.registerTool(
    'execute_media_buy',
    {
      description:
        'Execute a media buy through the full governance loop: pre-buy check_governance (hard gate on denied verdict), create_media_buy on the seller, report_plan_outcome to governance. Pass accept_conditions=true to acknowledge a conditions verdict.',
      inputSchema: {
        ...envelopeInput,
        seller_id: z.string(),
        plan_id: z.string(),
        account: z.union([z.object({ account_id: z.string() }), z.object({ brand: z.object({ domain: z.string() }).passthrough(), operator: z.string(), sandbox: z.boolean().optional() }).passthrough()]),
        brand: z.object({ domain: z.string() }).passthrough(),
        product_id: z.string(),
        pricing_option_id: z.string(),
        budget: z.number().positive(),
        currency: z.string(),
        flight: z.object({ start: z.string(), end: z.string() }).passthrough(),
        creative_ids: z.array(z.string()).optional(),
        accept_conditions: z.boolean().optional(),
      },
    },
    async (args) => {
      const env = readEnvelope(args);
      if (!deps.execution) return err('execution requires governance', 'governance_required', env);
      try {
        const intake = parseBuyIntake(args);
        const result = await deps.execution.executeBuy(intake);
        await deps.knownPlans.remember(intake.plan_id, intake.brand.domain);
        return ok(result, env);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : 'execution_failed';
        return err(message, code, env);
      }
    },
  );

  // 5. report_delivery — pull seller delivery snapshot → push to governance
  server.registerTool(
    'report_delivery',
    {
      description:
        'Pull get_media_buy_delivery from the seller, then post the snapshot to the governance agent via report_plan_outcome(outcome=delivery). Used for mid-flight delivery reporting.',
      inputSchema: {
        ...envelopeInput,
        seller_id: z.string(),
        media_buy_id: z.string(),
        plan_id: z.string(),
        governance_context: z.string(),
      },
    },
    async (args) => {
      const env = readEnvelope(args);
      if (!deps.execution) return err('execution requires governance', 'governance_required', env);
      try {
        const out = await deps.execution.pullDelivery(args as { seller_id: string; media_buy_id: string; plan_id: string; governance_context: string });
        return ok(out, env);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 'delivery_failed', env);
      }
    },
  );

  // 6. get_plan_audit — read the governance audit ledger
  server.registerTool(
    'get_plan_audit',
    {
      description:
        'Read the chronological governance audit ledger for one or more plans. Returns budget state, summary counts, and (when include_entries=true) the full check + outcome timeline with verdicts and findings.',
      inputSchema: {
        ...envelopeInput,
        plan_ids: z.array(z.string()).min(1),
        include_entries: z.boolean().optional(),
      },
    },
    async (args) => {
      const env = readEnvelope(args);
      if (!deps.governance) return err('governance not configured', 'not_configured', env);
      try {
        const out = await deps.governance.getAuditLogs(args as { plan_ids: string[]; include_entries?: boolean });
        return ok(out, env);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 'audit_failed', env);
      }
    },
  );

  // 7. list_plans — known plans registry (Abzu-side cache)
  server.registerTool(
    'list_plans',
    {
      description:
        "List plans Abzu has interacted with (via register_plan or execute_media_buy). Backed by Postgres when DATABASE_URL is configured. Useful for operators to discover plan_ids they've previously synced.",
      inputSchema: { ...envelopeInput },
    },
    async (args) => {
      const env = readEnvelope(args);
      try {
        const plans = await deps.knownPlans.list();
        return ok({ plans }, env);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 'list_plans_failed', env);
      }
    },
  );

  // 8. list_sellers — registry of sellers Abzu can compose with
  server.registerTool(
    'list_sellers',
    {
      description:
        'List the seller agents configured in this orchestrator. Each entry carries id, public agent_uri, protocol, and tags (countries, categories, languages).',
      inputSchema: { ...envelopeInput },
    },
    async (args) => {
      const env = readEnvelope(args);
      const agents = deps.discovery.listAgents().map((s) => ({
        id: s.id,
        name: s.name,
        agent_uri: s.agent_uri,
        protocol: s.protocol,
        tags: s.tags,
      }));
      return ok({ agents }, env);
    },
  );

  // 9. get_seller_capabilities — proxy a seller's get_adcp_capabilities + creative formats
  server.registerTool(
    'get_seller_capabilities',
    {
      description:
        'Fetch a seller agent capabilities via get_adcp_capabilities. Cached per-agent for ~5 min. Use to verify a seller before sending a brief.',
      inputSchema: {
        ...envelopeInput,
        seller_id: z.string(),
      },
    },
    async (args) => {
      const env = readEnvelope(args);
      try {
        const caps = await deps.discovery.getCapabilities((args as { seller_id: string }).seller_id);
        return ok(caps, env);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 'capabilities_failed', env);
      }
    },
  );

  // 10. sync_creatives_proxy — passthrough sync_creatives to a chosen seller
  server.registerTool(
    'sync_creatives_proxy',
    {
      description:
        "Proxy creative payload to a chosen seller via sync_creatives. The orchestrator validates the top-level shape (seller_id, account, creatives[]) and adds an idempotency_key if missing. Per-asset validation is the seller's responsibility.",
      inputSchema: {
        ...envelopeInput,
        seller_id: z.string(),
        account: z.unknown(),
        creatives: z.array(z.object({ creative_id: z.string(), name: z.string() }).passthrough()).min(1),
        dry_run: z.boolean().optional(),
      },
    },
    async (args) => {
      const env = readEnvelope(args);
      try {
        const input = parseCreativeSync(args);
        const out = await deps.creative.sync(input);
        return ok(out, env);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 'creative_sync_failed', env);
      }
    },
  );

  // 11. list_creative_status — proxy list_creatives status check
  server.registerTool(
    'list_creative_status',
    {
      description:
        "Read creative statuses from a chosen seller. Use after sync_creatives_proxy to poll the lifecycle (processing → pending_review → approved). Filter by creative_ids or statuses.",
      inputSchema: {
        ...envelopeInput,
        seller_id: z.string(),
        creative_ids: z.array(z.string()).optional(),
        statuses: z.array(z.enum(['processing', 'pending_review', 'approved', 'suspended', 'rejected', 'archived'])).optional(),
      },
    },
    async (args) => {
      const env = readEnvelope(args);
      try {
        const query = parseStatusQuery(args);
        const out = await deps.creative.status(query);
        return ok(out, env);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e), 'creative_status_failed', env);
      }
    },
  );

  return server;
}

// Stateless MCP: SDK refuses to reuse a transport across requests. Each call
// gets a fresh transport+server pair. The build is cheap (no I/O) and isolates
// requests cleanly.
export async function handleMcpRequest(req: Request, deps: McpDeps): Promise<Response> {
  const server = buildMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await transport.close().catch(() => {});
  }
}
