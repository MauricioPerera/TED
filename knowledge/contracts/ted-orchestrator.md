---
type: 'Task Contract'
title: 'Orquestador: pending -> leased y ensamblado'
description: 'Cadena de verificacion completa de pending->leased (transporte, CAS, atestacion/CRL/vigencia), ensamblado del shim, e invocacion del agente.'
tags: ['ted', 'orchestrator', 'seguridad']
language: typescript

task: ted-orchestrator
intent: "Implementar la cadena pending->leased del orquestador de TED."
target: src/orchestrator/index.ts
signature: "export function handleCallback(deps: OrchestratorDeps, callback: SignedCallback, now: string): CallbackOutcome"
target_line: 64
test_command: "node --test tests/unit/orchestrator.test.ts"
budget:
  max_cyclomatic_complexity: 12
  max_nesting_depth: 3
tests: "tests/unit/orchestrator.test.ts"
tests_sha256: "1c4228de2324330281b39aad73e4ef6a87085a16d22c898ee90f5a77030e3caa"
touch_only: ['src/orchestrator/index.ts']
deps_allowed: []
forbids: ['network', 'subprocess', 'llm']
---

# Contract: Orquestador — `pending -> leased` y ensamblado

## Intent
Implementa `handleCallback`, la cadena completa de
[S6.3](../../ticket-agent-spec.md#63-transiciones) `pending -> leased` descripta en el
[Apéndice A](../../ticket-agent-spec.md#apéndice-a-síntesis-del-ciclo-completo): verificación de
transporte, CAS con fencing token, cadena de atestación+CRL+vigencia (reusando
[`ted-attestation`](ted-attestation.md)), ensamblado de un [`EffectsShim`](ted-shim.md), e
invocación del agente (inyectado — en esta versión de referencia, un agente mock determinista;
ver `DEFINITION.md`). Este contrato NO reimplementa crypto, store, bundle, attestation,
constraints ni shim — solo los orquesta en la secuencia exacta de abajo.

## Interface
```ts
export interface SignedCallback { ticketId: string; payload: string; timestamp: string; signatureHex: string }
export interface BundleData {
  frontmatter: TicketFrontmatter;
  attestationSignatureHex: string;
  effects: EffectManifestEntry[];
  facts: Record<string, unknown>;
  corpusManifest: CorpusManifestEntry[];
  instructionsSha256: string;
  effectsSha256: string;
  factsSha256: string;
}
export interface AgentOutcome { finished: "fulfilled" | "escalated" | "failed"; reason?: string }
export type Agent = (shim: EffectsShim) => AgentOutcome;
export type CallbackOutcome =
  | { outcome: "invalid-transport" } | { outcome: "duplicate" }
  | { outcome: "integrity-violated" } | { outcome: "revoked" } | { outcome: "expired" }
  | { outcome: "fulfilled" } | { outcome: "escalated"; trigger?: string }
  | { outcome: "failed"; cause?: string };

export interface OrchestratorDeps {
  store: TicketStore;
  transportSecretHex: string;
  toleranceMs: number;
  leaseTtlMs: number;
  denyThreshold: number;
  execute: (tool: string, params: Record<string, unknown>) => Record<string, unknown>;
  readBundle: (ticketId: string) => BundleData;
  creatorPublicKeyHex: string;
  crl: RevocationEntry[];
  agent: Agent;
}

export function handleCallback(deps: OrchestratorDeps, callback: SignedCallback, now: string): CallbackOutcome;
```
Tipos en [`src/types.ts`](../../src/types.ts) (`TicketFrontmatter`, `EffectManifestEntry`,
`CorpusManifestEntry`), [`../attestation/index.ts`](ted-attestation.md) (`RevocationEntry`),
[`../shim/index.ts`](ted-shim.md) (`EffectsShim`), [`../store/index.ts`](ted-store.md)
(`TicketStore`). `readBundle` abstrae la lectura real de `src/bundle` (frontmatter + effects +
facts + hashes + manifiesto de corpus) para que este contrato se pruebe con datos inyectados, sin
tocar disco — quien conecte esto a bundles reales (Batch 5) provee un `readBundle` que sí llama a
`src/bundle`.

## Invariants

La secuencia de `handleCallback`, EN ESTE ORDEN:

1. **Transporte**: `verifyTransport(callback.payload, deps.transportSecretHex,
   callback.timestamp, callback.signatureHex, now, deps.toleranceMs)`. Si es inválido ->
   `{ outcome: "invalid-transport" }` **sin tocar el store en absoluto** (ni siquiera un intento
   de CAS — un mensaje no autenticado no debe revelar ni afectar el estado del ticket).
2. **CAS**: `store.acquireLease(callback.ticketId, deps.leaseTtlMs, now)`. Si devuelve `null`
   (duplicado, o ticket ya no `pending`, o inexistente) -> `{ outcome: "duplicate" }` (S6.3: se
   absorbe con éxito silencioso).
3. **Ensamblar el payload de atestación** desde `deps.readBundle(callback.ticketId)` y
   `frontmatter.attestation.{attestedAt,validUntil}`, y llamar
   `verifyPendingToLeased({ attestation, attestationSignatureHex, creatorPublicKeyHex: deps.creatorPublicKeyHex, actualInstructionsSha256: bundle.instructionsSha256, actualEffectsSha256: bundle.effectsSha256, actualFactsSha256: bundle.factsSha256, actualCorpusManifest: bundle.corpusManifest, crl: deps.crl, now })`.
   - `"integrity-violated"` -> `store.transition(ticketId, fencingToken, ["leased"], "failed",
     "integrity-violated")` -> `{ outcome: "integrity-violated" }`.
   - `"revoked"` -> `store.transition(ticketId, fencingToken, ["leased"], "cancelled")` ->
     `{ outcome: "revoked" }`.
   - `"expired"` -> `store.transition(ticketId, fencingToken, ["leased"], "expired")` ->
     `{ outcome: "expired" }`.
   - `"proceed"` -> continuar al paso 4.
4. **Ensamblar el shim**: compilar las constraints de cada efecto
   (`compileConstraint` por cada string de `effect.constraints`) en un
   `Map<string, CompiledConstraint[]>`, y construir un `EffectsShim` con
   `{ store, ticketId, fencingToken, manifest: bundle.effects, compiledConstraints, facts:
   bundle.facts, now, denyThreshold: deps.denyThreshold, execute: deps.execute }`.
5. **Invocar al agente**: `const outcome = deps.agent(shim)`.
   - `"fulfilled"` -> `store.transition(ticketId, fencingToken, ["leased"], "fulfilled")` ->
     `{ outcome: "fulfilled" }`.
   - `"escalated"` -> `store.transition(ticketId, fencingToken, ["leased"], "escalated")` ->
     `{ outcome: "escalated", trigger: outcome.reason }`.
   - `"failed"` -> `store.transition(ticketId, fencingToken, ["leased"], "failed",
     "agent-aborted")` -> `{ outcome: "failed", cause: outcome.reason }`.

El `fencingToken` usado en los pasos 3 y 5 es el que devolvió `acquireLease` en el paso 2 (no se
vuelve a leer del store).

## Examples
- Firma de transporte inválida -> `{ outcome: "invalid-transport" }`, el store queda sin tocar.
- Contenido alterado tras la firma -> `{ outcome: "integrity-violated" }`, ticket en `failed` con
  `failureCause: "integrity-violated"`.
- Ticket en el CRL -> `{ outcome: "revoked" }`, ticket en `cancelled`.
- Camino feliz (agente ejecuta un efecto permitido) -> `{ outcome: "fulfilled" }`, ticket en
  `fulfilled`.

## Do / Don't
- DO: descomponer `handleCallback` en funciones privadas por fase (verificación de transporte +
  CAS, cadena de atestación, ensamblado del shim, invocación del agente) — el presupuesto de
  complejidad es por función, no por archivo entero.
- DO: reusar `compileConstraint` de `../constraints/index.ts`, `verifyTransport`/`sha256Hex` de
  `../crypto/index.ts`, `verifyPendingToLeased` de `../attestation/index.ts`, `EffectsShim` de
  `../shim/index.ts`.
- DON'T: no llames a `deps.agent` antes de que la cadena de atestación dé `"proceed"`.
- DON'T: no leas el estado del ticket del store de nuevo tras `acquireLease` para decidir el
  `fencingToken` — usá el que ya devolvió esa llamada.

## Tests
Ver `tests/unit/orchestrator.test.ts` (oráculo congelado, sellado por `tests_sha256`).

## Constraints
- PARAR y reportar si necesitas conectarte a la red.
- PARAR y reportar si el `intent` resulta imposible de cumplir sin violar `touch_only` o `forbids`.
