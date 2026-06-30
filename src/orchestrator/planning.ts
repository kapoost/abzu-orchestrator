import type { ADCPMultiAgentClient, GetProductsRequest, Product } from '@adcp/sdk';
import { type BriefIntake, composeBriefString } from '../strategy/brief.ts';
import { rankProposals, type ScoredProduct } from '../strategy/scoring.ts';
import type { DiscoveryClient, ValidationResult } from './discovery.ts';
import type { SellerConfig } from './sellers.ts';

export type SellerDiagnostic = {
  seller_id: string;
  ok: boolean;
  error?: string;
  validation_issues?: string[];
  products_returned?: number;
};

export type PlanResult = {
  brief: BriefIntake;
  proposals: ScoredProduct[];
  diagnostics: {
    sellers_queried: number;
    sellers_responded: number;
    partial: boolean;
    sellers: SellerDiagnostic[];
  };
};

const PARTIAL_THRESHOLD = 0.5;

export class PlanningClient {
  constructor(
    private readonly client: ADCPMultiAgentClient,
    private readonly sellers: ReadonlyArray<SellerConfig>,
    private readonly discovery: DiscoveryClient,
  ) {}

  async planFromBrief(brief: BriefIntake): Promise<PlanResult> {
    const request = this.buildRequest(brief);
    const timeoutMs = brief.time_budget_seconds * 1000;
    const candidates: { seller_id: string; product: Product }[] = [];
    const diagnostics: SellerDiagnostic[] = [];

    const settled = await Promise.allSettled(
      this.sellers.map((seller) => this.querySeller(seller, request, timeoutMs)),
    );

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]!;
      const seller = this.sellers[i]!;
      if (result.status === 'rejected') {
        diagnostics.push({
          seller_id: seller.id,
          ok: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        continue;
      }
      const sellerResult = result.value;
      if (!sellerResult.ok) {
        diagnostics.push(sellerResult.diagnostic);
        continue;
      }
      diagnostics.push({
        seller_id: seller.id,
        ok: true,
        products_returned: sellerResult.products.length,
      });
      for (const product of sellerResult.products) {
        candidates.push({ seller_id: seller.id, product });
      }
    }

    const proposals = rankProposals(candidates, brief);
    const responded = diagnostics.filter((d) => d.ok).length;
    const partial =
      this.sellers.length > 0 && responded / this.sellers.length < PARTIAL_THRESHOLD;
    return {
      brief,
      proposals,
      diagnostics: {
        sellers_queried: this.sellers.length,
        sellers_responded: responded,
        partial,
        sellers: diagnostics,
      },
    };
  }

  private buildRequest(brief: BriefIntake): GetProductsRequest {
    const req: GetProductsRequest = {
      buying_mode: 'brief',
      brief: composeBriefString(brief),
    };
    if (brief.preferred_delivery_types.length > 0) {
      req.preferred_delivery_types = brief.preferred_delivery_types;
    }
    if (brief.advertiser.domain) {
      req.brand = {
        domain: brief.advertiser.domain,
        ...(brief.advertiser.name !== undefined ? { name: brief.advertiser.name } : {}),
        ...(brief.advertiser.id !== undefined ? { brand_id: brief.advertiser.id } : {}),
      } as GetProductsRequest['brand'];
    }
    return req;
  }

  private async querySeller(
    seller: SellerConfig,
    request: GetProductsRequest,
    timeoutMs: number,
  ): Promise<
    | { ok: true; products: Product[] }
    | { ok: false; diagnostic: SellerDiagnostic }
  > {
    const validation = await this.safelyValidate(seller.id);
    if (!validation.ok) {
      return {
        ok: false,
        diagnostic: {
          seller_id: seller.id,
          ok: false,
          validation_issues: validation.issues,
          error: 'validation_failed',
        },
      };
    }
    const result = await this.client
      .agent(seller.id)
      .getProducts(request, undefined, { timeout: timeoutMs, project: false });
    if (!result.success || result.status !== 'completed') {
      return {
        ok: false,
        diagnostic: {
          seller_id: seller.id,
          ok: false,
          error: result.success
            ? `task_${result.status}`
            : result.error ?? 'task_failed',
        },
      };
    }
    const products = result.data.products ?? [];
    return { ok: true, products };
  }

  private async safelyValidate(agentId: string): Promise<ValidationResult> {
    try {
      return await this.discovery.validateAgent(agentId, {
        protocols: ['media_buy'],
        minAdcpMajor: 3,
      });
    } catch (err) {
      return {
        ok: false,
        issues: [`capabilities_unreachable:${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }
}
