import { describe, expect, test } from 'bun:test';
import { ExecutionClient } from '../src/orchestrator/execution.ts';
import type { SellerConfig } from '../src/orchestrator/sellers.ts';
import { parseBuyIntake } from '../src/strategy/buy.ts';

const sellers: SellerConfig[] = [
  {
    id: 'mock-seller',
    name: 'Mock Seller',
    agent_uri: 'https://mock.example.com/mcp',
    protocol: 'mcp',
    tags: { countries: [], categories: [], languages: [] },
  },
];

function makeIntake() {
  return parseBuyIntake({
    seller_id: 'mock-seller',
    plan_id: 'plan_async_test',
    account: { brand: { domain: 'acme.example.com' }, operator: 'acme.example.com' },
    brand: { domain: 'acme.example.com' },
    product_id: 'prod_a',
    pricing_option_id: 'po_1',
    budget: 1000,
    currency: 'USD',
    flight: { start: '2026-07-15T00:00:00Z', end: '2026-08-15T23:59:59Z' },
  });
}

function makeGovernance() {
  return {
    checkGovernance: async () => ({
      check_id: 'chk_async_1',
      plan_id: 'plan_async_test',
      verdict: 'approved',
      mode: 'enforce',
      explanation: 'ok',
      findings: [],
      governance_context: 'gov.v0.fake',
    }),
    reportOutcome: async () => ({
      outcome_id: 'out_async_1',
      outcome_state: 'accepted',
      committed_budget: 1000,
    }),
  } as never;
}

describe('ExecutionClient async lifecycle', () => {
  test('awaits submitted then completes via waitForCompletion', async () => {
    let waitCalled = false;
    const mockMulti = {
      agent: () => ({
        createMediaBuy: async () => ({
          success: true,
          status: 'submitted' as const,
          submitted: {
            taskId: 'tk_async_42',
            track: async () => ({}),
            waitForCompletion: async () => {
              waitCalled = true;
              return {
                success: true,
                status: 'completed' as const,
                data: {
                  media_buy_id: 'mb_async_done',
                  media_buy_status: 'pending_creatives',
                  task_id: 'tk_async_42',
                },
              };
            },
          },
        }),
      }),
    };

    const exec = new ExecutionClient(mockMulti as never, sellers, makeGovernance());
    const result = await exec.executeBuy(makeIntake());

    expect(waitCalled).toBe(true);
    expect(result.media_buy.awaited_submitted).toBe(true);
    expect(result.media_buy.media_buy_id).toBe('mb_async_done');
    expect(result.outcome.outcome_state).toBe('accepted');
  });

  test('throws task_pending when waitForCompletion aborts (timeout)', async () => {
    const mockMulti = {
      agent: () => ({
        createMediaBuy: async () => ({
          success: true,
          status: 'submitted' as const,
          submitted: {
            taskId: 'tk_pending',
            track: async () => ({}),
            waitForCompletion: async () => {
              throw new Error('AbortError: signal timed out');
            },
          },
        }),
      }),
    };

    const exec = new ExecutionClient(mockMulti as never, sellers, makeGovernance());
    let caught: unknown;
    try {
      await exec.executeBuy(makeIntake());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('task_pending');
    expect((caught as { detail?: { task_id?: string } }).detail?.task_id).toBe('tk_pending');
  });

  test('synchronous completed path skips wait', async () => {
    let waitCalled = false;
    const mockMulti = {
      agent: () => ({
        createMediaBuy: async () => ({
          success: true,
          status: 'completed' as const,
          data: { media_buy_id: 'mb_sync', media_buy_status: 'active' },
        }),
      }),
    };

    const exec = new ExecutionClient(mockMulti as never, sellers, makeGovernance());
    const result = await exec.executeBuy(makeIntake());
    expect(waitCalled).toBe(false);
    expect(result.media_buy.awaited_submitted).toBeUndefined();
    expect(result.media_buy.media_buy_id).toBe('mb_sync');
  });
});
