---
type: 'Task Contract'
title: 'Bundle del ticket (lectura/escritura, hashes, manifiesto de corpus)'
description: 'Lee y escribe el directorio del ticket (ticket.md, effects.md, facts.md, context/) y verifica sus hashes contra la atestacion.'
tags: ['ted', 'bundle', 'okf']
language: typescript

task: ted-bundle
intent: "Implementar el acceso al bundle del ticket."
target: src/bundle/index.ts
signature: "export function readTicketFrontmatter(ticketDir: string): TicketFrontmatter"
target_line: 8
test_command: "node --test tests/unit/bundle.test.ts"
budget:
  max_cyclomatic_complexity: 8
  max_nesting_depth: 3
tests: "tests/unit/bundle.test.ts"
tests_sha256: "0dfb412362271f4aa744a8d35a1fb92e8a81f07eb304bf4010ee6476de355120"
touch_only: ['src/bundle/index.ts']
deps_allowed: ['yaml']
forbids: ['network', 'subprocess', 'llm']
---

# Contract: Bundle del ticket

## Intent
Implementa el acceso al directorio del ticket definido en
[S4](../../ticket-agent-spec.md#4-estructura-del-bundle): `ticket.md` (frontmatter + cuerpo),
`effects.md` (manifiesto cerrado de efectos, S4.3), `facts.md` (hechos operativos firmados, S4.4)
y el manifiesto de corpus de `context/` (S10.1).

**Decisión de formato de archivo (documentada, no es una desviación silenciosa):** la spec es
teórica y no fija una sintaxis de wire concreta (S0: "no tecnologías concretas de
implementación"). Este proyecto usa **YAML delimitado por `---` para los tres archivos**
(`ticket.md`, `effects.md`, `facts.md`), no el estilo markdown con encabezados `##` que aparece
como ejemplo ilustrativo en S4.3 — es más simple de parsear/serializar de forma determinista y
cumple la misma semántica (lista blanca cerrada, claves derivadas por regla fija). Los ejemplos
de abajo son el formato real y vinculante.

## Interface
```ts
export function readTicketFrontmatter(ticketDir: string): TicketFrontmatter;
export function writeTicketFrontmatter(ticketDir: string, frontmatter: TicketFrontmatter, bodyMarkdown: string): void;
export function hashFile(path: string): string;
export function verifyCriticalFilesHash(ticketDir: string, expected: { instructionsSha256: string; effectsSha256: string; factsSha256: string }): boolean;
export function buildCorpusManifest(contextDir: string): CorpusManifestEntry[];
export function verifyCorpusManifest(contextDir: string, manifest: CorpusManifestEntry[]): boolean;
export function readEffectsManifest(ticketDir: string): EffectManifestEntry[];
export function readFacts(ticketDir: string): Record<string, unknown>;
```
Tipos en [`src/types.ts`](../../src/types.ts).

**Mapeo de claves YAML (snake_case) -> TS (camelCase)** para `ticket.md` (ver el fixture completo
en el archivo de tests): `ccdd_provenance.generated_at` -> `ccddProvenance.generatedAt`,
`ccdd_provenance.approved_by` -> `ccddProvenance.approvedBy`, `ticket_id` -> `ticketId`,
`superseded_by` -> `supersededBy`, `trigger.expected_from` -> `trigger.expectedFrom`,
`trigger.correlation_key` -> `trigger.correlationKey`, `attestation.attested_by` ->
`attestation.attestedBy`, `attestation.attested_at` -> `attestation.attestedAt`,
`attestation.valid_until` -> `attestation.validUntil`, `attestation.signature_ref` ->
`attestation.signatureRef`, `projected_state/attempts/as_of` -> `projectedState/Attempts/AsOf`.
Mismo patrón (snake->camel) para `effects.md` (`effect_id`, `idempotency_key`, `max_invocations`,
`escalation.hard_triggers`, `escalation.soft_triggers_enabled`, `response_schema` ->
`responseSchema`) y para el objeto plano de `facts.md` (sin mapeo: las claves de `facts:` quedan
tal cual, son datos de negocio arbitrarios, no campos normativos de TED).

## Invariants
- `writeTicketFrontmatter` seguido de `readTicketFrontmatter` sobre el mismo objeto es la
  identidad (round-trip sin pérdida) para todos los campos de `TicketFrontmatter`.
- `hashFile` calcula SHA-256 sobre los bytes EXACTOS del archivo (sin normalizar newlines).
- `buildCorpusManifest` devuelve las entradas ordenadas por `path` ascendente (determinismo,
  S10.1) y solo considera archivos directos de `contextDir` (no recursivo).
- `verifyCorpusManifest` DEBE devolver `false` si cualquier archivo declarado cambió de hash o
  desapareció; nunca lanza excepción por un archivo faltante.
- `readEffectsManifest`/`readFacts` no validan constraints ni ejecutan nada — solo parsean y
  tipan. La evaluación vive en `src/constraints` (otro contrato).

## Examples
- `hashFile(<archivo con "abc">)` -> `"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"`
- `readTicketFrontmatter(dir).ticketId` -> `"20260719-abc123"` (para el fixture del test)
- `verifyCorpusManifest(contextDir, manifest)` tras modificar un archivo declarado -> `false`
- `readEffectsManifest(dir)` con un efecto `kind: read` sin `response_schema` -> el `responseSchema`
  de esa entrada es `undefined` (obligatorio solo para `kind: read`, y aun así el parser no lo
  exige: la validación de esa obligatoriedad es responsabilidad del lint del contrato de efectos,
  no de este parser)

## Do / Don't
- DO: usar el paquete `yaml` (`parse`/`stringify`) para los tres formatos de archivo.
- DO: mapear explícitamente snake_case <-> camelCase (no asumir que el parser YAML lo hace solo).
- DON'T: no agregar recursividad a `buildCorpusManifest` (solo el nivel directo de `context/`).
- DON'T: no validar ni evaluar constraints en este módulo.

## Tests
Ver `tests/unit/bundle.test.ts` (oráculo congelado, sellado por `tests_sha256`).

## Constraints
- PARAR y reportar si necesitas conectarte a la red.
- PARAR y reportar si el `intent` resulta imposible de cumplir sin violar `touch_only` o `forbids`.
