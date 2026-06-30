import { randomUUID } from 'node:crypto';
import type {
  ADCPMultiAgentClient,
  CheckGovernanceResponse,
  CreateMediaBuyRequest,
  CreateMediaBuyResponse,
  GetMediaBuyDeliveryResponse,
  ReportPlanOutcomeRequest,
  ReportPlanOutcomeResponse,
} from '@adcp/sdk';
import type { GovernanceClient } from '../governance/client.ts';
import type { BuyIntake } from '../strategy/buy.ts';
import type { SellerConfig } from './sellers.ts';

export type ExecutionErrorCode =
  | 'agent_not_found'
  | 'governance_required'
  | 'governance_denied'
  | 'conditions_not_accepted'
  | 'task_failed'
  | 'task_pending';

export class ExecutionError extends Error {
  constructor(
    message: string,
    readonly code: ExecutionErrorCode,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ExecutionError';
  }
}

export type ExecutionResult = {
  buy_intake: BuyIntake;
  governance_check: CheckGovernanceResponse;
  media_buy: {
    status: string;
    media_buy_id?: string;
    media_buy_status?: string;
    confirmed_at?: string | null;
    awaited_submitted?: boolean;
    seller_response: CreateMediaBuyResponse;
  };
  outcome: ReportPlanOutcomeResponse;
};

const ASYNC_POLL_INTERVAL_MS = 5000;
const ASYNC_MAX_WAIT_MS = 60000;

export type DeliveryReportResult = {
  delivery: GetMediaBuyDeliveryResponse;
  outcome: ReportPlanOutcomeResponse;
};

export class ExecutionClient {
  private readonly sellersById: Map<string, SellerConfig>;

  constructor(
    private readonly client: ADCPMultiAgentClient,
    sellers: ReadonlyArray<SellerConfig>,
    private readonly governance: GovernanceClient,
  ) {
    this.sellersById = new Map(sellers.map((s) => [s.id, s]));
  }

  async executeBuy(intake: BuyIntake): Promise<ExecutionResult> {
    const seller = this.sellersById.get(intake.seller_id);
    if (!seller) {
      throw new ExecutionError(`unknown seller: ${intake.seller_id}`, 'agent_not_found');
    }

    const check = await this.governance.checkGovernance({
      plan_id: intake.plan_id,
      caller: 'https://abzu.local',
      tool: 'create_media_buy',
      payload: {
        seller_id: intake.seller_id,
        product_id: intake.product_id,
        total_budget: intake.budget,
        currency: intake.currency,
        flight: intake.flight,
      },
    });

    if (check.verdict === 'denied' && check.mode !== 'audit') {
      throw new ExecutionError(
        `governance denied buy: ${check.explanation}`,
        'governance_denied',
        { check_id: check.check_id, findings: check.findings, mode: check.mode },
      );
    }
    if (check.verdict === 'conditions' && !intake.accept_conditions) {
      throw new ExecutionError(
        `governance returned conditions; resubmit with accept_conditions=true if applying ${check.conditions?.length ?? 0} condition(s) is acceptable`,
        'conditions_not_accepted',
        { check_id: check.check_id, conditions: check.conditions },
      );
    }

    const idempotencyKey = `abzu_buy_${randomUUID().replace(/-/g, '')}`;
    const request: CreateMediaBuyRequest = {
      idempotency_key: idempotencyKey,
      plan_id: intake.plan_id,
      account: intake.account as CreateMediaBuyRequest['account'],
      brand: {
        domain: intake.brand.domain,
        ...(intake.brand.name ? { name: intake.brand.name } : {}),
        ...(intake.brand.brand_id ? { brand_id: intake.brand.brand_id } : {}),
      },
      start_time: intake.flight.start,
      end_time: intake.flight.end,
      packages: [
        {
          product_id: intake.product_id,
          pricing_option_id: intake.pricing_option_id,
          budget: intake.budget,
        } as CreateMediaBuyRequest['packages'] extends Array<infer P> ? P : never,
      ],
    };
    let buyResult = await this.client
      .agent(intake.seller_id)
      .createMediaBuy(request);

    let awaitedSubmitted = false;
    if (
      buyResult.success &&
      buyResult.status === 'submitted' &&
      buyResult.submitted
    ) {
      awaitedSubmitted = true;
      const submitted = buyResult.submitted;
      try {
        buyResult = await submitted.waitForCompletion(
          ASYNC_POLL_INTERVAL_MS,
          AbortSignal.timeout(ASYNC_MAX_WAIT_MS),
        );
      } catch (err) {
        throw new ExecutionError(
          `create_media_buy did not complete within ${ASYNC_MAX_WAIT_MS}ms: ${err instanceof Error ? err.message : String(err)}`,
          'task_pending',
          { check_id: check.check_id, task_id: submitted.taskId },
        );
      }
    }

    if (!buyResult.success) {
      await this.reportFailure(intake, check, buyResult.error ?? 'create_media_buy failed');
      throw new ExecutionError(
        `create_media_buy failed: ${buyResult.error}`,
        'task_failed',
        { check_id: check.check_id },
      );
    }
    if (buyResult.status !== 'completed') {
      throw new ExecutionError(
        `create_media_buy did not complete (status=${buyResult.status})`,
        'task_pending',
        { check_id: check.check_id, task_id: (buyResult.data as { task_id?: string } | undefined)?.task_id },
      );
    }

    const buy = buyResult.data as CreateMediaBuyResponse & {
      media_buy_id?: string;
      media_buy_status?: string;
      confirmed_at?: string | null;
    };
    const outcome = await this.governance.reportOutcome({
      plan_id: intake.plan_id,
      check_id: check.check_id,
      idempotency_key: `abzu_outcome_${randomUUID().replace(/-/g, '')}`,
      outcome: 'completed',
      governance_context: check.governance_context!,
      seller_response: {
        ...(buy.media_buy_id ? { seller_reference: buy.media_buy_id } : {}),
        committed_budget: intake.budget,
      },
    });

    return {
      buy_intake: intake,
      governance_check: check,
      media_buy: {
        status: buyResult.status,
        ...(buy.media_buy_id ? { media_buy_id: buy.media_buy_id } : {}),
        ...(buy.media_buy_status ? { media_buy_status: buy.media_buy_status } : {}),
        ...(buy.confirmed_at !== undefined ? { confirmed_at: buy.confirmed_at } : {}),
        ...(awaitedSubmitted ? { awaited_submitted: true } : {}),
        seller_response: buy,
      },
      outcome,
    };
  }

  async pullDelivery(args: {
    seller_id: string;
    media_buy_id: string;
    plan_id: string;
    governance_context: string;
  }): Promise<DeliveryReportResult> {
    const seller = this.sellersById.get(args.seller_id);
    if (!seller) {
      throw new ExecutionError(`unknown seller: ${args.seller_id}`, 'agent_not_found');
    }
    const result = await this.client
      .agent(args.seller_id)
      .getMediaBuyDelivery({ media_buy_ids: [args.media_buy_id] });
    if (!result.success || result.status !== 'completed') {
      throw new ExecutionError(
        `get_media_buy_delivery failed: ${result.success ? result.status : result.error}`,
        'task_failed',
      );
    }
    const outcome = await this.governance.reportOutcome({
      plan_id: args.plan_id,
      idempotency_key: `abzu_delivery_${randomUUID().replace(/-/g, '')}`,
      outcome: 'delivery',
      governance_context: args.governance_context,
      delivery: this.extractDelivery(result.data),
    } as ReportPlanOutcomeRequest);
    return { delivery: result.data, outcome };
  }

  private extractDelivery(
    data: GetMediaBuyDeliveryResponse,
  ): ReportPlanOutcomeRequest['delivery'] {
    const buy = (data as { media_buys?: Array<Record<string, unknown>> }).media_buys?.[0];
    if (!buy) return undefined;
    const impressions = typeof buy.impressions === 'number' ? buy.impressions : undefined;
    const spend = typeof buy.spend === 'number' ? buy.spend : undefined;
    if (impressions === undefined && spend === undefined) return undefined;
    return {
      ...(impressions !== undefined ? { impressions } : {}),
      ...(spend !== undefined ? { spend } : {}),
    } as ReportPlanOutcomeRequest['delivery'];
  }

  private async reportFailure(
    intake: BuyIntake,
    check: CheckGovernanceResponse,
    errorMessage: string,
  ): Promise<void> {
    if (!check.governance_context) return;
    try {
      await this.governance.reportOutcome({
        plan_id: intake.plan_id,
        check_id: check.check_id,
        idempotency_key: `abzu_outcome_fail_${randomUUID().replace(/-/g, '')}`,
        outcome: 'failed',
        governance_context: check.governance_context,
        error: { message: errorMessage.slice(0, 500) },
      });
    } catch {
      // Best-effort — primary error already surfaces to caller.
    }
  }
}
