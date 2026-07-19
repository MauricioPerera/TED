---
type: 'Task Contract'
title: 'Cadena de verificacion de atestacion + CRL'
description: 'Firma de atestacion, hash de contenido, consulta al CRL y frescura, en el orden exacto del paso 3 de pending->leased.'
tags: ['ted', 'attestation', 'crl', 'seguridad']
language: typescript

task: ted-attestation
intent: "Implementar la cadena de verificacion de atestacion (firma, hashes, CRL, vigencia) de TED."
target: src/attestation/index.ts
signature: "export function verifyAttestationSignature(payload: AttestationPayload, signatureHex: string, publicKeyHex: string): boolean"
target_line: 22
test_command: "node --test tests/unit/attestation.test.ts"
budget:
  max_cyclomatic_complexity: 8
  max_nesting_depth: 3
tests: "tests/unit/attestation.test.ts"
tests_sha256: "d6f3c0f372ef95a013e06672aafec90372fab903de0b6478b181b2d518ae33c5"
touch_only: ['src/attestation/index.ts']
deps_allowed: []
forbids: ['network', 'subprocess', 'llm']
---

# Contract: Cadena de verificación de atestación + CRL

## Intent
Implementa el paso 3 de `pending -> leased`
([S6.3](../../ticket-agent-spec.md#63-transiciones)): "hash de contenido contra la atestación,
consulta al CRL, verificación de vigencia y frescura", en ese orden exacto, más la firma de
atestación misma ([S5](../../ticket-agent-spec.md#5-firmas) punto 3) y el hash del manifiesto de
corpus ([S10.1](../../ticket-agent-spec.md#101-capa-1-cerrar-y-firmar-el-corpus)). Este módulo NO
hace la firma de transporte (paso 1, ya cubierto por `src/crypto`) ni el CAS del store (paso 2,
`src/store`) — solo el paso 3, que es puramente criptografía + comparación, sin I/O de disco (el
caller ya trae los hashes actuales calculados, p.ej. vía `src/bundle`).

## Interface
```ts
export interface RevocationEntry { ticketId: string; revokedAt: string; signatureHex: string }
export type VerificationOutcome =
  | { verdict: "proceed" }
  | { verdict: "integrity-violated" }
  | { verdict: "revoked" }
  | { verdict: "expired" };

export function hashCorpusManifest(manifest: CorpusManifestEntry[]): string;
export function canonicalizeAttestationPayload(payload: AttestationPayload): string;
export function verifyAttestationSignature(payload: AttestationPayload, signatureHex: string, publicKeyHex: string): boolean;
export function isRevoked(ticketId: string, crl: RevocationEntry[], creatorPublicKeyHex: string): boolean;
export function isExpired(payload: AttestationPayload, now: string): boolean;
export function verifyPendingToLeased(params: {
  attestation: AttestationPayload;
  attestationSignatureHex: string;
  creatorPublicKeyHex: string;
  actualInstructionsSha256: string;
  actualEffectsSha256: string;
  actualFactsSha256: string;
  actualCorpusManifest: CorpusManifestEntry[];
  crl: RevocationEntry[];
  now: string;
}): VerificationOutcome;
```
Tipos `AttestationPayload`, `CorpusManifestEntry` en [`src/types.ts`](../../src/types.ts). Usa
`sha256Hex`, `signAttestation`/`verifyAttestation` de `../../src/crypto/index.ts` (ya
implementado y verificado en el contrato [`ted-crypto`](ted-crypto.md) — importalo, no
reimplementes crypto acá).

## Invariants
- `canonicalizeAttestationPayload` es determinista: mismo `payload` -> mismo string, SIEMPRE
  (incluye `hashCorpusManifest(payload.corpusManifest)` como uno de los componentes de la tupla
  firmada, junto a `ticketId`, `instructionsSha256`, `effectsSha256`, `factsSha256`, `attestedAt`,
  `validUntil` — S5 punto 3: "firmar todos los hashes juntos impide el ataque de mezcla").
- `verifyPendingToLeased` evalúa EN ESTE ORDEN y corta en el primer fallo (short-circuit):
  1. firma de atestación válida (si no -> `integrity-violated`)
  2. los 3 hashes de contenido actuales coinciden con los de la atestación, Y el hash del
     manifiesto de corpus actual coincide con el firmado (si no -> `integrity-violated`)
  3. el ticket no está en el CRL con una revocación firmada válida (si está -> `revoked`)
  4. `now` no superó `validUntil` (si lo superó -> `expired`)
  Si las cuatro pasan -> `proceed`. Cuando revocación Y expiración son ambas ciertas, el resultado
  es `revoked` (el CRL se consulta antes que la vigencia).
- `isExpired`: `now === validUntil` NO cuenta como expirado (estrictamente posterior).
- Ningún método lee el reloj del sistema: `now` siempre es el parámetro.
- La firma de revocación en `isRevoked` se verifica sobre el string
  `` `${ticketId}:${revokedAt}:revoked` `` con la misma clave pública del creador (Ed25519).

## Examples
- Atestación válida, hashes coinciden, CRL vacío, `now` dentro de ventana -> `{ verdict: "proceed" }`
- Firma de atestación inválida -> `{ verdict: "integrity-violated" }` (sin mirar nada más)
- Firma válida pero `actualInstructionsSha256` no coincide con la atestación -> `{ verdict: "integrity-violated" }`
- Ticket revocado Y expirado a la vez -> `{ verdict: "revoked" }` (CRL antes que vigencia)

## Do / Don't
- DO: importar `sha256Hex`/`signAttestation`/`verifyAttestation` desde `../crypto/index.ts`.
- DO: construir `hashCorpusManifest` como el SHA-256 de la lista ordenada `path:sha256` unida por
  `\n` (el caller ya entrega el manifiesto ordenado, p.ej. desde `src/bundle`).
- DON'T: no leas archivos del disco en este módulo (los hashes "actuales" llegan como parámetros).
- DON'T: no reimplementes HMAC/Ed25519/SHA-256 acá — reusá `src/crypto`.

## Tests
Ver `tests/unit/attestation.test.ts` (oráculo congelado, sellado por `tests_sha256`).

## Constraints
- PARAR y reportar si necesitas conectarte a la red.
- PARAR y reportar si el `intent` resulta imposible de cumplir sin violar `touch_only` o `forbids`.
