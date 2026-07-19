---
type: 'Task Contract'
title: 'Evaluador de constraints (permit/deny/error)'
description: 'Lenguaje minimo, determinista, de entorno cerrado para evaluar constraints de efectos.'
tags: ['ted', 'constraints', 'seguridad']
language: typescript

task: ted-constraints
intent: "Implementar un evaluador determinista de constraints con semantica permit/deny/error sobre un entorno cerrado."
target: src/constraints/index.ts
signature: "export function evaluateConstraint(compiled: CompiledConstraint, params: Record<string, unknown>, facts: Record<string, unknown>, ledger: ConstraintLedgerSnapshot, now: string): ConstraintEvalResult"
target_line: 14
test_command: "node --test tests/unit/constraints.test.ts"
budget:
  max_cyclomatic_complexity: 10
  max_nesting_depth: 4
tests: "tests/unit/constraints.test.ts"
tests_sha256: "ac2ba124c932276f2bea56e94d1d0bb3f62eeb0ccb252baa872cce1decb2a16c"
touch_only: ['src/constraints/index.ts']
deps_allowed: []
forbids: ['network', 'subprocess', 'llm']
---

# Contract: Evaluador de constraints

## Intent
Implementa el lenguaje de constraints de
[S12](../../ticket-agent-spec.md#12-el-lenguaje-de-constraints): total, determinista, evaluable
solo contra un entorno cerrado por tipo (S12.2), con semántica `permit`/`deny`/`error` (S12.3),
`now` como input explícito nunca leído del reloj (S12.4), composición conjuntiva pura (S12.5), y
auditoría por reproducción (S12.7). NO se implementa un lenguaje general (CEL/Rego/Cedar reales):
se implementa exactamente la gramática mínima de abajo, que cubre los dos ejemplos normativos de
S12.6 (`ledger.charge.state == "confirmed"` y
`sum(ledger.*.amount) + params.amount <= facts.budget_total`).

## Interface
```ts
export class ConstraintCompileError extends Error {}
export interface CompiledConstraint { source: string }

export function compileConstraint(source: string): CompiledConstraint;
export function evaluateConstraint(compiled: CompiledConstraint, params: Record<string, unknown>, facts: Record<string, unknown>, ledger: ConstraintLedgerSnapshot, now: string): ConstraintEvalResult;
export function evaluateAll(compiled: CompiledConstraint[], params: Record<string, unknown>, facts: Record<string, unknown>, ledger: ConstraintLedgerSnapshot, now: string): ConstraintEvalResult;
```
Tipos (`ConstraintEvalResult`, `ConstraintLedgerSnapshot`, `ConstraintVerdict`) en
[`src/types.ts`](../../src/types.ts). `ConstraintLedgerSnapshot` es
`Record<string, Record<string, unknown>>` — un snapshot de negocio por efecto (ej.
`{ charge: { state: "confirmed", amount: 100 } }`), no el `LedgerEntry` interno del store.

### Gramática (vinculante — no ampliar ni reducir)
```
constraint := expr comparator expr
comparator := "==" | "!=" | "<" | "<=" | ">" | ">="
expr        := term ("+" term)*
term        := literal | "now" | path | "sum(" path ")"
literal     := number | '"' string '"' | "true" | "false"
path        := root ("." segment)*
root        := "params" | "facts" | "ledger"
segment     := identifier | "*"
```
- `path` con root fuera de `{params, facts, ledger}` (o el término suelto `now`) NO COMPILA:
  `compileConstraint` DEBE lanzar `ConstraintCompileError` (S12.2 — es inexpresable, no `deny`).
- `sum(ledger.*.amount)`: para cada clave del objeto `ledger`, toma `.amount` de su valor y suma.
- `==`/`!=`: comparación de igualdad estricta tras resolver ambos lados; si los tipos resueltos
  difieren (ej. string vs number) -> verdict `"error"`.
- `<`/`<=`/`>`/`>=`: solo válido entre dos números, o entre dos strings ISO-8601
  (`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`, comparados por `Date.parse`). Cualquier otra
  combinación -> `"error"`.
- Un path que referencia una clave ausente en tiempo de evaluación (ej. `facts.no_existe`) ->
  `"error"` (S12.3: "el contrato no describe la realidad", se escala, no se deniega).

## Invariants
- Ningún método lee `Date.now()` — `now` siempre es el parámetro string.
- `evaluateAll` es conjunción pura: si CUALQUIER constraint da `"error"`, el resultado agregado es
  `"error"` (precedencia sobre `deny`: el contrato mal formado es más urgente que un deny limpio).
  Si ninguno da error pero al menos uno da `"deny"`, el agregado es `"deny"`. Solo si todos dan
  `"permit"` el agregado es `"permit"`.
- `ConstraintEvalResult.auditTrail` es reproducible: mismos inputs (`params`, `facts`, `ledger`,
  `now`) -> mismos hashes en el `auditTrail`, siempre (S12.7).

## Examples
- `compileConstraint("context.foo == 1")` -> lanza `ConstraintCompileError`
- `evaluateConstraint(compileConstraint("params.amount == facts.limit"), {amount:100}, {}, {}, now)` -> `verdict: "error"` (falta `facts.limit`)
- `evaluateConstraint(compileConstraint('ledger.charge.state == "confirmed"'), {}, {}, {charge:{state:"confirmed"}}, now)` -> `verdict: "permit"`
- `evaluateAll([...])` con un constraint en `"error"` y otro en `"deny"` -> `verdict: "error"`

## Do / Don't
- DO: implementar la gramática EXACTA de arriba (tokenizer + parser recursivo simple alcanza).
- DO: devolver `"error"` (nunca lanzar excepción) para faltantes/tipos incompatibles en
  evaluación — solo `compileConstraint` lanza, y solo por referencias fuera del entorno cerrado.
- DON'T: no traer una librería CEL/Rego real ni ampliar la gramática (sin recursión, sin
  cuantificadores generales, sin funciones más allá de `sum`).
- DON'T: no usar lógica trivalente con propagación de "unknown" entre operadores (S12.3).

## Tests
Ver `tests/unit/constraints.test.ts` (oráculo congelado, sellado por `tests_sha256`).

## Constraints
- PARAR y reportar si necesitas conectarte a la red.
- PARAR y reportar si el `intent` resulta imposible de cumplir sin violar `touch_only` o `forbids`.
