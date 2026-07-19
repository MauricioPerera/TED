// STUB -- implementado por el dev delegado bajo knowledge/contracts/ted-escalation.md
import type { ConstraintVerdict } from "../types.ts";

export type EscalationTrigger =
  | "constraint-error"
  | "ambiguous-effect"
  | "retry-exhaustion-imminent"
  | "unknown-tool-invoked"
  | "max-invocations-reached"
  | "repeated-deny";

export interface EscalationDecision {
  escalate: boolean;
  trigger?: EscalationTrigger;
}

export type EscalationEvent =
  | { kind: "constraint_verdict"; verdict: ConstraintVerdict }
  | { kind: "unknown_tool" }
  | { kind: "max_invocations_reached" }
  | { kind: "ambiguous_effect"; reconciliationPossible: boolean }
  | { kind: "lease_attempts"; attempts: number; maxAttempts: number };

export function classifyEvent(_event: EscalationEvent): EscalationDecision {
  throw new Error("not implemented");
}

export class DenyTracker {
  recordDeny(_effectId: string): number {
    throw new Error("not implemented");
  }
  recordNonDeny(_effectId: string): void {
    throw new Error("not implemented");
  }
  shouldEscalate(_effectId: string, _threshold: number): boolean {
    throw new Error("not implemented");
  }
}
