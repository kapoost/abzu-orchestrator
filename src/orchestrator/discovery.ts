import { ADCPMultiAgentClient } from '@adcp/sdk';
import type {
  Format,
  GetAdCPCapabilitiesResponse,
  ListCreativeFormatsRequest,
} from '@adcp/sdk';
import { TtlCache } from './cache.ts';
import type { SellerConfig } from './sellers.ts';

type SupportedProtocol = GetAdCPCapabilitiesResponse['supported_protocols'][number];

export type DiscoveryErrorCode =
  | 'agent_not_found'
  | 'task_failed'
  | 'task_pending'
  | 'unsupported';

export class DiscoveryError extends Error {
  constructor(message: string, readonly code: DiscoveryErrorCode) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

export type ValidationResult = { ok: boolean; issues: string[] };

export type ValidationRequirements = {
  protocols?: ReadonlyArray<SupportedProtocol>;
  minAdcpMajor?: number;
};

export type DiscoveryOptions = {
  formatsTtlMs?: number;
};

const DEFAULT_FORMATS_TTL_MS = 5 * 60 * 1000;
// Per-call deadline for capabilities/formats probes — short by design so an
// unresponsive seller does not stall the multi-agent fan-out in planning.
// Settlement-time calls (getProducts, createMediaBuy) use the brief's
// time_budget_seconds via planning.ts.
const CAPABILITIES_PROBE_TIMEOUT_MS = 5000;

export class DiscoveryClient {
  private readonly formatsCache: TtlCache<string, Format[]>;
  private readonly sellersById: Map<string, SellerConfig>;

  constructor(
    private readonly client: ADCPMultiAgentClient,
    sellers: ReadonlyArray<SellerConfig>,
    options: DiscoveryOptions = {},
  ) {
    this.formatsCache = new TtlCache(options.formatsTtlMs ?? DEFAULT_FORMATS_TTL_MS);
    this.sellersById = new Map(sellers.map((s) => [s.id, s]));
  }

  listAgents(): SellerConfig[] {
    return [...this.sellersById.values()];
  }

  hasAgent(agentId: string): boolean {
    return this.sellersById.has(agentId);
  }

  async getCapabilities(agentId: string): Promise<GetAdCPCapabilitiesResponse> {
    this.ensureAgent(agentId);
    // SDK 9.0.0 silently ignores TaskOptions.timeout for the MCP transport
    // (verified: no setTimeout / options.timeout usage in TaskExecutor).
    // Race against our own deadline so an unresponsive seller cannot stall the
    // multi-agent fan-out — planning.ts:Promise.allSettled waits for the
    // longest-running probe.
    const result = await Promise.race([
      this.client
        .agent(agentId)
        .getAdcpCapabilities({}, undefined, { timeout: CAPABILITIES_PROBE_TIMEOUT_MS }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`getAdcpCapabilities timeout ${CAPABILITIES_PROBE_TIMEOUT_MS}ms`)),
          CAPABILITIES_PROBE_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
    if (!result.success) {
      throw new DiscoveryError(
        `getAdcpCapabilities failed for ${agentId}: ${result.error}`,
        'task_failed',
      );
    }
    if (result.status !== 'completed') {
      throw new DiscoveryError(
        `getAdcpCapabilities for ${agentId} did not complete (status=${result.status})`,
        'task_pending',
      );
    }
    return result.data;
  }

  async getCreativeFormats(
    agentId: string,
    params: ListCreativeFormatsRequest = {},
  ): Promise<Format[]> {
    this.ensureAgent(agentId);
    const cacheKey = `${agentId}::${JSON.stringify(params)}`;
    const hit = this.formatsCache.get(cacheKey);
    if (hit) return hit;
    const result = await Promise.race([
      this.client
        .agent(agentId)
        .listCreativeFormats(params, undefined, { timeout: CAPABILITIES_PROBE_TIMEOUT_MS }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`listCreativeFormats timeout ${CAPABILITIES_PROBE_TIMEOUT_MS}ms`)),
          CAPABILITIES_PROBE_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
    if (!result.success) {
      throw new DiscoveryError(
        `listCreativeFormats failed for ${agentId}: ${result.error}`,
        'task_failed',
      );
    }
    if (result.status !== 'completed') {
      throw new DiscoveryError(
        `listCreativeFormats for ${agentId} did not complete (status=${result.status})`,
        'task_pending',
      );
    }
    const formats = result.data.formats ?? [];
    this.formatsCache.set(cacheKey, formats);
    return formats;
  }

  async getPublisherDomains(agentId: string): Promise<string[]> {
    const caps = await this.getCapabilities(agentId);
    return caps.media_buy?.portfolio?.publisher_domains ?? [];
  }

  async validateAgent(
    agentId: string,
    requirements: ValidationRequirements,
  ): Promise<ValidationResult> {
    const caps = await this.getCapabilities(agentId);
    return evaluateRequirements(caps, requirements);
  }

  private ensureAgent(agentId: string): void {
    if (!this.sellersById.has(agentId)) {
      throw new DiscoveryError(`unknown agent: ${agentId}`, 'agent_not_found');
    }
  }
}

export function evaluateRequirements(
  caps: GetAdCPCapabilitiesResponse,
  requirements: ValidationRequirements,
): ValidationResult {
  const issues: string[] = [];

  if (requirements.minAdcpMajor !== undefined) {
    const majors = caps.adcp?.major_versions ?? [];
    const max = majors.length > 0 ? Math.max(...majors) : 0;
    if (max < requirements.minAdcpMajor) {
      issues.push(`adcp_major_lt_${requirements.minAdcpMajor}(seen=${max})`);
    }
  }

  if (requirements.protocols && requirements.protocols.length > 0) {
    const supported = new Set<string>(caps.supported_protocols ?? []);
    for (const protocol of requirements.protocols) {
      if (!supported.has(protocol)) {
        issues.push(`protocol_missing:${protocol}`);
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function buildClient(sellers: ReadonlyArray<SellerConfig>): ADCPMultiAgentClient {
  return new ADCPMultiAgentClient(
    sellers.map((s) => ({
      id: s.id,
      name: s.name,
      agent_uri: s.agent_uri,
      protocol: s.protocol,
      ...(s.auth_token !== undefined ? { auth_token: s.auth_token } : {}),
      ...(s.headers !== undefined ? { headers: s.headers } : {}),
    })),
  );
}

export function createDiscovery(
  sellers: ReadonlyArray<SellerConfig>,
  options: DiscoveryOptions = {},
): DiscoveryClient {
  return new DiscoveryClient(buildClient(sellers), sellers, options);
}
