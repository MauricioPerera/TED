// Tipos compartidos entre modulos. Solo declaraciones (sin logica) -- ver
// DEFINITION.md y ticket-agent-spec.md para el significado normativo de cada
// campo. No agregar enums con valor ni namespaces (erasableSyntaxOnly).

export type TicketState =
  | "pending"
  | "leased"
  | "escalated"
  | "fulfilled"
  | "failed"
  | "expired"
  | "cancelled";

export const TERMINAL_STATES: readonly TicketState[] = [
  "fulfilled",
  "failed",
  "expired",
  "cancelled",
];

export type Actor = "creator" | "fulfillment_system" | "orchestrator" | "clock";

export type FailureCause =
  | "integrity-violated"
  | "retry-exhausted"
  | "guardrail-triggered"
  | "budget-exhausted"
  | "agent-aborted";

export type TriggerKind = "external_callback" | "timer" | "condition";

export interface Trigger {
  kind: TriggerKind;
  expectedFrom: string;
  correlationKey: string;
}

export interface CcddProvenance {
  author: string;
  generatedAt: string;
  approvedBy: string;
}

export interface AttestationRef {
  attestedBy: string;
  attestedAt: string;
  validUntil: string;
  signatureRef: string;
}

// Frontmatter minimo de ticket.md (spec S4.2). Los consumidores pueden
// extenderlo (OKF tolera claves adicionales) pero estas son las normativas.
export interface TicketFrontmatter {
  type: "Ticket";
  title: string;
  description: string;
  timestamp: string;
  ccddProvenance: CcddProvenance;
  ticketId: string;
  supersedes: string | null;
  supersededBy: string | null;
  trigger: Trigger;
  attestation: AttestationRef;
  projectedState: TicketState;
  projectedAttempts: number;
  projectedAsOf: string;
}

export type EffectKind = "read" | "write";

// Politica de escalada por efecto (S13.2): que disparadores duros aplican y
// con que sensibilidad. El detalle de cada disparador vive en src/escalation.
export interface EscalationPolicy {
  hardTriggers: string[];
  softTriggersEnabled: boolean;
}

export interface EffectManifestEntry {
  effectId: string;
  tool: string;
  constraints: string[];
  idempotencyKey: string; // derivado por regla fija: `${ticketId}:${effectId}`
  maxInvocations: number;
  escalation: EscalationPolicy;
  kind: EffectKind;
  // Obligatorio si kind === "read" (S4.3, S11.4). Esquema minimo: nombres de
  // campo -> tipo primitivo esperado; el shim descarta lo no declarado.
  responseSchema?: Record<string, "string" | "number" | "boolean">;
}

export interface CorpusManifestEntry {
  path: string;
  sha256: string;
}

// Atestacion completa (S5, S10.1): la firma cubre esta tupla completa.
export interface AttestationPayload {
  ticketId: string;
  instructionsSha256: string;
  effectsSha256: string;
  factsSha256: string;
  corpusManifest: CorpusManifestEntry[];
  attestedAt: string;
  validUntil: string;
}

export type LedgerEffectState = "declared" | "attempted" | "confirmed";

export interface LedgerEntry {
  ticketId: string;
  effectId: string;
  state: LedgerEffectState;
  fencingToken: number;
  invocationCount: number;
  paramsHash?: string;
  resultHash?: string;
  updatedAt: string;
}

// Registro disputado del store (S3, S7.2). El fencing token crece
// monotonicamente en cada adquisicion de lease.
export interface StoreRecord {
  ticketId: string;
  state: TicketState;
  fencingToken: number;
  leaseExpiresAt: string | null;
  attempts: number;
  maxAttempts: number;
  failureCause: FailureCause | null;
  version: number; // usado por el CAS (compare-and-swap)
}

export type ConstraintVerdict = "permit" | "deny" | "error";

export interface ConstraintEvalResult {
  verdict: ConstraintVerdict;
  reason?: string;
  // Tupla completa de inputs para auditoria por reproduccion (S12.7).
  auditTrail: {
    factsSha256: string;
    paramsHash: string;
    now: string;
    ledgerSha256: string;
  };
}
