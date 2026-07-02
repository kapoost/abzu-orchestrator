import { CreativeClient } from './creative.ts';
import { buildClient, DiscoveryClient, type DiscoveryOptions } from './discovery.ts';
import { ExecutionClient } from './execution.ts';
import { PlanningClient } from './planning.ts';
import type { SellerConfig } from './sellers.ts';
import type { GovernanceClient } from '../governance/client.ts';
import { SignalsClient } from './signals.ts';
import type { SignalsAgentConfig } from './signals-config.ts';

export type Orchestrator = {
  discovery: DiscoveryClient;
  planning: PlanningClient;
  creative: CreativeClient;
  execution?: ExecutionClient;
  signals?: SignalsClient;
};

export function createOrchestrator(
  sellers: ReadonlyArray<SellerConfig>,
  options: DiscoveryOptions = {},
  governance?: GovernanceClient,
  signalsAgents: ReadonlyArray<SignalsAgentConfig> = [],
): Orchestrator {
  const multi = buildClient(sellers, signalsAgents);
  const discovery = new DiscoveryClient(multi, sellers, options);
  const planning = new PlanningClient(multi, sellers, discovery);
  const creative = new CreativeClient(multi, sellers);
  const execution = governance ? new ExecutionClient(multi, sellers, governance) : undefined;
  const signals = signalsAgents.length > 0 ? new SignalsClient(multi, signalsAgents) : undefined;
  return {
    discovery,
    planning,
    creative,
    ...(execution ? { execution } : {}),
    ...(signals ? { signals } : {}),
  };
}

export { CreativeClient, CreativeError } from './creative.ts';
export { DiscoveryClient, DiscoveryError } from './discovery.ts';
export { ExecutionClient, ExecutionError } from './execution.ts';
export { PlanningClient } from './planning.ts';
export type { PlanResult, SellerDiagnostic } from './planning.ts';
export type { CreativeStatusOutcome, CreativeSyncOutcome } from './creative.ts';
export type { ExecutionResult, DeliveryReportResult } from './execution.ts';
