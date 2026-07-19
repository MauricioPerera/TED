// Implementacion de TicketStore bajo knowledge/contracts/ted-store.md.
// Store transaccional de TED: CAS con fencing token, lease con TTL,
// terminales irreversibles y ledger declared/attempted/confirmed.
//
// Sin reloj del sistema: toda marca temporal llega como parametro `now`
// (ISO 8601). Sin dependencias npm: solo node:sqlite (DatabaseSync).
import { DatabaseSync } from "node:sqlite";
import type {
  StoreRecord,
  TicketState,
  LedgerEntry,
  LedgerEffectState,
  FailureCause,
} from "../types.ts";

type TicketRow = Record<string, unknown> | undefined;
type LedgerRow = Record<string, unknown> | undefined;

// Estados terminales (S6.4 invariante 1): una vez aca, transition es no-op.
const TERMINAL: readonly TicketState[] = [
  "fulfilled",
  "failed",
  "expired",
  "cancelled",
];

function isTerminal(state: TicketState): boolean {
  return TERMINAL.includes(state);
}

function rowToRecord(row: TicketRow): StoreRecord | undefined {
  if (!row) return undefined;
  return {
    ticketId: row.ticketId as string,
    state: row.state as TicketState,
    fencingToken: row.fencingToken as number,
    leaseExpiresAt: (row.leaseExpiresAt ?? null) as string | null,
    attempts: row.attempts as number,
    maxAttempts: row.maxAttempts as number,
    failureCause: (row.failureCause ?? null) as FailureCause | null,
    version: row.version as number,
  };
}

function rowToLedger(row: LedgerRow): LedgerEntry | undefined {
  if (!row) return undefined;
  const entry: LedgerEntry = {
    ticketId: row.ticketId as string,
    effectId: row.effectId as string,
    state: row.state as LedgerEffectState,
    fencingToken: row.fencingToken as number,
    invocationCount: row.invocationCount as number,
    updatedAt: row.updatedAt as string,
  };
  // paramsHash / resultHash son opcionales; solo se exponen si existen
  // (exactOptionalPropertyTypes: nunca se asigna undefined explicitamente).
  if (typeof row.paramsHash === "string") entry.paramsHash = row.paramsHash;
  if (typeof row.resultHash === "string") entry.resultHash = row.resultHash;
  return entry;
}

// Suma `ttlMs` milisegundos a una marca ISO 8601 y devuelve ISO 8601.
// Usa solo el parametro `now` (parseado), nunca el reloj del sistema.
function shiftIso(iso: string, ttlMs: number): string {
  return new Date(Date.parse(iso) + ttlMs).toISOString();
}

export class TicketStore {
  private readonly db: DatabaseSync;
  private readonly getTicket: ReturnType<DatabaseSync["prepare"]>;
  private readonly upsertTicket: ReturnType<DatabaseSync["prepare"]>;
  private readonly getLedger: ReturnType<DatabaseSync["prepare"]>;
  private readonly insertLedger: ReturnType<DatabaseSync["prepare"]>;
  private readonly updateLedger: ReturnType<DatabaseSync["prepare"]>;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        ticketId        TEXT PRIMARY KEY,
        state           TEXT NOT NULL,
        fencingToken    INTEGER NOT NULL,
        leaseExpiresAt  TEXT,
        attempts        INTEGER NOT NULL,
        maxAttempts     INTEGER NOT NULL,
        failureCause    TEXT,
        version         INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger (
        ticketId        TEXT NOT NULL,
        effectId        TEXT NOT NULL,
        state           TEXT NOT NULL,
        fencingToken    INTEGER NOT NULL,
        invocationCount INTEGER NOT NULL,
        paramsHash      TEXT,
        resultHash      TEXT,
        updatedAt       TEXT NOT NULL,
        PRIMARY KEY (ticketId, effectId)
      );
    `);

    this.getTicket = this.db.prepare(
      "SELECT ticketId, state, fencingToken, leaseExpiresAt, attempts, " +
        "maxAttempts, failureCause, version FROM tickets WHERE ticketId = ?",
    );
    this.upsertTicket = this.db.prepare(
      "UPDATE tickets SET state = ?, fencingToken = ?, leaseExpiresAt = ?, " +
        "attempts = ?, failureCause = ?, version = ? WHERE ticketId = ?",
    );
    this.getLedger = this.db.prepare(
      "SELECT ticketId, effectId, state, fencingToken, invocationCount, " +
        "paramsHash, resultHash, updatedAt FROM ledger " +
        "WHERE ticketId = ? AND effectId = ?",
    );
    this.insertLedger = this.db.prepare(
      "INSERT INTO ledger (ticketId, effectId, state, fencingToken, " +
        "invocationCount, paramsHash, resultHash, updatedAt) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.updateLedger = this.db.prepare(
      "UPDATE ledger SET state = ?, fencingToken = ?, invocationCount = ?, " +
        "paramsHash = ?, resultHash = ?, updatedAt = ? " +
        "WHERE ticketId = ? AND effectId = ?",
    );
  }

  // -- Tickets -------------------------------------------------------------

  createPending(ticketId: string, maxAttempts: number): StoreRecord {
    // INSERT con PRIMARY KEY: duplicar ticketId hace que SQLite lance
    // (UNIQUE constraint), que es lo que espera el oraculo.
    this.db
      .prepare(
        "INSERT INTO tickets (ticketId, state, fencingToken, leaseExpiresAt, " +
          "attempts, maxAttempts, failureCause, version) " +
          "VALUES (?, 'pending', 0, NULL, 0, ?, NULL, 1)",
      )
      .run(ticketId, maxAttempts);
    const rec = rowToRecord(this.getTicket.get(ticketId) as TicketRow);
    // createPending siempre acaba de insertar, asi que rec esta definido.
    return rec as StoreRecord;
  }

  getRecord(ticketId: string): StoreRecord | undefined {
    return rowToRecord(this.getTicket.get(ticketId) as TicketRow);
  }

  acquireLease(
    ticketId: string,
    leaseTtlMs: number,
    now: string,
  ): StoreRecord | null {
    const rec = rowToRecord(this.getTicket.get(ticketId) as TicketRow);
    if (!rec) return null;
    // CAS puro: solo transiciona desde "pending" (S6.3 absorbe duplicados).
    if (rec.state !== "pending") return null;
    const next: StoreRecord = {
      ...rec,
      state: "leased",
      fencingToken: rec.fencingToken + 1,
      leaseExpiresAt: shiftIso(now, leaseTtlMs),
      version: rec.version + 1,
    };
    this.writeTicket(next);
    return next;
  }

  transition(
    ticketId: string,
    fencingToken: number,
    fromStates: TicketState[],
    toState: TicketState,
    failureCause?: FailureCause,
  ): StoreRecord | null {
    const rec = rowToRecord(this.getTicket.get(ticketId) as TicketRow);
    if (!rec) return null;
    // Terminales irreversibles: pisan cualquier fromStates (S6.4 inv. 1).
    if (isTerminal(rec.state)) return null;
    // Fencing token verificado (S6.4 inv. 4): token desactualizado -> null.
    if (rec.fencingToken !== fencingToken) return null;
    // Solo transiciona desde un estado autorizado por el caller.
    if (!fromStates.includes(rec.state)) return null;
    const next: StoreRecord = {
      ...rec,
      state: toState,
      failureCause: failureCause ?? null,
      version: rec.version + 1,
    };
    this.writeTicket(next);
    return next;
  }

  reclaimExpiredLease(ticketId: string, now: string): StoreRecord | null {
    const rec = rowToRecord(this.getTicket.get(ticketId) as TicketRow);
    if (!rec) return null;
    // Solo actua si el lease genuinamente vencio y sigue "leased".
    if (rec.state !== "leased") return null;
    if (rec.leaseExpiresAt === null || rec.leaseExpiresAt > now) return null;
    const attempts = rec.attempts + 1;
    // El fencing token NO crece aqui (solo en acquireLease).
    let next: StoreRecord;
    if (attempts >= rec.maxAttempts) {
      // Agotados los reintentos -> terminal fallido (S6.4 inv. 2).
      next = {
        ...rec,
        attempts,
        state: "failed",
        failureCause: "retry-exhausted",
        leaseExpiresAt: null,
        version: rec.version + 1,
      };
    } else {
      next = {
        ...rec,
        attempts,
        state: "pending",
        failureCause: null,
        leaseExpiresAt: null,
        version: rec.version + 1,
      };
    }
    this.writeTicket(next);
    return next;
  }

  // Persiste un StoreRecord completo (todas las columnas mutables).
  private writeTicket(rec: StoreRecord): void {
    this.upsertTicket.run(
      rec.state,
      rec.fencingToken,
      rec.leaseExpiresAt,
      rec.attempts,
      rec.failureCause,
      rec.version,
      rec.ticketId,
    );
  }

  // -- Ledger de efectos ---------------------------------------------------

  ledgerGet(ticketId: string, effectId: string): LedgerEntry | undefined {
    return rowToLedger(this.getLedger.get(ticketId, effectId) as LedgerRow);
  }

  ledgerMarkAttempted(
    ticketId: string,
    effectId: string,
    fencingToken: number,
    paramsHash: string,
    now: string,
  ): LedgerEntry | null {
    const ticket = rowToRecord(this.getTicket.get(ticketId) as TicketRow);
    if (!ticket) return null;
    const existing = rowToLedger(
      this.getLedger.get(ticketId, effectId) as LedgerRow,
    );
    // Idempotente sobre una entrada ya "confirmed": replay transparente para
    // el sucesor (S11.2 paso 2). No retrocede estado ni resultHash, y se
    // aplica antes que la verificacion de fencing (el sucesor trae otro token).
    if (existing && existing.state === "confirmed") return existing;
    // Fencing verificado contra el ticket (S11.2 paso 4 / S6.4 inv. 4).
    if (ticket.fencingToken !== fencingToken) return null;
    if (existing) {
      const updated: LedgerEntry = {
        ticketId,
        effectId,
        state: "attempted",
        fencingToken,
        invocationCount: existing.invocationCount + 1,
        paramsHash,
        updatedAt: now,
      };
      this.updateLedger.run(
        updated.state,
        updated.fencingToken,
        updated.invocationCount,
        paramsHash,
        null,
        updated.updatedAt,
        ticketId,
        effectId,
      );
      return updated;
    }
    const entry: LedgerEntry = {
      ticketId,
      effectId,
      state: "attempted",
      fencingToken,
      invocationCount: 1,
      paramsHash,
      updatedAt: now,
    };
    this.insertLedger.run(
      ticketId,
      effectId,
      entry.state,
      entry.fencingToken,
      entry.invocationCount,
      paramsHash,
      null,
      entry.updatedAt,
    );
    return entry;
  }

  ledgerMarkConfirmed(
    ticketId: string,
    effectId: string,
    resultHash: string,
    now: string,
  ): LedgerEntry | null {
    const existing = rowToLedger(
      this.getLedger.get(ticketId, effectId) as LedgerRow,
    );
    // Solo se confirma lo que fue "attempted". Sin entry o en otro estado
    // -> null (no se inventa confirmacion). Idempotente si ya confirmado.
    if (!existing) return null;
    if (existing.state === "confirmed") return existing;
    if (existing.state !== "attempted") return null;
    const confirmed: LedgerEntry = {
      ticketId,
      effectId,
      state: "confirmed",
      fencingToken: existing.fencingToken,
      invocationCount: existing.invocationCount,
      resultHash,
      updatedAt: now,
    };
    if (existing.paramsHash !== undefined) confirmed.paramsHash = existing.paramsHash;
    this.updateLedger.run(
      confirmed.state,
      confirmed.fencingToken,
      confirmed.invocationCount,
      confirmed.paramsHash ?? null,
      confirmed.resultHash ?? null,
      confirmed.updatedAt,
      ticketId,
      effectId,
    );
    return confirmed;
  }

  close(): void {
    this.db.close();
  }
}