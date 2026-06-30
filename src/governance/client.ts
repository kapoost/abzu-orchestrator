import { randomUUID } from 'node:crypto';
import { ProtocolClient } from '@adcp/sdk';
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
    try {
      const raw = await ProtocolClient.callTool(this.agent, tool, params as Record<string, unknown>);
      const unwrapped = unwrapMcpEnvelope(raw);
      const adcpError = (unwrapped as { adcp_error?: { message?: string } }).adcp_error;
      if (adcpError) {
        throw new GovernanceError(
          `${tool} rejected: ${adcpError.message ?? 'validation failed'}`,
          'task_failed',
        );
      }
      return unwrapped as R;
    } catch (err) {
      if (err instanceof GovernanceError) throw err;
      throw new GovernanceError(
        `${tool} failed: ${err instanceof Error ? err.message : String(err)}`,
        'task_failed',
      );
    }
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
