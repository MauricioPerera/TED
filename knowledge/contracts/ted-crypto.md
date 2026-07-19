---
type: 'Task Contract'
title: 'Primitivas de firma de TED (transporte, contenido, atestacion)'
description: 'Modulo puro con las tres firmas ortogonales de TED: HMAC de transporte, SHA-256 de contenido, Ed25519 de atestacion.'
tags: ['ted', 'crypto', 'seguridad']
language: typescript

task: ted-crypto
intent: "Implementar las tres primitivas de firma de TED como funciones puras sin estado."
target: src/crypto/index.ts
signature: "export function signAttestation(canonicalPayload: string, privateKeyHex: string): string"
test_command: "node --test tests/unit/crypto.test.ts"
budget:
  max_cyclomatic_complexity: 6
  max_nesting_depth: 3
tests: "tests/unit/crypto.test.ts"
tests_sha256: "3ddb245857c34d48cb75423d999a7401a812c18f5ed644cf473923b0e5473c3a"
touch_only: ['src/crypto/index.ts']
deps_allowed: []
forbids: ['network', 'subprocess', 'llm']
---

# Contract: Primitivas de firma de TED

## Intent
[Ticket-agent-spec.md S5](../../ticket-agent-spec.md#5-firmas) define tres firmas ortogonales con
vidas y roles distintos. Este modulo las implementa como funciones puras: sin estado, sin I/O,
sin acceso a reloj de sistema (el `now` siempre es un parametro explicito — ver
[S12.4](../../ticket-agent-spec.md#124-el-reloj-como-dato), que aplica el mismo principio a
constraints y se adopta aca por consistencia).

## Interface
```ts
export function signTransport(payload: string, secretHex: string, timestamp: string): string;
export function verifyTransport(payload: string, secretHex: string, timestamp: string, signatureHex: string, now: string, toleranceMs: number): boolean;
export function sha256Hex(content: string): string;
export function generateAttestationKeyPair(): { publicKeyHex: string; privateKeyHex: string };
export function signAttestation(canonicalPayload: string, privateKeyHex: string): string;
export function verifyAttestation(canonicalPayload: string, signatureHex: string, publicKeyHex: string): boolean;
```

- `signTransport`/`verifyTransport`: HMAC-SHA256 sobre `` `${timestamp}.${payload}` ``, clave en hex.
  `verifyTransport` DEBE rechazar si `now` esta fuera de `[timestamp, timestamp + toleranceMs]`
  (ventana de tolerancia anti-replay, S5 punto 1). `now >= timestamp` siempre en este modulo (no se
  valida clock skew negativo: es responsabilidad del caller).
- `sha256Hex`: SHA-256 hex del contenido EXACTO recibido (sin normalizar newlines — eso es decision
  del caller, no de esta primitiva).
- `generateAttestationKeyPair`/`signAttestation`/`verifyAttestation`: Ed25519 via `node:crypto`
  (`generateKeyPairSync('ed25519')`, `sign(null, ...)`, `verify(null, ...)`). Claves exportadas en
  hex (DER: `spki` para la publica, `pkcs8` para la privada). El payload a firmar es un string ya
  canonicalizado por el caller (este modulo no serializa objetos).

## Invariants
- Ninguna funcion lee `Date.now()` ni el reloj del sistema: todo tiempo es un parametro.
- `verifyTransport`/`verifyAttestation` nunca lanzan excepcion ante input invalido: devuelven `false`.
- Dos llamadas a `generateAttestationKeyPair()` nunca devuelven el mismo par de claves.

## Examples
- `sha256Hex("")` -> `"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"`
- `verifyTransport(p, secret, ts, signTransport(p, secret, ts), ts, 60000)` -> `true`
- `verifyTransport(p, secret, ts, sig, now_fuera_de_ventana, 60000)` -> `false`
- `verifyAttestation(payload, signAttestation(payload, priv), pub)` -> `true`; con `payload` alterado -> `false`

## Do / Don't
- DO: usar `node:crypto` (`createHmac`, `createHash`, `generateKeyPairSync`, `sign`, `verify`) — sin
  dependencias externas.
- DO: exportar claves Ed25519 en DER (`spki`/`pkcs8`) codificado hex, no PEM.
- DON'T: no leer el reloj del sistema en ninguna funcion.
- DON'T: no lanzar excepciones desde las funciones `verify*` — devolver `false`.

## Tests
Ver `tests/unit/crypto.test.ts` (oraculo congelado, sellado por `tests_sha256`).

## Constraints
- PARAR y reportar si necesitas conectarte a la red.
- PARAR y reportar si el `intent` resulta imposible de cumplir sin violar `touch_only` o `forbids`.
