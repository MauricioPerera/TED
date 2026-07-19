// Implementacion del pipeline de mediacion de EffectsShim bajo
// knowledge/contracts/ted-shim.md. Orquesta store + constraints + escalation;
// NO reimplementa ninguno de los tres. invoke() es un dispatcher fino que
// delega cada paso del pipeline a un metodo privado de una sola responsabilidad.
import { sha256Hex } from "../crypto/index.ts";
import { evaluateAll } from "../constraints/index.ts";
import { classifyEvent, DenyTracker } from "../escalation/index.ts";
import type { EffectManifestEntry, ConstraintLedgerSnapshot } from "../types.ts";
import type { CompiledConstraint } from "../constraints/index.ts";
import type { TicketStore } from "../store/index.ts";
import type { EscalationTrigger } from "../escalation/index.ts";

export interface ShimDeps {
  store: TicketStore;
  ticketId: string;
  fencingToken: number;
  manifest: EffectManifestEntry[];
  compiledConstraints: Map<string, CompiledConstraint[]>; // effectId -> constraints ya compiladas
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
  private readonly store: TicketStore;
  private readonly ticketId: string;
  private readonly fencingToken: number;
  private readonly manifest: Map<string, EffectManifestEntry>;
  private readonly compiledConstraints: Map<string, CompiledConstraint[]>;
  private readonly facts: Record<string, unknown>;
  private readonly now: string;
  private readonly denyThreshold: number;
  private readonly execute: (
    tool: string,
    params: Record<string, unknown>,
  ) => Record<string, unknown>;
  // Caché local (vida = esta instancia): ledger de negocio para agregaciones
  // de constraints (S12.6) + replay idempotente del resultado filtrado (S11.2).
  private readonly denyTracker = new DenyTracker();
  private readonly ledger: ConstraintLedgerSnapshot = {};
  private readonly resultCache = new Map<string, Record<string, unknown>>();

  constructor(deps: ShimDeps) {
    this.store = deps.store;
    this.ticketId = deps.ticketId;
    this.fencingToken = deps.fencingToken;
    this.manifest = new Map(deps.manifest.map((e) => [e.effectId, e]));
    this.compiledConstraints = deps.compiledConstraints;
    this.facts = deps.facts;
    this.now = deps.now;
    this.denyThreshold = deps.denyThreshold;
    this.execute = deps.execute;
  }

  // Dispatcher fino: cada paso devuelve InvokeResult (terminal) o undefined
  // (continuar al siguiente). El orden es vinculante (contrato, pasos 1-11).
  invoke(effectId: string, params: Record<string, unknown>): InvokeResult {
    return (
      this.resolveEffect(effectId) ??
      this.checkLocalCache(effectId) ??
      this.checkStoreConfirmed(effectId) ??
      this.checkMaxInvocations(effectId) ??
      this.checkConstraints(effectId, params) ??
      this.executeEffect(effectId, params)
    );
  }

  // Paso 1: resolucion. effectId ausente del manifest -> escalada, sin execute.
  private resolveEffect(effectId: string): InvokeResult | undefined {
    if (this.manifest.has(effectId)) return undefined;
    const decision = classifyEvent({ kind: "unknown_tool" });
    return { outcome: "escalated", trigger: decision.trigger as EscalationTrigger };
  }

  // Paso 2: caché local confirmada -> replay idempotente sin re-ejecutar.
  private checkLocalCache(effectId: string): InvokeResult | undefined {
    const cached = this.resultCache.get(effectId);
    if (!cached) return undefined;
    return { outcome: "result", data: cached };
  }

  // Paso 3: store dice confirmed pero no hay caché local (sucesor sin cache)
  // -> rechazo; nunca re-ejecutar un efecto ya confirmado.
  private checkStoreConfirmed(effectId: string): InvokeResult | undefined {
    const entry = this.store.ledgerGet(this.ticketId, effectId);
    if (entry?.state === "confirmed") {
      return { outcome: "rejected", reason: "already-confirmed-data-unavailable" };
    }
    return undefined;
  }

  // Paso 4: max_invocations agotado (sin confirmar) -> escalada, sin execute.
  private checkMaxInvocations(effectId: string): InvokeResult | undefined {
    const entry = this.store.ledgerGet(this.ticketId, effectId);
    if (!entry || entry.state === "confirmed") return undefined;
    const max = this.manifest.get(effectId)?.maxInvocations ?? 0;
    if (entry.invocationCount >= max) {
      const decision = classifyEvent({ kind: "max_invocations_reached" });
      return { outcome: "escalated", trigger: decision.trigger as EscalationTrigger };
    }
    return undefined;
  }

  // Paso 5: constraints. error -> escalada; deny -> tracker (escalada al
  // umbral o rechazo); permit -> higiene (recordNonDeny) y continuar.
  private checkConstraints(
    effectId: string,
    params: Record<string, unknown>,
  ): InvokeResult | undefined {
    const compiled = this.compiledConstraints.get(effectId) ?? [];
    const result = evaluateAll(compiled, params, this.facts, this.ledger, this.now);
    if (result.verdict === "error") {
      const decision = classifyEvent({ kind: "constraint_verdict", verdict: "error" });
      return { outcome: "escalated", trigger: decision.trigger as EscalationTrigger };
    }
    if (result.verdict === "deny") {
      this.denyTracker.recordDeny(effectId);
      if (this.denyTracker.shouldEscalate(effectId, this.denyThreshold)) {
        return { outcome: "escalated", trigger: "repeated-deny" };
      }
      return { outcome: "rejected", reason: "constraint-denied" };
    }
    this.denyTracker.recordNonDeny(effectId);
    return undefined;
  }

  // Pasos 6-11: asiento attempted (con fencing), ejecucion, validacion de
  // lecturas tipadas, asiento confirmed, actualizacion de caché local, return.
  private executeEffect(
    effectId: string,
    params: Record<string, unknown>,
  ): InvokeResult {
    const attempted = this.store.ledgerMarkAttempted(
      this.ticketId,
      effectId,
      this.fencingToken,
      sha256Hex(JSON.stringify(params)),
      this.now,
    );
    if (!attempted) {
      return { outcome: "rejected", reason: "stale-lease" };
    }
    const entry = this.manifest.get(effectId) as EffectManifestEntry;
    const raw = this.execute(entry.tool, params);
    const filtered =
      entry.kind === "read" ? this.validateReadSchema(entry, raw) : raw;
    if (filtered === null) {
      return { outcome: "rejected", reason: "schema-violation" };
    }
    this.store.ledgerMarkConfirmed(
      this.ticketId,
      effectId,
      sha256Hex(JSON.stringify(filtered)),
      this.now,
    );
    this.ledger[effectId] = { state: "confirmed", ...params, ...filtered };
    this.resultCache.set(effectId, filtered);
    return { outcome: "result", data: filtered };
  }

  // Paso 8 (S11.4): filtra a EXACTAMENTE las claves declaradas en
  // responseSchema; clave faltante o tipo (typeof) incompatible -> null
  // (schema-violation). Las claves no declaradas se descartan.
  private validateReadSchema(
    entry: EffectManifestEntry,
    raw: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const schema = entry.responseSchema ?? {};
    const filtered: Record<string, unknown> = {};
    for (const [key, expectedType] of Object.entries(schema)) {
      if (!(key in raw) || typeof raw[key] !== expectedType) return null;
      filtered[key] = raw[key];
    }
    return filtered;
  }
}