---
type: 'Task Contract'
title: 'Ensamblador CCDD especifico de TED (5 slots de S8)'
description: 'Arma el prompt del agente T2 con los 5 slots del ejemplo de S8, respetando prioridad, presupuesto y las reglas de compaction none/truncate.'
tags: ['ted', 'assembler', 'ccdd']
language: typescript

task: ted-assembler
intent: "Implementar el ensamblador de contexto especifico de TED de S8."
target: src/assembler/index.ts
signature: "export function assembleContext(input: AssemblerInput): AssembledContext"
target_line: 30
test_command: "node --test tests/unit/assembler.test.ts"
budget:
  max_cyclomatic_complexity: 8
  max_nesting_depth: 3
tests: "tests/unit/assembler.test.ts"
tests_sha256: "8ac3088922e7d6a628654508699dfd243c20694d7c9af4c232bd40615beff10c"
touch_only: ['src/assembler/index.ts']
deps_allowed: []
forbids: ['network', 'subprocess', 'llm']
---

# Contract: Ensamblador CCDD específico de TED

## Intent
Implementa el ensamblador de
[S8](../../ticket-agent-spec.md#8-rehidratación-el-contrato-ccdd-del-ticket) para los 5 slots
EXACTOS de su ejemplo normativo — no un intérprete genérico de contratos CCDD arbitrarios (decisión
de alcance, ver `DEFINITION.md`). Módulo puro: sin I/O, sin red, sin llamadas a un modelo real
(no hay compactador real — RECOMENDADO y fuera de alcance, S10.3 — así que `world_context` se
*trunca*, no se *resume*; documentado como simplificación, no como bug).

## Interface
```ts
export interface AssemblerInput {
  instructionsText: string;
  effectsText: string;
  factsText: string;
  triggerPayload: string;
  worldContext?: string;
  maxTokens: number;
  reserveOutput: number;
}
export type SlotId = "ticket_instructions" | "effects_manifest" | "signed_facts" | "trigger_payload" | "world_context";
export interface AssembledSlot { id: SlotId; content: string; truncated: boolean }
export interface AssembledContext {
  slots: AssembledSlot[];
  prompt: string;
  totalEstimatedTokens: number;
  budgetExceededBeforeTruncation: boolean;
}
export function assembleContext(input: AssemblerInput): AssembledContext;
```

## Invariants

**Estimación de tokens**: `Math.ceil(text.length / 4)` (aproximación por caracteres, documentada
como tal — este proyecto no agrega una dependencia de tokenizer real).

**Presupuesto disponible para slots**: `availableForSlots = max(0, maxTokens - reserveOutput)`.

**Orden de prioridad y sacrificio (S8: "si el presupuesto aprieta, se sacrifica todo lo demás
antes")**, en este orden exacto:

1. Los 3 slots firmados (`ticket_instructions`, `effects_manifest`, `signed_facts`,
   `compaction: none` en S8) **NUNCA se truncan**, sin importar el presupuesto — se incluyen
   siempre en su totalidad. `signedTokens` = suma de sus tokens estimados.
2. `remainingAfterSigned = availableForSlots - signedTokens` (puede ser negativo).
3. `trigger_payload` (S8: `max_tokens: 1000`): presupuesto propio =
   `min(1000, max(0, remainingAfterSigned))`. Si el contenido excede ese presupuesto en
   caracteres (`presupuesto * 4`), se trunca a ese límite y se le agrega el sufijo literal
   `"\n[truncado]"`; si el presupuesto es `0`, el contenido queda `""` (`truncated: true` si el
   original no estaba vacío).
4. `remainingAfterTrigger = remainingAfterSigned - <tokens estimados del trigger YA truncado>`.
5. `world_context` (S8: `max_tokens: 6000`): presupuesto propio =
   `min(6000, max(0, remainingAfterTrigger))`, mismo mecanismo de truncado que el trigger. Si
   `worldContext` es `undefined`, el slot es `{ content: "", truncated: false }`.

**`prompt`**: concatena, EN ORDEN DE PRIORIDAD (`ticket_instructions`, `effects_manifest`,
`signed_facts`, `trigger_payload`, `world_context`), cada slot cuyo `content` no esté vacío, como
`` `## <Heading>\n<content>` `` unido por `"\n\n"`. Encabezados exactos: `"Instructions"`,
`"Effects Manifest"`, `"Signed Facts"`, `"Trigger"`, `"World Context"`. Un slot con `content`
vacío NO aparece en el prompt (ni encabezado ni cuerpo).

**`totalEstimatedTokens`**: suma de tokens estimados de los 5 `content` finales (post-truncado).

**`budgetExceededBeforeTruncation`**: `true` si la suma de tokens estimados de los 5 contenidos
SIN truncar (`instructionsText` + `effectsText` + `factsText` + `triggerPayload` +
`(worldContext ?? "")`) supera `availableForSlots`; puramente informativo, no cambia el resultado
del ensamblado.

**Determinismo**: llamar dos veces con el mismo `input` produce el mismo `prompt` y el mismo
`totalEstimatedTokens`, siempre (sin `Date.now()`, sin aleatoriedad).

## Examples
- Todo entra sin truncar -> los 5 slots con `truncated: false`, en orden en el `prompt`.
- `triggerPayload` de 20000 caracteres con presupuesto enorme -> se trunca igual a ~1000 tokens
  (4000 caracteres) por su propio tope, no por el presupuesto total.
- `instructionsText` grande + `maxTokens` chico -> `ticket_instructions` se incluye COMPLETO;
  `trigger_payload`/`world_context` quedan en `""`.
- `worldContext` no provisto -> slot `world_context` vacío, sin encabezado en el `prompt`.

## Do / Don't
- DO: implementar el sacrificio en el orden exacto (signed intocables -> trigger -> world).
- DO: usar el sufijo literal `"\n[truncado]"` cuando se trunca contenido no vacío.
- DON'T: no agregues una dependencia de tokenizer real ni de resumen/compactación con modelo.
- DON'T: no toques la lógica de otros módulos — este es puro y autocontenido.

## Tests
Ver `tests/unit/assembler.test.ts` (oráculo congelado, sellado por `tests_sha256`).

## Constraints
- PARAR y reportar si necesitas conectarte a la red.
- PARAR y reportar si el `intent` resulta imposible de cumplir sin violar `touch_only` o `forbids`.
