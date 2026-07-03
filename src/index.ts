import { resolve } from 'node:path';
import { loadEnv } from './env.ts';
import { log } from './observability/logger.ts';
import { extractIssues } from './observability/issues.ts';
import {
  CreativeError,
  createOrchestrator,
  DiscoveryError,
  ExecutionError,
} from './orchestrator/index.ts';
import { loadSellers } from './orchestrator/sellers.ts';
import { loadSignalsAgents, type SignalsAgentConfig } from './orchestrator/signals-config.ts';
import { parseBrief } from './strategy/brief.ts';
import { parseBuyIntake } from './strategy/buy.ts';
import { parseCreativeSync, parseStatusQuery } from './strategy/creative.ts';
import { createGovernanceClient, GovernanceError, KnownPlans, type KnownPlansAdapter } from './governance/client.ts';
import { createPostgresKnownPlans } from './governance/db.ts';
import { handleMcpRequest, type McpDeps } from './mcp/server.ts';
import { createOAuthVerifier } from './oauth.ts';

const env = loadEnv();

const sellersPath = resolve(env.SELLERS_CONFIG_PATH);
const sellers = loadSellers(sellersPath);
log.info('sellers loaded', { path: sellersPath, count: sellers.length });

let signalsAgents: SignalsAgentConfig[] = [];
try {
  const signalsPath = resolve(env.SIGNALS_CONFIG_PATH);
  signalsAgents = loadSignalsAgents(signalsPath);
  log.info('signals agents loaded', { path: signalsPath, count: signalsAgents.length });
} catch (err) {
  log.info('signals agents not configured', {
    reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
  });
}

const governance = createGovernanceClient(
  env.GOVERNANCE_AGENT_URI
    ? {
        id: 'governance',
        agent_uri: env.GOVERNANCE_AGENT_URI,
        protocol: 'mcp',
        ...(env.GOVERNANCE_AUTH_TOKEN ? { auth_token: env.GOVERNANCE_AUTH_TOKEN } : {}),
      }
    : undefined,
);
if (governance) {
  log.info('governance wired', governance.describe());
} else {
  log.info('governance not configured (set GOVERNANCE_AGENT_URI to enable)');
}

const { discovery, planning, creative, execution, signals: signalsClient } = createOrchestrator(
  sellers,
  { formatsTtlMs: env.DISCOVERY_FORMATS_TTL_MS },
  governance,
  signalsAgents,
);

const knownPlans: KnownPlansAdapter = env.DATABASE_URL
  ? await createPostgresKnownPlans(env.DATABASE_URL)
  : new KnownPlans();
log.info('known_plans store', { backend: env.DATABASE_URL ? 'postgres' : 'in-memory' });

const DISCOVERY_AGENT_RE = /^\/discovery\/agents\/([^/]+)(?:\/(capabilities|formats|publisher-domains))?\/?$/;

const BRANDS_CACHE_TTL_MS = 5 * 60 * 1000;
const brandsCache = new Map<string, { at: number; data: Array<{ domain: string; name: string }> }>();
const BRAND_RESOLVE_TTL_MS = 30 * 60 * 1000;
const brandResolveCache = new Map<string, { at: number; data: Record<string, unknown> }>();

function publicSellerView(s: ReturnType<typeof discovery.listAgents>[number]) {
  return {
    id: s.id,
    name: s.name,
    agent_uri: s.agent_uri,
    protocol: s.protocol,
    tags: s.tags,
  };
}

function notFound() {
  return new Response('not found', { status: 404 });
}

function mapDiscoveryError(err: DiscoveryError, agentId: string): Response {
  log.warn('discovery error', { agentId, code: err.code, message: err.message });
  if (err.code === 'agent_not_found') {
    return Response.json({ error: err.message, code: err.code }, { status: 404 });
  }
  return Response.json({ error: err.message, code: err.code }, { status: 502 });
}

function mapCreativeError(err: CreativeError, agentId: string): Response {
  log.warn('creative error', { agentId, code: err.code, message: err.message });
  if (err.code === 'agent_not_found') {
    return Response.json({ error: err.message, code: err.code }, { status: 404 });
  }
  return Response.json({ error: err.message, code: err.code }, { status: 502 });
}

function mapGovernanceError(err: GovernanceError): Response {
  log.warn('governance error', { code: err.code, message: err.message });
  if (err.code === 'not_configured') {
    return Response.json({ error: err.message, code: err.code }, { status: 503 });
  }
  return Response.json({ error: err.message, code: err.code }, { status: 502 });
}

function requireGovernance() {
  if (!governance) {
    return Response.json(
      {
        error: 'governance not configured (set GOVERNANCE_AGENT_URI)',
        code: 'not_configured',
      },
      { status: 503 },
    );
  }
  return null;
}

function mapExecutionError(err: ExecutionError): Response {
  log.warn('execution error', { code: err.code, message: err.message, detail: err.detail });
  if (err.code === 'agent_not_found') {
    return Response.json({ error: err.message, code: err.code, detail: err.detail }, { status: 404 });
  }
  if (err.code === 'governance_denied' || err.code === 'conditions_not_accepted') {
    return Response.json({ error: err.message, code: err.code, detail: err.detail }, { status: 409 });
  }
  return Response.json({ error: err.message, code: err.code, detail: err.detail }, { status: 502 });
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-creative-trust-key',
  'access-control-max-age': '600',
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const mcpDeps: McpDeps = {
  discovery,
  planning,
  creative,
  ...(execution ? { execution } : {}),
  ...(governance ? { governance } : {}),
  knownPlans,
  version: env.VERSION,
};
const verifyJwt = createOAuthVerifier({
  issuer: env.OAUTH_ISSUER,
  jwks_uri: env.OAUTH_JWKS_URI,
  audience: env.OAUTH_AUDIENCE,
});

async function verifyAuth(header: string | null): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!header || !header.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Missing bearer token.' };
  }
  const token = header.substring('Bearer '.length).trim();
  // Static fallback: identical to the value in ABZU_ORCHESTRATOR_AUTH_TOKEN.
  // Matches first to short-circuit JWKS lookups for AAO's hot path.
  if (env.ABZU_ORCHESTRATOR_AUTH_TOKEN && token === env.ABZU_ORCHESTRATOR_AUTH_TOKEN) {
    return { ok: true };
  }
  // JWT path — JWKS-verified, audience-checked, issuer-checked.
  const verified = await verifyJwt(header);
  if ('error' in verified) {
    return { ok: false, status: verified.status, error: verified.error };
  }
  return { ok: true };
}

log.info('mcp wired', {
  path: '/mcp',
  auth_modes: [
    'rs256_jwt',
    ...(env.ABZU_ORCHESTRATOR_AUTH_TOKEN ? ['static_bearer'] : []),
  ],
  issuer: env.OAUTH_ISSUER,
  audience: env.OAUTH_AUDIENCE,
});

const server = Bun.serve({
  port: env.PORT,
  hostname: env.HOST,
  idleTimeout: 60,
  async fetch(req) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(req.url);
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      const verified = await verifyAuth(req.headers.get('authorization'));
      if (!verified.ok) {
        return withCors(
          Response.json(
            { error: 'invalid_token', error_description: verified.error },
            { status: verified.status },
          ),
        );
      }
      const mcpResponse = await handleMcpRequest(req, mcpDeps);
      return withCors(mcpResponse);
    }
    const response = await handle(req);
    return withCors(response);
  },
});

/* MCP webhook receiver — implements the buyer/orchestrator side of the
 * webhook_receiver_envelope compliance storyboard. Accepts MCP webhook
 * envelopes, rejects bare inner results, dedupes retries by a stable
 * idempotency_key. Signature verification is out of scope until the
 * storyboard runner registers a signing key here; envelope-shape errors
 * already surface the failing checks. */
const ABZU_WEBHOOK_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const abzuWebhookSeen = new Map<string, number>();
const ABZU_TASK_STATUS_ENUM = new Set([
  'submitted', 'working', 'input_required', 'completed', 'canceled', 'failed',
  'auth_required', 'rejected', 'partial', 'processing', 'pending',
]);

async function handleAdcpWebhook(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json', message: 'Request body must be JSON.' }, { status: 400 });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return Response.json({ ok: false, error: 'invalid_envelope', message: 'Body must be a JSON object.' }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;
  const hasEnvelopeMarkers = ['idempotency_key', 'operation_id', 'task_id', 'task_type'].some((k) => k in body);
  if (!hasEnvelopeMarkers) {
    return Response.json({
      ok: false,
      error: 'missing_envelope_fields',
      message: 'Body is not an MCP webhook envelope. Expected top-level idempotency_key, operation_id, task_id, task_type, status, timestamp, and result.',
      missing_fields: ['idempotency_key', 'operation_id', 'task_id', 'task_type', 'status', 'timestamp'],
    }, { status: 400 });
  }
  const idempotencyKey = body['idempotency_key'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    return Response.json({
      ok: false,
      error: 'missing_idempotency_key',
      message: 'MCP webhook envelope requires a non-empty idempotency_key so the receiver can safely dedupe retries.',
    }, { status: 400 });
  }
  const status = body['status'];
  if (typeof status !== 'string' || !ABZU_TASK_STATUS_ENUM.has(status)) {
    return Response.json({
      ok: false,
      error: 'invalid_envelope_status',
      message: 'Top-level status must be a task-status enum value. Media buy lifecycle values (e.g. active) belong under result.media_buy_deliveries[].status.',
      received_status: status,
      allowed_task_statuses: [...ABZU_TASK_STATUS_ENUM],
    }, { status: 400 });
  }
  const missing: string[] = [];
  for (const k of ['operation_id', 'task_id', 'task_type', 'timestamp'] as const) {
    if (typeof body[k] !== 'string' || (body[k] as string).length === 0) missing.push(k);
  }
  if (missing.length > 0) {
    return Response.json(
      { ok: false, error: 'missing_envelope_fields', message: `Envelope missing required fields: ${missing.join(', ')}.`, missing_fields: missing },
      { status: 400 },
    );
  }
  // Bounded map prune: drop entries older than the TTL window.
  const cutoff = Date.now() - ABZU_WEBHOOK_DEDUP_TTL_MS;
  for (const [k, ts] of abzuWebhookSeen) if (ts < cutoff) abzuWebhookSeen.delete(k);
  const alreadySeen = abzuWebhookSeen.has(idempotencyKey);
  abzuWebhookSeen.set(idempotencyKey, Date.now());
  return Response.json({
    ok: true,
    accepted: true,
    duplicate: alreadySeen,
    idempotency_key: idempotencyKey,
    task_type: body['task_type'],
    task_id: body['task_id'],
  }, { status: 200 });
}

async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/healthz') {
      return Response.json({ status: 'ok', agent: 'abzu', version: env.VERSION });
    }

    if (path === '/webhooks/adcp' && req.method === 'POST') {
      return handleAdcpWebhook(req);
    }
    if (path === '/') {
      return Response.json({
        agent: 'abzu',
        role: 'orchestrator',
        version: env.VERSION,
        adcp_sdk: '9.0.0',
        sellers: sellers.length,
      });
    }
    if (path === '/discovery/agents') {
      return Response.json({ agents: discovery.listAgents().map(publicSellerView) });
    }

    if (path === '/discovery/signals/agents') {
      const agents = signalsClient?.listAgents() ?? [];
      return Response.json({
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          agent_uri: a.agent_uri,
          protocol: a.protocol,
          tags: a.tags,
        })),
      });
    }

    if (path === '/discovery/signals' && req.method === 'POST') {
      if (!signalsClient) {
        return Response.json(
          { error: 'signals fan-out not configured', code: 'signals_not_configured' },
          { status: 503 },
        );
      }
      let payload: unknown;
      try { payload = await req.json(); } catch {
        return Response.json({ error: 'invalid_json' }, { status: 400 });
      }
      const p = (payload ?? {}) as {
        brief?: string;
        deliver_to?: { platforms?: unknown; countries?: unknown };
        top_n?: number;
        time_budget_ms?: number;
      };
      if (typeof p.brief !== 'string' || p.brief.trim().length === 0) {
        return Response.json(
          { error: 'brief is required', code: 'validation_failed' },
          { status: 400 },
        );
      }
      try {
        const out = await signalsClient.discover({
          brief: p.brief.trim(),
          ...(p.deliver_to && { deliver_to: p.deliver_to as { platforms?: 'all' | ReadonlyArray<string>; countries?: ReadonlyArray<string> } }),
          ...(typeof p.top_n === 'number' && { top_n: p.top_n }),
          ...(typeof p.time_budget_ms === 'number' && { time_budget_ms: p.time_budget_ms }),
        });
        return Response.json(out);
      } catch (err) {
        log.error('signals discovery failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'signals_discovery_failed' }, { status: 500 });
      }
    }

    if (path === '/discovery/signals/activate' && req.method === 'POST') {
      if (!signalsClient) {
        return Response.json(
          { error: 'signals fan-out not configured', code: 'signals_not_configured' },
          { status: 503 },
        );
      }
      let payload: unknown;
      try { payload = await req.json(); } catch {
        return Response.json({ error: 'invalid_json' }, { status: 400 });
      }
      const p = (payload ?? {}) as {
        agent_id?: string;
        signal_agent_segment_id?: string;
        destinations?: unknown;
        action?: 'activate' | 'deactivate';
        pricing_option_id?: string;
        account?: unknown;
        time_budget_ms?: number;
      };
      if (typeof p.agent_id !== 'string' || p.agent_id.trim().length === 0) {
        return Response.json({ error: 'agent_id is required', code: 'validation_failed' }, { status: 400 });
      }
      if (typeof p.signal_agent_segment_id !== 'string' || p.signal_agent_segment_id.trim().length === 0) {
        return Response.json({ error: 'signal_agent_segment_id is required', code: 'validation_failed' }, { status: 400 });
      }
      if (!Array.isArray(p.destinations) || p.destinations.length === 0) {
        return Response.json({ error: 'destinations[] required', code: 'validation_failed' }, { status: 400 });
      }
      const out = await signalsClient.activate({
        agent_id: p.agent_id.trim(),
        signal_agent_segment_id: p.signal_agent_segment_id.trim(),
        destinations: p.destinations as never,
        ...(p.action && { action: p.action }),
        ...(p.pricing_option_id && { pricing_option_id: p.pricing_option_id }),
        ...(p.account && typeof p.account === 'object' ? { account: p.account as never } : {}),
        ...(typeof p.time_budget_ms === 'number' && { time_budget_ms: p.time_budget_ms }),
      });
      return Response.json(out);
    }

    // Warmup fan-out — abzu-gui fires this on Sam view load so every
    // downstream agent's Fly machine gets a wake-up ping before the buyer
    // clicks Discover / Generate / Execute. Fire-and-forget: we don't
    // block on responses, just hit /.well-known/healthz on each host and
    // return immediately with the list attempted. Removes the cold-start
    // TIMEOUT that plagued the demo's first click after idle.
    if (path === '/warmup' && req.method === 'POST') {
      const targets = [
        'https://seller.purrsonality.rocketscience.pl/.well-known/healthz',
        'https://signals.purrsonality.rocketscience.pl/.well-known/healthz',
        'https://governance.rocketscience.pl/.well-known/healthz',
        ...(env.CREATIVE_AGENT_URI
          ? [`${env.CREATIVE_AGENT_URI.replace(/\/$/, '')}/healthz`]
          : []),
      ];
      for (const url of targets) {
        // Detached, timeout short — the only goal is to trigger Fly's
        // wake path; the actual response is discarded. Errors on cold
        // TCP are expected (proxy returns 502 before wake completes),
        // second wake attempt not needed — the demo's real click comes
        // seconds later and will hit the woken machine.
        void fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => {});
      }
      return Response.json({ ok: true, warmed: targets });
    }

    // Proxy to the creative-generative agent. Two endpoints keep the wire
    // simple: /creative/order fires build_creative, /creative/status/:id
    // polls the async task. Bearer for the creative agent lives server-side
    // (env.CREATIVE_AGENT_AUTH_TOKEN); the trust-key gate is a per-call
    // header the caller forwards through — we pipe X-Creative-Trust-Key
    // straight to the agent, we don't inspect or store it. When
    // CREATIVE_AGENT_URI isn't set the endpoints reply 503 so the GUI can
    // hide the button cleanly.
    if (path === '/creative/order' && req.method === 'POST') {
      if (!env.CREATIVE_AGENT_URI || !env.CREATIVE_AGENT_AUTH_TOKEN) {
        return Response.json({ error: 'creative agent not configured', code: 'creative_disabled' }, { status: 503 });
      }
      let body: unknown;
      try { body = await req.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
      const target = `${env.CREATIVE_AGENT_URI.replace(/\/$/, '')}/build`;
      const trustKey = req.headers.get('x-creative-trust-key');
      try {
        const fwd = await fetch(target, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.CREATIVE_AGENT_AUTH_TOKEN}`,
            'content-type': 'application/json',
            ...(trustKey ? { 'x-creative-trust-key': trustKey } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await fwd.text();
        return new Response(text, {
          status: fwd.status,
          headers: { 'content-type': fwd.headers.get('content-type') ?? 'application/json' },
        });
      } catch (err) {
        log.error('creative proxy failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'creative_unreachable' }, { status: 502 });
      }
    }

    const creativeStatusMatch = path.match(/^\/creative\/status\/([A-Za-z0-9_-]+)$/);
    if (creativeStatusMatch && req.method === 'GET') {
      if (!env.CREATIVE_AGENT_URI || !env.CREATIVE_AGENT_AUTH_TOKEN) {
        return Response.json({ error: 'creative agent not configured', code: 'creative_disabled' }, { status: 503 });
      }
      const taskId = creativeStatusMatch[1]!;
      const target = `${env.CREATIVE_AGENT_URI.replace(/\/$/, '')}/tasks/${encodeURIComponent(taskId)}`;
      try {
        const fwd = await fetch(target, {
          method: 'GET',
          headers: { authorization: `Bearer ${env.CREATIVE_AGENT_AUTH_TOKEN}` },
          signal: AbortSignal.timeout(10_000),
        });
        const text = await fwd.text();
        return new Response(text, {
          status: fwd.status,
          headers: { 'content-type': fwd.headers.get('content-type') ?? 'application/json' },
        });
      } catch (err) {
        log.error('creative status proxy failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'creative_unreachable' }, { status: 502 });
      }
    }

    if (path === '/execution/buy' && req.method === 'POST') {
      if (!execution) {
        return Response.json(
          { error: 'execution requires governance (set GOVERNANCE_AGENT_URI)', code: 'governance_required' },
          { status: 503 },
        );
      }
      let payload: unknown;
      try { payload = await req.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
      let intake;
      try {
        intake = parseBuyIntake(payload);
      } catch (err) {
        return Response.json(
          { error: 'invalid_buy', code: 'validation_failed', issues: extractIssues(err) },
          { status: 400 },
        );
      }
      try {
        const result = await execution.executeBuy(intake);
        await knownPlans.remember(intake.plan_id, intake.brand.domain);
        return Response.json(result);
      } catch (err) {
        if (err instanceof ExecutionError) return mapExecutionError(err);
        log.error('execution failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'execution_failed' }, { status: 500 });
      }
    }

    if (path === '/execution/delivery' && req.method === 'POST') {
      if (!execution) {
        return Response.json(
          { error: 'execution requires governance (set GOVERNANCE_AGENT_URI)', code: 'governance_required' },
          { status: 503 },
        );
      }
      let payload: unknown;
      try { payload = await req.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
      const body = payload as { seller_id?: unknown; media_buy_id?: unknown; plan_id?: unknown; governance_context?: unknown };
      if (
        typeof body.seller_id !== 'string' ||
        typeof body.media_buy_id !== 'string' ||
        typeof body.plan_id !== 'string' ||
        typeof body.governance_context !== 'string'
      ) {
        return Response.json(
          { error: 'missing or invalid fields (need seller_id, media_buy_id, plan_id, governance_context)' },
          { status: 400 },
        );
      }
      try {
        const out = await execution.pullDelivery({
          seller_id: body.seller_id,
          media_buy_id: body.media_buy_id,
          plan_id: body.plan_id,
          governance_context: body.governance_context,
        });
        return Response.json(out);
      } catch (err) {
        if (err instanceof ExecutionError) return mapExecutionError(err);
        log.error('delivery pull failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'delivery_failed' }, { status: 500 });
      }
    }

    if (path === '/governance/plans' && req.method === 'GET') {
      const blocked = requireGovernance();
      if (blocked) return blocked;
      return Response.json({ plans: await knownPlans.list() });
    }

    if (path === '/governance/plans' && req.method === 'POST') {
      const blocked = requireGovernance();
      if (blocked) return blocked;
      let payload: unknown;
      try { payload = await req.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
      const plans = (payload as { plans?: unknown[] })?.plans;
      if (!Array.isArray(plans) || plans.length === 0) {
        return Response.json({ error: 'missing or empty plans[]' }, { status: 400 });
      }
      try {
        const out = await governance!.syncPlans(plans as never);
        for (const p of plans as Array<{ plan_id?: string; brand?: { domain?: string } }>) {
          if (p?.plan_id) await knownPlans.remember(p.plan_id, p.brand?.domain);
        }
        return Response.json(out);
      } catch (err) {
        if (err instanceof GovernanceError) return mapGovernanceError(err);
        log.error('governance syncPlans failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'sync_plans_failed' }, { status: 500 });
      }
    }

    if (path === '/governance/check' && req.method === 'POST') {
      const blocked = requireGovernance();
      if (blocked) return blocked;
      let payload: unknown;
      try { payload = await req.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
      try {
        const out = await governance!.checkGovernance(payload as never);
        return Response.json(out);
      } catch (err) {
        if (err instanceof GovernanceError) return mapGovernanceError(err);
        log.error('governance check failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'check_failed' }, { status: 500 });
      }
    }

    if (path === '/governance/outcome' && req.method === 'POST') {
      const blocked = requireGovernance();
      if (blocked) return blocked;
      let payload: unknown;
      try { payload = await req.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
      try {
        const out = await governance!.reportOutcome(payload as never);
        return Response.json(out);
      } catch (err) {
        if (err instanceof GovernanceError) return mapGovernanceError(err);
        log.error('governance outcome failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'outcome_failed' }, { status: 500 });
      }
    }

    if (path === '/governance/audit' && req.method === 'GET') {
      const blocked = requireGovernance();
      if (blocked) return blocked;
      const planIds = url.searchParams.get('plan_ids');
      const includeEntries = url.searchParams.get('include_entries') === 'true';
      if (!planIds) {
        return Response.json({ error: 'plan_ids query param required' }, { status: 400 });
      }
      try {
        const out = await governance!.getAuditLogs({
          plan_ids: planIds.split(',').filter(Boolean),
          ...(includeEntries ? { include_entries: true } : {}),
        });
        return Response.json(out);
      } catch (err) {
        if (err instanceof GovernanceError) return mapGovernanceError(err);
        log.error('governance audit failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'audit_failed' }, { status: 500 });
      }
    }

    if (path === '/creatives/sync' && req.method === 'POST') {
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        return Response.json({ error: 'invalid_json' }, { status: 400 });
      }
      let input;
      try {
        input = parseCreativeSync(payload);
      } catch (err) {
        return Response.json(
          { error: 'invalid_payload', code: 'validation_failed', issues: extractIssues(err) },
          { status: 400 },
        );
      }
      try {
        const outcome = await creative.sync(input);
        // Optional side-effect: attach the just-synced creatives to a
        // media_buy via update_media_buy. Without this the seller's ad
        // server has no way to attribute served impressions to the caller's
        // buy — getMediaBuyDelivery returns zeros. GUI opts in by passing
        // assign_to_media_buy_id after a successful /execution/buy.
        const assignBuyId = (payload as { assign_to_media_buy_id?: string })?.assign_to_media_buy_id;
        if (assignBuyId && outcome.status === 'completed') {
          const creativeIds = outcome.creatives
            .map((c) => c.creative_id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          if (creativeIds.length > 0) {
            try {
              const assignRes = await creative.assignToBuy({
                seller_id: input.seller_id,
                media_buy_id: assignBuyId,
                creative_ids: creativeIds,
                account: input.account,
              });
              (outcome as Record<string, unknown>).assignment = assignRes;
            } catch (err) {
              (outcome as Record<string, unknown>).assignment = {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }
        }
        return Response.json(outcome);
      } catch (err) {
        if (err instanceof CreativeError) return mapCreativeError(err, input.seller_id);
        log.error('creative sync failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'sync_failed' }, { status: 500 });
      }
    }

    if (path === '/creatives/status' && req.method === 'GET') {
      const sellerId = url.searchParams.get('seller_id') ?? '';
      const creativeIds = url.searchParams.get('creative_ids');
      const statuses = url.searchParams.get('statuses');
      let query;
      try {
        query = parseStatusQuery({
          seller_id: sellerId,
          creative_ids: creativeIds ? creativeIds.split(',').filter(Boolean) : [],
          statuses: statuses ? statuses.split(',').filter(Boolean) : [],
        });
      } catch (err) {
        return Response.json(
          { error: 'invalid_query', code: 'validation_failed', issues: extractIssues(err) },
          { status: 400 },
        );
      }
      try {
        const outcome = await creative.status(query);
        return Response.json(outcome);
      } catch (err) {
        if (err instanceof CreativeError) return mapCreativeError(err, query.seller_id);
        log.error('creative status failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'status_failed' }, { status: 500 });
      }
    }

    // Operator-side seller review proxy. The abzu-gui Operator tab reads the
    // seller's creative review queue + approves/rejects without holding the
    // seller's Bearer in the browser. Currently single-seller (purrsonality);
    // generalize to per-seller pathing if/when there's a second reviewable
    // seller in sellers.json.
    if (path.startsWith('/seller/creatives')) {
      const sellerCfg = sellers[0]!;
      const sellerBase = sellerCfg.agent_uri.replace(/\/mcp\/?$/, '');
      const sellerAuth = sellerCfg.auth_token;
      if (!sellerAuth) {
        return Response.json(
          { error: 'seller_auth_missing', message: 'configure SELLER_PURRSONALITY_SELLER_AUTH_TOKEN' },
          { status: 503 },
        );
      }
      const sub = path.slice('/seller/creatives'.length);
      const target = `${sellerBase}/api/creatives${sub}${url.search}`;
      try {
        const fwd = await fetch(target, {
          method: req.method,
          headers: {
            authorization: `Bearer ${sellerAuth}`,
            ...(req.method !== 'GET' && req.method !== 'HEAD' && req.body
              ? { 'content-type': req.headers.get('content-type') ?? 'application/json' }
              : {}),
          },
          ...(req.method !== 'GET' && req.method !== 'HEAD' && req.body
            ? { body: await req.text() }
            : {}),
        });
        const text = await fwd.text();
        return new Response(text, {
          status: fwd.status,
          headers: {
            'content-type': fwd.headers.get('content-type') ?? 'application/json',
          },
        });
      } catch (err) {
        log.error('seller proxy failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'seller_unreachable' }, { status: 502 });
      }
    }

    // Resolve a brand by domain — server-side fetches /.well-known/brand.json
    // off the brand's own origin. Avoids the CORS dance the GUI would hit if
    // it tried this from the browser, and lets the orchestrator log the lookup
    // in audit later. AdCP brand.json shape: { name, tagline, url, categories,
    // audience, brand_safety } — see adcontextprotocol.org/docs/brand-protocol.
    if (path === '/brand-resolve' && req.method === 'GET') {
      const rawDomain = (url.searchParams.get('domain') ?? '').trim().toLowerCase();
      const domain = rawDomain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
        return Response.json({ error: 'invalid_domain' }, { status: 400 });
      }
      const cached = brandResolveCache.get(domain);
      const now = Date.now();
      if (cached && now - cached.at < BRAND_RESOLVE_TTL_MS) {
        return Response.json(cached.data, { headers: { 'cache-control': 'no-store' } });
      }
      const targets = [
        `https://${domain}/.well-known/brand.json`,
        `https://www.${domain}/.well-known/brand.json`,
      ];
      for (const target of targets) {
        try {
          const fwd = await fetch(target, {
            redirect: 'follow',
            signal: AbortSignal.timeout(4000),
            headers: { accept: 'application/json' },
          });
          if (!fwd.ok) continue;
          const json = (await fwd.json()) as Record<string, unknown>;
          const result = {
            found: true,
            source: target,
            domain,
            name: typeof json.name === 'string' ? json.name : null,
            tagline: typeof json.tagline === 'string' ? json.tagline : null,
            url: typeof json.url === 'string' ? json.url : null,
            categories: Array.isArray(json.categories) ? json.categories : [],
            audience: (json.audience as Record<string, unknown>) ?? null,
            brand_safety: (json.brand_safety as Record<string, unknown>) ?? null,
          };
          brandResolveCache.set(domain, { at: now, data: result });
          return Response.json(result, { headers: { 'cache-control': 'no-store' } });
        } catch {
          // try the next target
        }
      }
      const empty = { found: false, domain };
      brandResolveCache.set(domain, { at: now, data: empty });
      return Response.json(empty, { headers: { 'cache-control': 'no-store' } });
    }

    if (path === '/brands' && req.method === 'GET') {
      const search = (url.searchParams.get('search') ?? '').trim();
      const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
      const limit = Math.min(50, Math.max(1, Number.isNaN(limitRaw) ? 20 : limitRaw));
      if (!env.AAO_BEARER_TOKEN) {
        return Response.json(
          { error: 'aao_unconfigured', message: 'AAO_BEARER_TOKEN not set' },
          { status: 503 },
        );
      }
      const cacheKey = `${search}::${limit}`;
      const cached = brandsCache.get(cacheKey);
      const now = Date.now();
      if (cached && now - cached.at < BRANDS_CACHE_TTL_MS) {
        return Response.json({ brands: cached.data, cached: true });
      }
      try {
        const aaoRes = await fetch('https://agenticadvertising.org/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${env.AAO_BEARER_TOKEN}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'list_brands',
              arguments: { limit, ...(search ? { search } : {}) },
            },
          }),
        });
        if (!aaoRes.ok) {
          log.warn('aao brands proxy http error', { status: aaoRes.status });
          return Response.json({ error: 'aao_error', status: aaoRes.status }, { status: 502 });
        }
        const json = (await aaoRes.json()) as {
          result?: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
          error?: unknown;
        };
        if (json.error) {
          log.warn('aao brands proxy mcp error', { err: JSON.stringify(json.error) });
          return Response.json({ error: 'aao_error', detail: json.error }, { status: 502 });
        }
        let brandsRaw: unknown = [];
        const structured = json.result?.structuredContent as { brands?: unknown[] } | undefined;
        if (structured?.brands && Array.isArray(structured.brands)) {
          brandsRaw = structured.brands;
        } else if (Array.isArray(json.result?.content)) {
          const textBlock = json.result.content.find((c) => c?.type === 'text')?.text;
          if (textBlock) {
            try {
              const parsed = JSON.parse(textBlock) as { brands?: unknown[] } | unknown[];
              brandsRaw = Array.isArray(parsed) ? parsed : (parsed?.brands ?? []);
            } catch {
              brandsRaw = [];
            }
          }
        }
        const brands = Array.isArray(brandsRaw)
          ? brandsRaw
              .map((b) => {
                const obj = b as { domain?: string; brand_name?: string; name?: string };
                return { domain: obj.domain ?? '', name: obj.brand_name ?? obj.name ?? obj.domain ?? '' };
              })
              .filter((b) => b.domain.length > 0)
          : [];
        brandsCache.set(cacheKey, { at: now, data: brands });
        return Response.json({ brands });
      } catch (err) {
        log.error('aao brands proxy exception', {
          err: err instanceof Error ? err.message : String(err),
        });
        return Response.json({ error: 'aao_unreachable' }, { status: 502 });
      }
    }

    if (path === '/planning/brief' && req.method === 'POST') {
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        return Response.json({ error: 'invalid_json' }, { status: 400 });
      }
      let brief;
      try {
        brief = parseBrief(payload);
      } catch (err) {
        return Response.json(
          { error: 'invalid_brief', code: 'validation_failed', issues: extractIssues(err) },
          { status: 400 },
        );
      }
      try {
        const plan = await planning.planFromBrief(brief);
        return Response.json(plan);
      } catch (err) {
        log.error('planning failed', { err: err instanceof Error ? err.message : String(err) });
        return Response.json({ error: 'planning_failed' }, { status: 500 });
      }
    }

    const match = DISCOVERY_AGENT_RE.exec(path);
    if (match) {
      const [, rawAgentId, action] = match;
      const agentId = decodeURIComponent(rawAgentId!);
      try {
        if (!action) {
          if (!discovery.hasAgent(agentId)) {
            return Response.json({ error: `unknown agent: ${agentId}`, code: 'agent_not_found' }, { status: 404 });
          }
          const agent = discovery.listAgents().find((s) => s.id === agentId)!;
          return Response.json({ agent: publicSellerView(agent) });
        }
        if (action === 'capabilities') {
          const caps = await discovery.getCapabilities(agentId);
          return Response.json(caps);
        }
        if (action === 'formats') {
          const formats = await discovery.getCreativeFormats(agentId);
          return Response.json({ count: formats.length, formats });
        }
        if (action === 'publisher-domains') {
          const domains = await discovery.getPublisherDomains(agentId);
          return Response.json({ count: domains.length, publisher_domains: domains });
        }
      } catch (err) {
        if (err instanceof DiscoveryError) return mapDiscoveryError(err, agentId);
        log.error('unexpected discovery failure', {
          agentId,
          err: err instanceof Error ? err.message : String(err),
        });
        return Response.json({ error: 'internal error' }, { status: 500 });
      }
    }

    return notFound();
}

log.info('abzu listening', { url: `http://${server.hostname}:${server.port}` });
