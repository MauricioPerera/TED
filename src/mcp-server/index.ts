// Servidor MCP real sobre el EffectsShim bajo
// knowledge/contracts/ted-mcp-server.md. Expone cada efecto del manifiesto como
// una tool (nombre == effectId) que delega a shim.invoke, mas una tool
// report_outcome para que el agente T2 senale su resultado final. No reimplementa
// el shim: cada tool solo serializa el InvokeResult tal cual.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EffectManifestEntry } from "../types.ts";
import type { EffectsShim } from "../shim/index.ts";
import type { AgentOutcome } from "../orchestrator/index.ts";

export interface CreateShimMcpServerOptions {
  shim: EffectsShim;
  manifest: EffectManifestEntry[];
  onReportOutcome: (outcome: AgentOutcome) => void;
}

// inputSchema de cada tool de efecto: parametros de negocio arbitrarios.
const EFFECT_INPUT = z.record(z.string(), z.unknown());

// Shape (no schema unico) de report_outcome: finished obligatorio, reason opcional.
const REPORT_OUTCOME_SHAPE = {
  finished: z.enum(["fulfilled", "escalated", "failed"]),
  reason: z.string().optional(),
};

export function createShimMcpServer(options: CreateShimMcpServerOptions): McpServer {
  const server = new McpServer({ name: "ted-shim", version: "0.1.0" });
  registerEffectTools(server, options.shim, options.manifest);
  registerReportOutcome(server, options.onReportOutcome);
  return server;
}

// Una tool por efecto, nombre EXACTO effect.effectId. El callback delega al
// shim y serializa el InvokeResult completo sin interpretarlo.
function registerEffectTools(
  server: McpServer,
  shim: EffectsShim,
  manifest: EffectManifestEntry[],
): void {
  for (const effect of manifest) {
    server.registerTool(
      effect.effectId,
      { inputSchema: EFFECT_INPUT },
      (args) => invokeEffectSafely(shim, effect.effectId, args),
    );
  }
}

// Captura cualquier excepcion inesperada del callback para no tirar la conexion
// MCP abajo; la devuelve como isError: true (defensa, no deberia ocurrir).
function invokeEffectSafely(
  shim: EffectsShim,
  effectId: string,
  args: Record<string, unknown>,
) {
  try {
    const result = shim.invoke(effectId, args);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  } catch (err) {
    return {
      content: [
        { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
      ],
      isError: true,
    };
  }
}

// report_outcome: arma un AgentOutcome a partir de los argumentos (reason solo
// si vino) y lo pasa a onReportOutcome. Devuelve un texto simple cualquiera.
function registerReportOutcome(
  server: McpServer,
  onReportOutcome: (outcome: AgentOutcome) => void,
): void {
  server.registerTool(
    "report_outcome",
    { inputSchema: REPORT_OUTCOME_SHAPE },
    (args) => {
      const outcome: AgentOutcome = { finished: args.finished };
      if (args.reason !== undefined) {
        outcome.reason = args.reason;
      }
      onReportOutcome(outcome);
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );
}