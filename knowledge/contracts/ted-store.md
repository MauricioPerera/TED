---
type: 'Task Contract'
title: 'Store transaccional (CAS + TTL + ledger de efectos)'
description: 'SQLite embebido (node:sqlite) para el estado disputado del ticket: lease, fencing token, ledger declared/attempted/confirmed.'
tags: ['ted', 'store', 'concurrencia']
language: typescript

task: ted-store
intent: "Implementar el store transaccional de TED."
target: src/store/index.ts
signature: "acquireLease(ticketId: string, leaseTtlMs: number, now: string): StoreRecord | null"
target_line: 15
test_command: "node --test tests/unit/store.test.ts"
budget:
  max_cyclomatic_complexity: 10
  max_nesting_depth: 4
tests: "tests/unit/store.test.ts"
tests_sha256: "265e8fee5d5e0ad3607a4da1f2965a1f7c16e285ca0993a21be4b9925683bb84"
touch_only: ['src/store/index.ts']
deps_allowed: ['node:sqlite']
forbids: ['network', 'subprocess', 'llm']
---

# Contract: Store transaccional de TED

## Intent
Implementa la clase `TicketStore` que gobierna [S3](../../ticket-agent-spec.md#3-particion-de-estado)
(partición de estado disputado), [S7.2](../../ticket-agent-spec.md#72-lease-con-fencing-token)
(lease con fencing token) y [S7.3](../../ticket-agent-spec.md#73-idempotencia-en-dos-fronteras)
(ledger de efectos). Usa `node:sqlite` (`DatabaseSync`, built-in de Node >= 22.5, sin dependencia
npm) — ver [`.agents/AGENTS.md`](../../.agents/AGENTS.md) regla 7 sobre el stack del proyecto.

## Interface
```ts
class TicketStore {
  constructor(dbPath: string); // ":memory:" en tests
  createPending(ticketId: string, maxAttempts: number): StoreRecord;
  getRecord(ticketId: string): StoreRecord | undefined;
  acquireLease(ticketId: string, leaseTtlMs: number, now: string): StoreRecord | null;
  transition(ticketId: string, fencingToken: number, fromStates: TicketState[], toState: TicketState, failureCause?: FailureCause): StoreRecord | null;
  reclaimExpiredLease(ticketId: string, now: string): StoreRecord | null;
  ledgerGet(ticketId: string, effectId: string): LedgerEntry | undefined;
  ledgerMarkAttempted(ticketId: string, effectId: string, fencingToken: number, paramsHash: string, now: string): LedgerEntry | null;
  ledgerMarkConfirmed(ticketId: string, effectId: string, resultHash: string, now: string): LedgerEntry | null;
  close(): void;
}
```
Tipos en [`src/types.ts`](../../src/types.ts) (`StoreRecord`, `TicketState`, `LedgerEntry`,
`FailureCause`).

## Invariants
- **Ningún método lee el reloj del sistema.** `now` siempre es un parámetro string ISO 8601;
  todas las comparaciones temporales usan ese valor, nunca `Date.now()` ni `new Date()` sin
  argumento (mismo principio que S12.4, aplicado a todo el store).
- **Terminales irreversibles**: si el estado actual de un ticket está en
  `["fulfilled","failed","expired","cancelled"]`, `transition(...)` DEBE devolver `null` sin
  importar los `fromStates` que pida el caller (S6.4 invariante 1).
- **Fencing token monótono y verificado**: `transition` y ambos `ledgerMark*` DEBEN devolver `null`
  si el `fencingToken` recibido no coincide exactamente con el `fencingToken` actual del registro
  del ticket (S6.4 invariante 4, S11.2 pasos 4/6). El token solo se incrementa en `acquireLease`,
  nunca en `reclaimExpiredLease`.
- **`acquireLease` es CAS puro**: solo transiciona si el estado actual es exactamente `"pending"`.
  Cualquier otro estado -> devuelve `null` (absorbe duplicados de callback, S6.3).
- **`reclaimExpiredLease` solo actúa si el lease genuinamente venció** (`leaseExpiresAt <= now` Y
  estado actual `"leased"`); si no, devuelve `null`. Al reclamar: `attempts += 1`; si
  `attempts > maxAttempts` -> `state: "failed"`, `failureCause: "retry-exhausted"` (S6.4
  invariante 2); si no -> `state: "pending"`, `leaseExpiresAt: null`.
- **`ledgerMarkAttempted` sobre una entrada ya `"confirmed"` es idempotente**: devuelve la entrada
  existente sin modificarla (ni el `resultHash` ni el estado retroceden) — replay transparente
  para el sucesor (S11.2 paso 2).

## Examples
- `createPending("t1", 3)` -> `{ ticketId:"t1", state:"pending", fencingToken:0, leaseExpiresAt:null, attempts:0, maxAttempts:3, failureCause:null, version:1 }`
- `acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z")` -> `{ ..., state:"leased", fencingToken:1, leaseExpiresAt:"2026-07-19T00:01:00.000Z" }`
- Segundo `acquireLease` mientras sigue `"leased"` -> `null`
- `transition(ticketId, tokenViejo, ["leased"], "fulfilled")` con token desactualizado -> `null`

## Do / Don't
- DO: usar `import { DatabaseSync } from "node:sqlite"`.
- DO: usar sentencias preparadas parametrizadas (nunca interpolar strings en SQL).
- DON'T: no agregar dependencias npm (better-sqlite3, knex, etc.) — `node:sqlite` alcanza.
- DON'T: no dejar que `reclaimExpiredLease` incremente el fencing token.

## Tests
Ver `tests/unit/store.test.ts` (oráculo congelado, sellado por `tests_sha256`).

## Constraints
- PARAR y reportar si necesitas conectarte a la red.
- PARAR y reportar si el `intent` resulta imposible de cumplir sin violar `touch_only` o `forbids`.
