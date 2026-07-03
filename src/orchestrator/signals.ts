/*
 * Buyer-side signals discovery — same fan-out shape as PlanningClient for
 * sellers, but against the `signals` protocol (`get_signals`). The buyer
 * hands a natural-language brief ("cat owners interested in adventurous
 * outdoor gear") and any deliver_to hint; we ask every registered signals
 * agent in parallel, rank the returned segments by coverage percentage,
 * and hand the aggregated result back to the GUI for buyer review.
 *
 * activateSignal is out of scope for the discovery pass — buyers activate
 * separately once they've picked a segment (nudged by `is_live: false`
 * marketplace signals that need an explicit activation on a destination).
 */

import { randomUUID } from 'node:crypto';
import type { ADCPMultiAgentClient, GetSignalsRequest, ActivateSignalRequest } from '@adcp/sdk';
import type { SignalsAgentConfig } from './signals-config.ts';

export interface SignalsDiscoveryInput {
  brief: string;
  /** Delivery destination hint — mirrors the get_signals request field. */
  deliver_to?: {
    platforms?: 'all' | ReadonlyArray<string>;
    countries?: ReadonlyArray<string>;
  };
  /** How many top-scoring segments to keep after ranking across agents. */
  top_n?: number;
  /** Per-agent probe deadline (ms). */
  time_budget_ms?: number;
}

export interface SignalDiagnostic {
  agent_id: string;
  ok: boolean;
  error?: string;
  validation_issues?: string[];
  signals_returned?: number;
}

export interface RankedSignal {
  agent_id: string;
  agent_name: string;
  signal_id: string;
  name: string;
  description?: string;
  signal_type?: string;
  data_provider?: string;
  coverage_percentage?: number;
  pricing?: unknown;
  raw: Record<string, unknown>;
}

export interface SignalsDiscoveryResult {
  input: SignalsDiscoveryInput;
  signals: RankedSignal[];
  diagnostics: {
    agents_queried: number;
    agents_responded: number;
    agents: SignalDiagnostic[];
  };
}

const DEFAULT_TIME_BUDGET_MS = 15_000;

export class SignalsClient {
  private readonly agentsById: Map<string, SignalsAgentConfig>;

  constructor(
    private readonly client: ADCPMultiAgentClient,
    agents: ReadonlyArray<SignalsAgentConfig>,
  ) {
    this.agentsById = new Map(agents.map((a) => [a.id, a]));
  }

  listAgents(): SignalsAgentConfig[] {
    return [...this.agentsById.values()];
  }

  async discover(input: SignalsDiscoveryInput): Promise<SignalsDiscoveryResult> {
    const timeoutMs = input.time_budget_ms ?? DEFAULT_TIME_BUDGET_MS;
    const req: GetSignalsRequest = {
      signal_spec: input.brief,
      ...(input.deliver_to && { deliver_to: input.deliver_to as GetSignalsRequest['deliver_to'] }),
    };

    const perAgent = await Promise.all(
      [...this.agentsById.values()].map((agent) => this.queryAgent(agent, req, timeoutMs)),
    );

    const diagnostics: SignalDiagnostic[] = [];
    const flat: RankedSignal[] = [];
    for (const r of perAgent) {
      diagnostics.push(r.diagnostic);
      if (r.ok) {
        for (const s of r.signals) flat.push(s);
      }
    }

    flat.sort((a, b) => (b.coverage_percentage ?? 0) - (a.coverage_percentage ?? 0));
    const topN = Math.max(1, Math.min(100, input.top_n ?? 20));
    const signals = flat.slice(0, topN);

    return {
      input,
      signals,
      diagnostics: {
        agents_queried: perAgent.length,
        agents_responded: perAgent.filter((r) => r.ok).length,
        agents: diagnostics,
      },
    };
  }

  /* Buyer-side activate_signal fan-in — hits a single named signals agent
   * with the destinations + pricing option the buyer chose. Returns the
   * raw activate_signal response so the GUI can inspect deployment keys,
   * status, and any partial-failure error entries. Deliberately not a
   * fan-out — a single activation is scoped to a single upstream signal
   * agent (the one that emitted the signal id in get_signals). */
  async activate(input: {
    agent_id: string;
    signal_agent_segment_id: string;
    destinations: ActivateSignalRequest['destinations'];
    action?: 'activate' | 'deactivate';
    pricing_option_id?: string;
    account?: ActivateSignalRequest['account'];
    idempotency_key?: string;
    time_budget_ms?: number;
  }): Promise<{
    ok: boolean;
    agent_id: string;
    status?: string;
    response?: unknown;
    error?: string;
  }> {
    const agent = this.agentsById.get(input.agent_id);
    if (!agent) {
      return { ok: false, agent_id: input.agent_id, error: `unknown signals agent: ${input.agent_id}` };
    }
    const timeoutMs = input.time_budget_ms ?? DEFAULT_TIME_BUDGET_MS;
    const req: ActivateSignalRequest = {
      signal_agent_segment_id: input.signal_agent_segment_id,
      destinations: input.destinations,
      ...(input.action && { action: input.action }),
      ...(input.pricing_option_id && { pricing_option_id: input.pricing_option_id }),
      ...(input.account && { account: input.account }),
      idempotency_key: input.idempotency_key ?? `abzu_activate_${randomUUID().replace(/-/g, '')}`,
    };
    try {
      const result = await this.client
        .agent(agent.id)
        .activateSignal(req, undefined, { timeout: timeoutMs });
      if (!result.success || result.status !== 'completed') {
        return {
          ok: false,
          agent_id: agent.id,
          status: result.status,
          response: result,
          error: result.success ? `task_${result.status}` : result.error ?? 'task_failed',
        };
      }
      return {
        ok: true,
        agent_id: agent.id,
        status: result.status,
        response: result.data,
      };
    } catch (err) {
      return {
        ok: false,
        agent_id: agent.id,
        error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      };
    }
  }

  private async queryAgent(
    agent: SignalsAgentConfig,
    request: GetSignalsRequest,
    timeoutMs: number,
  ): Promise<
    | { ok: true; signals: RankedSignal[]; diagnostic: SignalDiagnostic }
    | { ok: false; diagnostic: SignalDiagnostic }
  > {
    let result;
    try {
      result = await this.client
        .agent(agent.id)
        .getSignals(request, undefined, { timeout: timeoutMs });
    } catch (err) {
      return {
        ok: false,
        diagnostic: {
          agent_id: agent.id,
          ok: false,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        },
      };
    }
    if (!result.success || result.status !== 'completed') {
      return {
        ok: false,
        diagnostic: {
          agent_id: agent.id,
          ok: false,
          error: result.success
            ? `task_${result.status}`
            : result.error ?? 'task_failed',
        },
      };
    }
    const rawSignals = ((result.data as { signals?: unknown[] }).signals ?? []) as Array<Record<string, unknown>>;
    const signals: RankedSignal[] = rawSignals.map((r) => {
      // AdCP 3.1 emits `signal_id` as `{source, data_provider_domain, id}`.
      // Older 3.0 responses (and non-signal fields like `signal_agent_segment_id`)
      // keep it as a plain string. Normalize to a stable string form so
      // GUI + downstream code always sees a scalar.
      const rawSigId = r['signal_id'];
      const canonicalId =
        typeof rawSigId === 'string'
          ? rawSigId
          : rawSigId && typeof rawSigId === 'object'
            ? (() => {
                const obj = rawSigId as { id?: unknown; data_provider_domain?: unknown };
                const id = typeof obj.id === 'string' ? obj.id : '';
                const domain =
                  typeof obj.data_provider_domain === 'string' ? obj.data_provider_domain : '';
                return domain && id ? `${domain}/${id}` : id;
              })()
            : '';
      const fallbackId =
        canonicalId ||
        (typeof r['signal_agent_segment_id'] === 'string' ? (r['signal_agent_segment_id'] as string) : '') ||
        (typeof r['id'] === 'string' ? (r['id'] as string) : '');
      return {
      agent_id: agent.id,
      agent_name: agent.name,
      signal_id: fallbackId,
      name: String(r['name'] ?? fallbackId ?? ''),
      description: r['description'] ? String(r['description']) : undefined,
      signal_type: r['signal_type'] ? String(r['signal_type']) : undefined,
      data_provider: r['data_provider'] ? String(r['data_provider']) : undefined,
      coverage_percentage:
        typeof r['coverage_percentage'] === 'number' ? (r['coverage_percentage'] as number) : undefined,
      pricing: r['pricing_options'] ?? r['pricing'],
      raw: r,
      };
    });
    return {
      ok: true,
      signals,
      diagnostic: {
        agent_id: agent.id,
        ok: true,
        signals_returned: signals.length,
      },
    };
  }

}
