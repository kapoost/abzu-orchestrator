import type {
  ADCPMultiAgentClient,
  CreativeStatus,
  ListCreativesRequest,
  ListCreativesResponse,
  SyncCreativesRequest,
  UpdateMediaBuyRequest,
} from '@adcp/sdk';
import { ensureIdempotencyKey, type CreativeStatusQuery, type CreativeSyncInput } from '../strategy/creative.ts';
import type { SellerConfig } from './sellers.ts';

export type CreativeErrorCode =
  | 'agent_not_found'
  | 'task_failed'
  | 'task_pending'
  | 'task_submitted';

export class CreativeError extends Error {
  constructor(message: string, readonly code: CreativeErrorCode) {
    super(message);
    this.name = 'CreativeError';
  }
}

export type CreativeItemOutcome = {
  creative_id: string;
  action?: string;
  status?: CreativeStatus;
  platform_id?: string;
  errors?: ReadonlyArray<{ message?: string; code?: string }>;
};

export type CreativeSyncOutcome = {
  seller_id: string;
  task_id?: string;
  status: string;
  dry_run: boolean;
  idempotency_key: string;
  creatives: CreativeItemOutcome[];
};

export type CreativeStatusEntry = {
  creative_id: string;
  status?: CreativeStatus;
  name?: string;
};

export type CreativeStatusOutcome = {
  seller_id: string;
  creatives: CreativeStatusEntry[];
};

export class CreativeClient {
  private readonly sellersById: Map<string, SellerConfig>;

  constructor(
    private readonly client: ADCPMultiAgentClient,
    sellers: ReadonlyArray<SellerConfig>,
  ) {
    this.sellersById = new Map(sellers.map((s) => [s.id, s]));
  }

  async sync(input: CreativeSyncInput): Promise<CreativeSyncOutcome> {
    const seller = this.sellersById.get(input.seller_id);
    if (!seller) {
      throw new CreativeError(`unknown agent: ${input.seller_id}`, 'agent_not_found');
    }
    const withKey = ensureIdempotencyKey(input);
    const request = {
      account: withKey.account,
      creatives: withKey.creatives,
      idempotency_key: withKey.idempotency_key!,
      ...(withKey.dry_run ? { dry_run: true } : {}),
    } as unknown as SyncCreativesRequest;
    const result = await this.client.agent(input.seller_id).syncCreatives(request);
    if (!result.success) {
      throw new CreativeError(
        `syncCreatives failed for ${input.seller_id}: ${result.error}`,
        'task_failed',
      );
    }
    if (result.status === 'submitted') {
      return {
        seller_id: input.seller_id,
        task_id: result.data?.task_id,
        status: 'submitted',
        dry_run: !!withKey.dry_run,
        idempotency_key: withKey.idempotency_key!,
        creatives: [],
      };
    }
    if (result.status !== 'completed') {
      throw new CreativeError(
        `syncCreatives for ${input.seller_id} pending (status=${result.status})`,
        'task_pending',
      );
    }
    const items = (result.data as { creatives?: CreativeItemOutcome[] }).creatives ?? [];
    return {
      seller_id: input.seller_id,
      ...(result.data?.task_id ? { task_id: result.data.task_id } : {}),
      status: 'completed',
      dry_run: !!withKey.dry_run,
      idempotency_key: withKey.idempotency_key!,
      creatives: items,
    };
  }

  async status(query: CreativeStatusQuery): Promise<CreativeStatusOutcome> {
    const seller = this.sellersById.get(query.seller_id);
    if (!seller) {
      throw new CreativeError(`unknown agent: ${query.seller_id}`, 'agent_not_found');
    }
    const request: ListCreativesRequest = {};
    if (query.creative_ids.length > 0 || query.statuses.length > 0) {
      request.filters = {
        ...(query.creative_ids.length > 0 ? { creative_ids: query.creative_ids } : {}),
        ...(query.statuses.length > 0 ? { statuses: query.statuses } : {}),
      };
    }
    request.fields = ['creative_id', 'name', 'status'];
    const result = await this.client.agent(query.seller_id).listCreatives(request);
    if (!result.success) {
      throw new CreativeError(
        `listCreatives failed for ${query.seller_id}: ${result.error}`,
        'task_failed',
      );
    }
    if (result.status !== 'completed') {
      throw new CreativeError(
        `listCreatives for ${query.seller_id} pending (status=${result.status})`,
        'task_pending',
      );
    }
    const creatives =
      (result.data as ListCreativesResponse & {
        creatives?: CreativeStatusEntry[];
      }).creatives ?? [];
    return { seller_id: query.seller_id, creatives };
  }

  /* Attach a creative to a media buy so the seller's ad server can attribute
   * live impressions to the right media_buy_id (see purrsonality
   * /live/result-slot → mockUpstream.findOrderByCreativeId). Without this
   * call sync_creatives only lands the creative in the seller's review
   * library; getMediaBuyDelivery then keeps returning zeros because nothing
   * links the served creative to the caller's buy. This closes that gap. */
  async assignToBuy(input: {
    seller_id: string;
    media_buy_id: string;
    creative_ids: string[];
    account?: unknown;
    package_id?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    if (input.creative_ids.length === 0) return { ok: true };
    const seller = this.sellersById.get(input.seller_id);
    if (!seller) return { ok: false, error: `unknown seller: ${input.seller_id}` };
    const request = {
      ...(input.account !== undefined ? { account: input.account } : {}),
      media_buy_id: input.media_buy_id,
      packages: [{
        ...(input.package_id ? { package_id: input.package_id } : { buyer_ref: 'abzu_default_package' }),
        creative_assignments: input.creative_ids.map((id) => ({ creative_id: id })),
      }],
    } as unknown as UpdateMediaBuyRequest;
    const result = await this.client.agent(input.seller_id).updateMediaBuy(request);
    if (!result.success || result.status !== 'completed') {
      return {
        ok: false,
        error: result.success ? `update_media_buy ${result.status}` : (result.error ?? 'task_failed'),
      };
    }
    return { ok: true };
  }
}
