// STUB -- implementado por el dev delegado bajo knowledge/contracts/ted-store.md
import type {
  StoreRecord,
  TicketState,
  LedgerEntry,
  FailureCause,
} from "../types.ts";

export class TicketStore {
  constructor(_dbPath: string) {
    throw new Error("not implemented");
  }

  createPending(_ticketId: string, _maxAttempts: number): StoreRecord {
    throw new Error("not implemented");
  }

  getRecord(_ticketId: string): StoreRecord | undefined {
    throw new Error("not implemented");
  }

  acquireLease(
    _ticketId: string,
    _leaseTtlMs: number,
    _now: string,
  ): StoreRecord | null {
    throw new Error("not implemented");
  }

  transition(
    _ticketId: string,
    _fencingToken: number,
    _fromStates: TicketState[],
    _toState: TicketState,
    _failureCause?: FailureCause,
  ): StoreRecord | null {
    throw new Error("not implemented");
  }

  reclaimExpiredLease(_ticketId: string, _now: string): StoreRecord | null {
    throw new Error("not implemented");
  }

  ledgerGet(_ticketId: string, _effectId: string): LedgerEntry | undefined {
    throw new Error("not implemented");
  }

  ledgerMarkAttempted(
    _ticketId: string,
    _effectId: string,
    _fencingToken: number,
    _paramsHash: string,
    _now: string,
  ): LedgerEntry | null {
    throw new Error("not implemented");
  }

  ledgerMarkConfirmed(
    _ticketId: string,
    _effectId: string,
    _resultHash: string,
    _now: string,
  ): LedgerEntry | null {
    throw new Error("not implemented");
  }

  close(): void {
    throw new Error("not implemented");
  }
}
