// Wires the default fleet. To add an agent, write an AgentAdapter and register it here
// (or pass it in extraAgents); the coordinator itself does not change.

import { AgentRegistry, type RoutePolicy } from '../registry/registry.ts';
import { localAgents } from '../adapters/localAgents.ts';
import { externalAgents } from '../adapters/externalAgents.ts';
import { AgentiaClient } from '../agentia/client.ts';
import { FleetCoordinator } from '../coordinator/coordinator.ts';
import type { AgentAdapter } from './types.ts';
import { CopadoAiDeliveryAdapter } from '../adapters/copadoAi.ts';
import { CopadoMcpClient } from '../copado/mcpClient.ts';

export interface FleetOptions {
  workDir?: string;
  /** Exclude every agent that sends data off this machine. */
  offline?: boolean;
  /** Agent ids that must not be used. */
  deny?: string[];
  /** Register only local agents (tests, air-gapped runs). */
  localOnly?: boolean;
  extraAgents?: AgentAdapter[];
  concurrency?: number;
  agentia?: AgentiaClient;
  /** Copado AI Context Hub MCP client (credentials from env or .fleet/copado-ai.env). */
  copadoAi?: CopadoMcpClient;
}

export function createFleet(opts: FleetOptions = {}): FleetCoordinator {
  const registry = new AgentRegistry();
  for (const a of localAgents()) registry.register(a);
  if (!opts.localOnly) for (const a of externalAgents(opts.agentia ?? new AgentiaClient())) registry.register(a);
  if (!opts.localOnly) registry.register(new CopadoAiDeliveryAdapter(opts.copadoAi ?? new CopadoMcpClient()));
  for (const a of opts.extraAgents ?? []) registry.register(a);
  const policy: RoutePolicy = { offline: opts.offline, deny: opts.deny };
  return new FleetCoordinator(registry, { workDir: opts.workDir ?? '.fleet', policy, concurrency: opts.concurrency ?? 3 });
}
