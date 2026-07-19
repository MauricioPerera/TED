---
type: 'Task Contract'
title: 'Shim de efectos: pipeline de mediacion'
description: 'Motor de mediacion del shim (resolucion, ledger, constraints, attempted/confirmed, lecturas tipadas) reusando store/constraints/escalation.'
tags: ['ted', 'shim', 'mediacion', 'seguridad']
language: typescript

task: ted-shim
intent: "Implementar el pipeline de mediacion del shim de efectos de TED."
target: src/shim/index.ts
signature: "invoke(effectId: string, params: Record<string, unknown>): InvokeResult"
target_line: 32
test_command: "node --test tests/unit/shim.test.ts"
budget:
  max_cyclomatic_complexity: 10
  max_nesting_depth: 3
tests: "tests/unit/shim.test.ts"
tests_sha256: "26a048ac3c6723806206d7e2f9671ae0b0178ec763a888c56decb987d70ab195"
touch_only: ['src/shim/index.ts']
deps_allowed: []
forbids: ['network', 'subprocess', 'llm']
---

# Contract: Shim de efectos — pipeline de mediación

## Intent
Implementa la [secuencia de mediación](../../ticket-agent-spec.md#112-secuencia-de-mediación)
de `EffectsShim.invoke`, reusando `src/store` (ledger CAS + fencing token),
`src/constraints` (evaluación permit/deny/error) y `src/escalation` (disparadores duros +
`DenyTracker`) — este contrato NO reimplementa ninguno de esos tres, solo los orquesta. Es el
**motor** de mediación; exponerlo como servidor MCP real (§11.1) es una capa aparte fuera de esta
tarea (ver `DEFINITION.md`).

**Nota sobre la ausencia de un tool call real:** el `execute` inyectado en `ShimDeps` representa
la ejecución del efecto contra el mundo (o, en esta versión de referencia, contra el agente mock
de Batch 4). El shim no sabe ni le importa qué hay detrás; media exactamente igual.

## Interface
```ts
export interface ShimDeps {
  store: TicketStore;
  ticketId: string;
  fencingToken: number;
  manifest: EffectManifestEntry[];
  compiledConstraints: Map<string, CompiledConstraint[]>; // effectId -> constraints ya compiladas
  facts: Record<string, unknown>;
  now: string;
  denyThreshold: number;
  execute: (tool: string, params: Record<string, unknown>) => Record<string, unknown>;
}

export type InvokeRejectionReason =
  | "constraint-denied" | "stale-lease"
  | "already-confirmed-data-unavailable" | "schema-violation";

export type InvokeResult =
  | { outcome: "result"; data: Record<string, unknown> }
  | { outcome: "rejected"; reason: InvokeRejectionReason }
  | { outcome: "escalated"; trigger: EscalationTrigger };

export class EffectsShim {
  constructor(deps: ShimDeps);
  invoke(effectId: string, params: Record<string, unknown>): InvokeResult;
}
```
Tipos `EffectManifestEntry` en [`src/types.ts`](../../src/types.ts); `CompiledConstraint` en
[`../constraints/index.ts`](ted-constraints.md); `TicketStore` en
[`../store/index.ts`](ted-store.md); `EscalationTrigger` en
[`../escalation/index.ts`](ted-escalation.md).

## Invariants

El pipeline de `invoke(effectId, params)`, EN ESTE ORDEN:

1. **Resolución**: si `effectId` no está en `manifest` -> `classifyEvent({kind:"unknown_tool"})`
   -> `{ outcome: "escalated", trigger: "unknown-tool-invoked" }`. `execute` NUNCA se llama.
2. **Caché local**: el shim mantiene un `ConstraintLedgerSnapshot` local (en memoria, vida = esta
   instancia) que registra, por `effectId` confirmado, `{ state: "confirmed", ...params,
   ...result }`. Si ya está `"confirmed"` localmente -> devolver `{ outcome: "result", data:
   <result cacheado> }` sin llamar `execute` de nuevo (replay idempotente, S11.2 paso 2).
3. **Caché ausente pero store dice confirmado** (sucesor sin caché local, p.ej. un proceso
   nuevo): si `store.ledgerGet(ticketId, effectId)?.state === "confirmed"` pero NO está en la
   caché local -> `{ outcome: "rejected", reason: "already-confirmed-data-unavailable" }`. NUNCA
   re-ejecutar un efecto que el store ya marca `confirmed` — la seguridad (no doble-ejecución)
   importa más que la conveniencia del replay cuando no hay dato cacheado.
4. **`max_invocations`**: si `store.ledgerGet(ticketId, effectId)` existe, su estado NO es
   `"confirmed"`, y su `invocationCount >= manifest[effectId].maxInvocations` ->
   `classifyEvent({kind:"max_invocations_reached"})` -> `{ outcome: "escalated", trigger:
   "max-invocations-reached" }`. `execute` NUNCA se llama.
5. **Constraints**: `evaluateAll(compiledConstraints.get(effectId) ?? [], params, facts,
   <caché local como ConstraintLedgerSnapshot>, now)`.
   - `"error"` -> `classifyEvent({kind:"constraint_verdict", verdict:"error"})` ->
     `{ outcome: "escalated", trigger: "constraint-error" }`. `execute` NUNCA se llama.
   - `"deny"` -> `denyTracker.recordDeny(effectId)`; si `denyTracker.shouldEscalate(effectId,
     denyThreshold)` -> `{ outcome: "escalated", trigger: "repeated-deny" }`; si no ->
     `{ outcome: "rejected", reason: "constraint-denied" }`. `execute` NUNCA se llama en ninguno
     de los dos casos.
   - `"permit"` -> continuar al paso 6 (llamar `denyTracker.recordNonDeny(effectId)` es
     correcto por higiene aunque, en este pipeline, un permit siempre confirma el efecto de
     forma terminal — no hay un caso observable donde ese reset se note para el MISMO
     `effectId` después).
6. **Asiento `attempted`**: `store.ledgerMarkAttempted(ticketId, effectId, fencingToken,
   <hash de params>, now)`. Si devuelve `null` (fencing token vencido — agente zombie, S6.4
   invariante 4) -> `{ outcome: "rejected", reason: "stale-lease" }`. `execute` NUNCA se llama.
7. **Ejecución**: `const result = execute(manifest[effectId].tool, params)`.
8. **Validación de lecturas tipadas** (S11.4, solo si `manifest[effectId].kind === "read"`):
   filtrar `result` a EXACTAMENTE las claves declaradas en `responseSchema` (descartar toda
   clave no declarada); si falta una clave declarada o su tipo (`typeof`) no coincide con el
   declarado (`"string" | "number" | "boolean"`) -> `{ outcome: "rejected", reason:
   "schema-violation" }` (el asiento `attempted` del paso 6 YA se hizo — no hace falta
   deshacerlo, es solo un registro de intento). Para `kind: "write"` no se filtra nada.
9. **Asiento `confirmed`**: `store.ledgerMarkConfirmed(ticketId, effectId, <hash del resultado
   filtrado>, now)`.
10. **Actualizar la caché local**: `{ state: "confirmed", ...params, ...resultado filtrado }`
    para ese `effectId` (alimenta agregaciones `sum()` de constraints futuras, S12.6).
11. Devolver `{ outcome: "result", data: <resultado filtrado> }`.

## Examples
- Efecto inexistente -> `{ outcome: "escalated", trigger: "unknown-tool-invoked" }`
- Constraint deniega 1ª y 2ª vez (`denyThreshold: 2`) -> la 2ª ya es
  `{ outcome: "escalated", trigger: "repeated-deny" }`, no `"rejected"`
- Efecto `kind: "read"` cuyo `execute` devuelve un campo no declarado -> ese campo NO aparece en
  `data`
- Dos efectos confirmados con `amount` numérico alimentan `sum(ledger.*.amount)` para un tercer
  efecto con esa constraint

## Do / Don't
- DO: mantener `invoke()` como un dispatcher fino — delegar cada paso del pipeline (resolución,
  chequeo de caché, constraints, ejecución, validación de esquema) a métodos privados chicos de
  una sola responsabilidad. El presupuesto de complejidad es por FUNCIÓN, no por clase.
- DO: hashear `params` y el resultado con `sha256Hex` de `../crypto/index.ts` para los argumentos
  `paramsHash`/`resultHash` de `store.ledgerMarkAttempted`/`ledgerMarkConfirmed`
  (`JSON.stringify` alcanza para el hash, no hace falta canonicalización estable acá).
- DON'T: no llames a `execute` antes de completar los pasos 1-6 en orden.
- DON'T: no agregues estado global ni singletons — toda la caché vive en la instancia de
  `EffectsShim`.

## Tests
Ver `tests/unit/shim.test.ts` (oráculo congelado, sellado por `tests_sha256`).

## Constraints
- PARAR y reportar si necesitas conectarte a la red.
- PARAR y reportar si el `intent` resulta imposible de cumplir sin violar `touch_only` o `forbids`.
