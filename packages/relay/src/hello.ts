import type { RelayConfig } from './config.js';
import type { OfferedTool } from './trim.js';
import { RELAY_VERSION } from './version.js';

export interface HelloPayload {
  machine: { name: string; os: string; relayVersion: string };
  commands: { id: string; description: string; params: { name: string; description?: string; pattern: string }[] }[];
  mcpServers: { id: string; tools: OfferedTool[] }[];
}

/**
 * What this machine offers. The executable, the argument template, the folder and the env
 * never leave the machine: the platform learns ids, descriptions and parameter names and
 * patterns, nothing it could use to run something else.
 */
export function buildHello(
  config: RelayConfig,
  servers: { id: string; tools: OfferedTool[] }[],
  platform: NodeJS.Platform = process.platform,
): HelloPayload {
  return {
    machine: { name: config.machineName, os: platform, relayVersion: RELAY_VERSION },
    commands: config.commands.map((c) => ({
      id: c.id,
      description: c.description,
      params: c.params.map((p) => ({ name: p.name, ...(p.description ? { description: p.description } : {}), pattern: p.pattern })),
    })),
    mcpServers: servers.map((s) => ({ id: s.id, tools: s.tools })),
  };
}
