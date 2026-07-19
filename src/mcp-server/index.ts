// STUB -- implementado por el dev delegado bajo knowledge/contracts/ted-mcp-server.md
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EffectManifestEntry } from "../types.ts";
import type { EffectsShim } from "../shim/index.ts";
import type { AgentOutcome } from "../orchestrator/index.ts";

export interface CreateShimMcpServerOptions {
  shim: EffectsShim;
  manifest: EffectManifestEntry[];
  onReportOutcome: (outcome: AgentOutcome) => void;
}

export function createShimMcpServer(_options: CreateShimMcpServerOptions): McpServer {
  throw new Error("not implemented");
}
