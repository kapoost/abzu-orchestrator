import { describe, expect, test } from 'bun:test';
import type { GetAdCPCapabilitiesResponse } from '@adcp/sdk';
import {
  DiscoveryClient,
  DiscoveryError,
  evaluateRequirements,
} from '../src/orchestrator/discovery.ts';
import type { SellerConfig } from '../src/orchestrator/sellers.ts';

function makeCaps(overrides: Partial<GetAdCPCapabilitiesResponse> = {}): GetAdCPCapabilitiesResponse {
  return {
    status: 'completed',
    adcp: {
      major_versions: [3],
      supported_versions: ['3.1'],
      idempotency: { supported: false },
    },
    supported_protocols: ['media_buy'],
    ...overrides,
  } as GetAdCPCapabilitiesResponse;
}

describe('evaluateRequirements', () => {
  test('ok when caps satisfy all requirements', () => {
    const result = evaluateRequirements(makeCaps(), {
      protocols: ['media_buy'],
      minAdcpMajor: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('flags missing protocol', () => {
    const result = evaluateRequirements(makeCaps({ supported_protocols: ['signals'] }), {
      protocols: ['media_buy'],
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(['protocol_missing:media_buy']);
  });

  test('flags adcp major below requirement', () => {
    const result = evaluateRequirements(
      makeCaps({
        adcp: { major_versions: [2], idempotency: { supported: false } },
      }),
      { minAdcpMajor: 3 },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/adcp_major_lt_3/);
  });

  test('accumulates multiple issues', () => {
    const result = evaluateRequirements(
      makeCaps({
        adcp: { major_versions: [2], idempotency: { supported: false } },
        supported_protocols: ['signals'],
      }),
      { protocols: ['media_buy', 'creative'], minAdcpMajor: 3 },
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(3);
  });

  test('empty protocols requirement is a no-op', () => {
    const result = evaluateRequirements(makeCaps({ supported_protocols: [] }), {});
    expect(result.ok).toBe(true);
  });
});

describe('DiscoveryClient registry semantics', () => {
  const emptyTags = { countries: [], categories: [], languages: [] };
  const sellers: SellerConfig[] = [
    {
      id: 's1',
      name: 'S1',
      agent_uri: 'https://s1.example.com/mcp',
      protocol: 'mcp',
      tags: emptyTags,
    },
    {
      id: 's2',
      name: 'S2',
      agent_uri: 'https://s2.example.com/mcp',
      protocol: 'mcp',
      tags: emptyTags,
    },
  ];
  const stubMultiAgent = {} as never;
  const discovery = new DiscoveryClient(stubMultiAgent, sellers);

  test('listAgents returns all configured sellers', () => {
    expect(discovery.listAgents()).toHaveLength(2);
  });

  test('hasAgent reflects registry', () => {
    expect(discovery.hasAgent('s1')).toBe(true);
    expect(discovery.hasAgent('nope')).toBe(false);
  });

  test('getCapabilities rejects unknown agent without hitting wire', async () => {
    await expect(discovery.getCapabilities('nope')).rejects.toBeInstanceOf(DiscoveryError);
    try {
      await discovery.getCapabilities('nope');
    } catch (err) {
      expect((err as DiscoveryError).code).toBe('agent_not_found');
    }
  });
});
