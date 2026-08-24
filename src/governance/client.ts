import { randomUUID } from 'node:crypto';
import { ProtocolClient } from '@adcp/sdk';
import { log } from '../observability/logger.ts';
import type {
  AgentConfig,
  CheckGovernanceRequest,
  CheckGovernanceResponse,
  GetPlanAuditLogsRequest,
  GetPlanAuditLogsResponse,
  ReportPlanOutcomeRequest,
  ReportPlanOutcomeResponse,
  SyncPlansRequest,
  SyncPlansResponse,
} from '@adcp/sdk';

// Fly suspends both this app and governance when idle. On wake the first
// outbound call lands on a socket that did not survive the suspend, or on a
// governance instance still booting — observed 2026-08-24: abzu's machine
// started at 08:41:04 and logged `sync_plans failed: The socket connection was
// closed unexpectedly` at 08:41:05, while governance only finished registering
// tools at 08:41:16, eleven seconds later.
//
// Two guards, because the failure has two shapes. Retries cover the dropped
// socket; the timeout covers the opposite case, where a cold governance accepts
// the connection and then leaves us hanging — an untimed retry of that turned a
// fast failure into a 300s stall. Same shape as the seller's retryingQueryable()
// for Neon after the 2026-07-03 pool incident.
//
// Idempotency keys are minted by the callers before `call`, so every retry
// re-sends the same key and governance dedupes rather than double-applying.
const CALL_ATTEMPTS = 3;
const CALL_TIMEOUT_MS = 20_000;
const CALL_BACKOFF_MS = [500, 2_000];

const RETRIABLE_TRANSPORT =
  /socket connection was closed|socket hang up|fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|timed out|502|503|504/i;

function isRetriableTransport(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RETRIABLE_TRANSPORT.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type GovernanceAgentConfig = {
  id: string;
  agent_uri: string;
  protocol: 'mcp' | 'a2a';
  auth_token?: string;
};

export type GovernanceErrorCode = 'not_configured' | 'task_failed';

export class GovernanceError extends Error {
  constructor(message: string, readonly code: GovernanceErrorCode) {
    super(message);
    this.name = 'GovernanceError';
  }
}

export type KnownPlanEntry = {
  plan_id: string;
  brand_domain?: string;
  synced_at: string;
};

export interface KnownPlansAdapter {
  remember(planId: string, brandDomain?: string): Promise<void>;
  list(): Promise<KnownPlanEntry[]>;
}

export class KnownPlans implements KnownPlansAdapter {
  private entries = new Map<string, KnownPlanEntry>();
  private now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  async remember(planId: string, brandDomain?: string): Promise<void> {
    this.entries.set(planId, {
      plan_id: planId,
      ...(brandDomain ? { brand_domain: brandDomain } : {}),
      synced_at: this.now(),
    });
  }

  async list(): Promise<KnownPlanEntry[]> {
    return [...this.entries.values()].sort((a, b) =>
      a.synced_at < b.synced_at ? 1 : a.synced_at > b.synced_at ? -1 : 0,
    );
  }
}

export class GovernanceClient {
  private readonly agent: AgentConfig;

  constructor(private readonly config: GovernanceAgentConfig) {
    this.agent = {
      id: config.id,
      name: 'Abzu Governance',
      agent_uri: config.agent_uri,
      protocol: config.protocol,
      ...(config.auth_token !== undefined ? { auth_token: config.auth_token } : {}),
    };
  }

  describe() {
    return {
      id: this.config.id,
      agent_uri: this.config.agent_uri,
      protocol: this.config.protocol,
    };
  }

  async syncPlans(plans: SyncPlansRequest['plans']): Promise<SyncPlansResponse> {
    return this.call<SyncPlansResponse>('sync_plans', {
      idempotency_key: this.freshKey(),
      plans,
    });
  }

  async checkGovernance(params: CheckGovernanceRequest): Promise<CheckGovernanceResponse> {
    return this.call<CheckGovernanceResponse>('check_governance', params);
  }

  async reportOutcome(params: ReportPlanOutcomeRequest): Promise<ReportPlanOutcomeResponse> {
    const enriched: ReportPlanOutcomeRequest = {
      ...params,
      ...(params.idempotency_key ? {} : { idempotency_key: this.freshKey() }),
    };
    return this.call<ReportPlanOutcomeResponse>('report_plan_outcome', enriched);
  }

  async getAuditLogs(params: GetPlanAuditLogsRequest): Promise<GetPlanAuditLogsResponse> {
    return this.call<GetPlanAuditLogsResponse>('get_plan_audit_logs', params);
  }

  private async call<R>(tool: string, params: unknown): Promise<R> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < CALL_ATTEMPTS; attempt++) {
      try {
        const raw = await withTimeout(
          ProtocolClient.callTool(this.agent, tool, params as Record<string, unknown>),
          CALL_TIMEOUT_MS,
          `${tool} timed out after ${CALL_TIMEOUT_MS}ms`,
        );
        const unwrapped = unwrapMcpEnvelope(raw);
        const adcpError = (unwrapped as { adcp_error?: { message?: string } }).adcp_error;
        if (adcpError) {
          // A protocol-level rejection is deterministic — governance evaluated
          // the request and said no. Retrying re-asks the same question.
          throw new GovernanceError(
            `${tool} rejected: ${adcpError.message ?? 'validation failed'}`,
            'task_failed',
          );
        }
        return unwrapped as R;
      } catch (err) {
        if (err instanceof GovernanceError) throw err;
        lastErr = err;
        if (attempt === CALL_ATTEMPTS - 1 || !isRetriableTransport(err)) break;
        // Log every retry. A retry that recovers silently is indistinguishable
        // from a call that never had trouble, which hides a degrading
        // dependency until it fails outright.
        log.warn('governance call retrying', {
          tool,
          attempt: attempt + 1,
          of: CALL_ATTEMPTS,
          backoff_ms: CALL_BACKOFF_MS[attempt] ?? 1000,
          reason: err instanceof Error ? err.message : String(err),
        });
        await sleep(CALL_BACKOFF_MS[attempt] ?? 1000);
      }
    }
    throw new GovernanceError(
      `${tool} failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      'task_failed',
    );
  }

  private freshKey(): string {
    return `abzu_${randomUUID().replace(/-/g, '')}`;
  }
}

export function createGovernanceClient(
  config: GovernanceAgentConfig | undefined,
): GovernanceClient | undefined {
  if (!config) return undefined;
  return new GovernanceClient(config);
}

function unwrapMcpEnvelope(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as { structuredContent?: unknown; content?: Array<{ text?: string }> };
  if (r.structuredContent && typeof r.structuredContent === 'object') {
    return r.structuredContent;
  }
  if (Array.isArray(r.content) && r.content[0]?.text) {
    try {
      return JSON.parse(r.content[0].text);
    } catch {
      // Fall through to raw.
    }
  }
  return raw;
}
