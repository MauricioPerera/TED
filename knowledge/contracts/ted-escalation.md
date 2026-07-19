---
type: 'Task Contract'
title: 'Disparadores duros de escalada'
description: 'Clasificador puro de eventos en disparadores duros de escalada (S13.1), mas un tracker de denies repetidos.'
tags: ['ted', 'escalation', 'seguridad']
language: typescript

task: ted-escalation
intent: "Clasificar eventos deterministas en disparadores duros de escalada de TED."
target: src/escalation/index.ts
signature: "export function classifyEvent(event: EscalationEvent): EscalationDecision"
target_line: 24
test_command: "node --test tests/unit/escalation.test.ts"
budget:
  max_cyclomatic_complexity: 8
  max_nesting_depth: 3
tests: "tests/unit/escalation.test.ts"
tests_sha256: "069312537e2d9970854d4941ae893e925d58c355069a6105ae7b718d444c6342"
touch_only: ['src/escalation/index.ts']
deps_allowed: []
forbids: ['network', 'subprocess', 'llm']
---

# Contract: Disparadores duros de escalada

## Intent
Implementa los disparadores DUROS de escalada de
[S13.1](../../ticket-agent-spec.md#131-disparadores-en-dos-clases): "deterministas, computados en
shim y orquestador, fuera del alcance de la persuasión". Este módulo es puro (sin I/O, sin
crypto, sin store) y NO implementa disparadores blandos (juez, confianza del modelo) — esos están
fuera de alcance en esta versión (ver [DEFINITION.md](../../DEFINITION.md), sección "Fuera de
alcance").

## Interface
```ts
export type EscalationTrigger =
  | "constraint-error"
  | "ambiguous-effect"
  | "retry-exhaustion-imminent"
  | "unknown-tool-invoked"
  | "max-invocations-reached"
  | "repeated-deny";

export interface EscalationDecision { escalate: boolean; trigger?: EscalationTrigger }

export type EscalationEvent =
  | { kind: "constraint_verdict"; verdict: ConstraintVerdict }
  | { kind: "unknown_tool" }
  | { kind: "max_invocations_reached" }
  | { kind: "ambiguous_effect"; reconciliationPossible: boolean }
  | { kind: "lease_attempts"; attempts: number; maxAttempts: number };

export function classifyEvent(event: EscalationEvent): EscalationDecision;

export class DenyTracker {
  recordDeny(effectId: string): number;   // devuelve el contador consecutivo tras incrementar
  recordNonDeny(effectId: string): void;  // resetea el contador de ese effectId a 0
  shouldEscalate(effectId: string, threshold: number): boolean;
}
```
`ConstraintVerdict` en [`src/types.ts`](../../src/types.ts).

## Invariants
- `constraint_verdict` con `verdict: "error"` -> SIEMPRE `{ escalate: true, trigger:
  "constraint-error" }` (S12.3: el contrato mal formado excede la autoridad del agente).
  `"deny"`/`"permit"` -> nunca escalan por sí solos (S13.1: "el sistema funcionando").
- `unknown_tool` y `max_invocations_reached` -> siempre escalan (S11.2 pasos 1 y 2).
- `ambiguous_effect`: escala si y solo si `reconciliationPossible === false` (S11.3 opción 3 —
  con reconciliación posible, opciones 1/2 se resuelven sin escalar).
- `lease_attempts`: escala si y solo si `attempts === maxAttempts - 1` (el PRÓXIMO reclaim
  agotaría los reintentos — señal de agotamiento inminente, S13.1). Cualquier otro valor no
  escala (ni por debajo ni al llegar exactamente a `maxAttempts`, que ya es terminal por el store).
- `DenyTracker.recordDeny(id)` incrementa y devuelve el contador consecutivo de ESE `effectId`;
  `recordNonDeny(id)` lo resetea a 0; `shouldEscalate(id, threshold)` es `true` si y solo si el
  contador actual de ese `effectId` es `>= threshold`. Los contadores de distintos `effectId` son
  independientes entre sí.

## Examples
- `classifyEvent({ kind: "constraint_verdict", verdict: "error" })` -> `{ escalate: true, trigger: "constraint-error" }`
- `classifyEvent({ kind: "lease_attempts", attempts: 2, maxAttempts: 3 })` -> `{ escalate: true, trigger: "retry-exhaustion-imminent" }`
- `classifyEvent({ kind: "ambiguous_effect", reconciliationPossible: true })` -> `{ escalate: false }`
- Tres `recordDeny` seguidas al mismo `effectId` con `threshold: 3` -> `shouldEscalate` pasa a `true` recién en la tercera

## Do / Don't
- DO: mantener el módulo puro — sin `import` de `node:*`, sin dependencias de otros módulos del
  proyecto salvo tipos de `src/types.ts`.
- DON'T: no implementes disparadores blandos (juez, "el agente declara que no puede fundamentar")
  — eso es lo RECOMENDADO y explícitamente fuera de alcance acá.

## Tests
Ver `tests/unit/escalation.test.ts` (oráculo congelado, sellado por `tests_sha256`).

## Constraints
- PARAR y reportar si necesitas conectarte a la red.
- PARAR y reportar si el `intent` resulta imposible de cumplir sin violar `touch_only` o `forbids`.
