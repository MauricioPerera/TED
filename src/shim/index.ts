// STUB -- implementado por el dev delegado bajo knowledge/contracts/ted-shim.md
import type { EffectManifestEntry, ConstraintLedgerSnapshot } from "../types.ts";
import type { CompiledConstraint } from "../constraints/index.ts";
import type { TicketStore } from "../store/index.ts";
import type { EscalationTrigger } from "../escalation/index.ts";

export interface ShimDeps {
  store: TicketStore;
  ticketId: string;
  fencingToken: number;
  manifest: EffectManifestEntry[];
  compiledConstraints: Map<string, CompiledConstraint[]>;
  facts: Record<string, unknown>;
  now: string;
  denyThreshold: number;
  execute: (tool: string, params: Record<string, unknown>) => Record<string, unknown>;
}

export type InvokeRejectionReason =
  | "constraint-denied"
  | "stale-lease"
  | "already-confirmed-data-unavailable"
  | "schema-violation";

export type InvokeResult =
  | { outcome: "result"; data: Record<string, unknown> }
  | { outcome: "rejected"; reason: InvokeRejectionReason }
  | { outcome: "escalated"; trigger: EscalationTrigger };

export class EffectsShim {
  constructor(_deps: ShimDeps) {
    throw new Error("not implemented");
  }

  invoke(_effectId: string, _params: Record<string, unknown>): InvokeResult {
    throw new Error("not implemented");
  }
}
