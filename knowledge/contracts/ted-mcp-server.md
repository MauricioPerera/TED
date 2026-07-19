---
type: 'Task Contract'
title: 'Servidor MCP real sobre el shim de efectos'
description: 'Expone cada efecto del manifiesto como tool MCP, delegando a EffectsShim.invoke; agrega report_outcome para que el agente T2 senale su resultado final.'
tags: ['ted', 'mcp-server', 'shim']
language: typescript

task: ted-mcp-server
intent: "Exponer EffectsShim como servidor MCP real usando el SDK oficial."
target: src/mcp-server/index.ts
signature: "export function createShimMcpServer(options: CreateShimMcpServerOptions): McpServer"
target_line: 12
test_command: "node --test tests/unit/mcp-server.test.ts"
budget:
  max_cyclomatic_complexity: 8
  max_nesting_depth: 3
tests: "tests/unit/mcp-server.test.ts"
tests_sha256: "43160940bcb25c64a86dcf2ce790c36e30a91c0849a4fb75e09bc7200c357539"
touch_only: ['src/mcp-server/index.ts']
deps_allowed: ['@modelcontextprotocol/sdk', 'zod']
forbids: ['network', 'subprocess', 'llm']
---

# Contract: Servidor MCP real sobre el shim de efectos

## Intent
Implementa la capa de transporte que
[S11.1](../../ticket-agent-spec.md#111-posición-proxy-mcp) exige y que
[`ted-shim`](ted-shim.md) dejó explícitamente fuera de su alcance: un servidor MCP real (via
`@modelcontextprotocol/sdk`, ya instalado) que expone **exactamente** los efectos del manifiesto
como tools — "la tool list del agente es el manifiesto y punto" — más una tool `report_outcome`
para que el agente T2 (Batch 6d) señale su resultado final sin que el orquestador necesite
inspeccionar su salida de texto libre. Este contrato NO reimplementa `EffectsShim` — cada tool
delega la invocación completa a `shim.invoke(effectId, params)`.

## Interface
```ts
export interface CreateShimMcpServerOptions {
  shim: EffectsShim;
  manifest: EffectManifestEntry[];
  onReportOutcome: (outcome: AgentOutcome) => void;
}
export function createShimMcpServer(options: CreateShimMcpServerOptions): McpServer;
```
`McpServer` es `@modelcontextprotocol/sdk/server/mcp.js`. `EffectsShim` en
[`../shim/index.ts`](ted-shim.md). `EffectManifestEntry` en [`src/types.ts`](../../src/types.ts).
`AgentOutcome` en [`../orchestrator/index.ts`](ted-orchestrator.md) (ya definido ahí — no lo
redeclares, importalo).

## Invariants
- **Una tool por efecto del manifiesto**, con nombre EXACTO `effect.effectId` (no `effect.tool` —
  ese es "la operación real subyacente", S4.3, un detalle interno que el agente no necesita ver).
  `inputSchema` de cada tool: `z.record(z.string(), z.unknown())` (los parámetros del efecto son
  datos de negocio arbitrarios, no una forma fija). El callback de la tool llama
  `shim.invoke(effect.effectId, args)` y devuelve
  `{ content: [{ type: "text", text: JSON.stringify(<resultado> ) }] }` — el `InvokeResult`
  completo (outcome/reason/trigger/data, lo que `shim.invoke` haya devuelto), serializado tal
  cual, SIN interpretarlo ni filtrarlo más — el shim ya hizo esa mediación.
- **Una tool adicional `report_outcome`**, con `inputSchema` como shape (`{ finished: z.enum([...]),
  reason: z.string().optional() }`, NO como schema único), que arma un `AgentOutcome` a partir de
  los argumentos (`reason` solo si vino) y llama `options.onReportOutcome(outcome)`; devuelve
  cualquier `content` de texto simple (no hace falta que el agente lo lea).
- **Mediación completa por construcción (S11.1)**: NINGUNA otra tool se registra. Un nombre de
  tool que no está en el manifiesto ni es `report_outcome` NUNCA llega a `shim.invoke` — el propio
  SDK responde con un error MCP (`isError: true`) antes de que el código de este módulo se
  ejecute, porque esa tool jamás se registró.
- **Excepciones inesperadas dentro del callback de un efecto** (no deberían ocurrir dado el
  contrato de `EffectsShim`, pero como defensa) se capturan y se devuelven como
  `{ content: [{ type: "text", text: <mensaje> }], isError: true }` — nunca deben tirar la
  conexión MCP abajo.

## Examples
- `client.listTools()` sobre un manifiesto de 2 efectos -> exactamente 3 tools:
  los 2 `effectId` más `"report_outcome"`.
- Efecto denegado por constraint -> el `content` de texto, parseado como JSON, es
  `{ outcome: "rejected", reason: "constraint-denied" }` (no `isError`).
- Tool inexistente -> `isError: true` sin que `shim.invoke` se haya llamado jamás.
- `report_outcome` con `{ finished: "failed", reason: "agent-aborted" }` -> el callback
  `onReportOutcome` recibe exactamente `{ finished: "failed", reason: "agent-aborted" }`.

## Do / Don't
- DO: usar `new McpServer({ name: "ted-shim", version: "0.1.0" })` y `server.registerTool(...)`
  por cada efecto, más una vez para `report_outcome`.
- DO: descomponer el registro de tools en funciones privadas pequeñas (una para efectos, una para
  `report_outcome`) — el presupuesto de complejidad es por función.
- DON'T: no valides ni reinterpretes el `InvokeResult` del shim — se serializa tal cual.
- DON'T: no agregues tools de diagnóstico, listado, ni ninguna otra fuera de las descriptas.

## Tests
Ver `tests/unit/mcp-server.test.ts` (oráculo congelado con `InMemoryTransport` + un `Client` real
del SDK — protocolo real, sin subproceso, determinista; sellado por `tests_sha256`).

## Constraints
- PARAR y reportar si necesitas conectarte a la red.
- PARAR y reportar si el `intent` resulta imposible de cumplir sin violar `touch_only` o `forbids`.
