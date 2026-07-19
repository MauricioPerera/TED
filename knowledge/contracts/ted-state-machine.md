---
type: 'Task Contract'
title: 'Grafo de la maquina de estados de TED (9 transiciones, actor por arista)'
description: 'Tabla declarativa pura: que transicion es legal, y que clase de actor/credencial la autoriza.'
tags: ['ted', 'state-machine']
language: typescript

task: ted-state-machine
intent: "Declarar el grafo de transiciones de TED con su actor autorizante por arista."
target: src/state-machine/index.ts
signature: "export function isLegalTransition(from: TicketState, to: TicketState, actor: Actor): boolean"
target_line: 12
test_command: "node --test tests/unit/state-machine.test.ts"
budget:
  max_cyclomatic_complexity: 6
  max_nesting_depth: 2
tests: "tests/unit/state-machine.test.ts"
tests_sha256: "5a74130d606f1d747f26e6aa87ec9a61a754b59244b3adfd98810bf43e260f56"
touch_only: ['src/state-machine/index.ts']
deps_allowed: []
forbids: ['network', 'subprocess', 'llm']
---

# Contract: Grafo de la máquina de estados de TED

## Intent
Declara, como datos puros (sin I/O, sin crypto, sin store), el grafo de
[S6](../../ticket-agent-spec.md#6-máquina-de-estados): 7 estados, 9 transiciones (S6.3), cada una
con la clase de actor/credencial que la autoriza (S6.2). Este módulo NO ejecuta transiciones
(eso lo hace `src/store` con CAS real) ni verifica credenciales criptográficas (eso lo hace
`src/attestation` / `src/crypto`) — solo responde "¿esta arista existe en el grafo para este
actor?", una consulta estructural pura, útil como guarda previa antes de gastar una verificación
cara o una escritura CAS.

## Interface
```ts
export interface TransitionEdge {
  from: TicketState;
  to: TicketState;
  actor: Actor;
}
export const TRANSITIONS: readonly TransitionEdge[]; // exactamente 9 entradas

export function isLegalTransition(from: TicketState, to: TicketState, actor: Actor): boolean;
export function legalTargets(from: TicketState, actor: Actor): TicketState[];
```
Tipos `TicketState` y `Actor` en [`src/types.ts`](../../src/types.ts) (`Actor` = `"creator" |
"fulfillment_system" | "orchestrator" | "clock"`).

### Las 9 aristas (vinculante, copiado literal de S6.3/S6.2 — no agregar ni quitar ninguna)
| from | to | actor |
|---|---|---|
| pending | leased | fulfillment_system |
| leased | fulfilled | orchestrator |
| leased | failed | orchestrator |
| leased | pending | clock |
| leased | escalated | orchestrator |
| escalated | pending | creator |
| escalated | cancelled | creator |
| pending | cancelled | creator |
| pending | expired | clock |

Nota de lectura: en `pending -> leased` el actor autorizante es `fulfillment_system` (S6.2 punto 2:
"Solo puede decir 'el trigger ocurrió'" — es su firma de transporte la que autoriza la arista,
aunque la escritura CAS la ejecute el proceso orquestador). En `leased -> pending` y
`pending -> expired` el actor es `clock`: sin credencial, se derivan deterministicamente de datos
ya firmados (S6.2 punto 4).

## Invariants
- `TRANSITIONS.length === 9` siempre.
- Ningún estado terminal (`fulfilled`, `failed`, `expired`, `cancelled`) aparece como `from` en
  ninguna arista: `legalTargets(terminal, cualquier_actor)` es siempre `[]` (S6.4 invariante 1).
- Módulo puro: sin `import` de `node:*` más allá de tipos, sin efectos secundarios, sin llamadas
  a `src/crypto`, `src/store` ni `src/bundle`.

## Examples
- `isLegalTransition("pending", "leased", "fulfillment_system")` -> `true`
- `isLegalTransition("pending", "leased", "orchestrator")` -> `false` (actor incorrecto)
- `isLegalTransition("fulfilled", "pending", "creator")` -> `false` (terminal, sin arista)
- `legalTargets("leased", "orchestrator")` -> `["fulfilled", "failed", "escalated"]` (en cualquier orden)

## Do / Don't
- DO: modelar `TRANSITIONS` como un array literal de objetos (tabla de datos), no como un switch
  gigante.
- DON'T: no importar `src/crypto`, `src/store`, `src/bundle` ni `src/constraints` — este módulo
  es puro y no depende de ningún otro módulo del proyecto salvo `src/types.ts`.
- DON'T: no agregar una décima arista ni quitar ninguna de las 9.

## Tests
Ver `tests/unit/state-machine.test.ts` (oráculo congelado, sellado por `tests_sha256`).

## Constraints
- PARAR y reportar si necesitas conectarte a la red.
- PARAR y reportar si el `intent` resulta imposible de cumplir sin violar `touch_only` o `forbids`.
