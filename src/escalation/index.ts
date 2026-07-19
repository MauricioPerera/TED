// Implementado bajo knowledge/contracts/ted-escalation.md (disparadores duros de escalada).
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

export function classifyEvent(event: EscalationEvent): EscalationDecision {
  switch (event.kind) {
    case "constraint_verdict":
      if (event.verdict === "error") {
        return { escalate: true, trigger: "constraint-error" };
      }
      return { escalate: false };
    case "unknown_tool":
      return { escalate: true, trigger: "unknown-tool-invoked" };
    case "max_invocations_reached":
      return { escalate: true, trigger: "max-invocations-reached" };
    case "ambiguous_effect":
      if (!event.reconciliationPossible) {
        return { escalate: true, trigger: "ambiguous-effect" };
      }
      return { escalate: false };
    case "lease_attempts":
      if (event.attempts === event.maxAttempts - 1) {
        return { escalate: true, trigger: "retry-exhaustion-imminent" };
      }
      return { escalate: false };
  }
}

export class DenyTracker {
  private counters: Map<string, number> = new Map();

  recordDeny(effectId: string): number {
    const next = (this.counters.get(effectId) ?? 0) + 1;
    this.counters.set(effectId, next);
    return next;
  }

  recordNonDeny(effectId: string): void {
    this.counters.set(effectId, 0);
  }

  shouldEscalate(effectId: string, threshold: number): boolean {
    return (this.counters.get(effectId) ?? 0) >= threshold;
  }
}