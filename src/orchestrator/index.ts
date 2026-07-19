// Orquestador: cadena pending -> leased (S6.3) bajo
// knowledge/contracts/ted-orchestrator.md. Orquesta en la secuencia exacta
// transporte -> CAS -> atestacion+CRL+vigencia -> ensamblado del shim -> agente.
// NO reimplementa crypto, store, attestation, constraints ni shim: solo los
// importa y los invoca en el orden vinculante del contrato.
import type {
  TicketFrontmatter,
  EffectManifestEntry,
  CorpusManifestEntry,
  AttestationPayload,
} from "../types.ts";
import type { TicketStore } from "../store/index.ts";
import type { RevocationEntry } from "../attestation/index.ts";
import type { EffectsShim } from "../shim/index.ts";
import type { CompiledConstraint } from "../constraints/index.ts";
import { verifyTransport } from "../crypto/index.ts";
import { verifyPendingToLeased } from "../attestation/index.ts";
import { compileConstraint } from "../constraints/index.ts";
import { EffectsShim as EffectsShimCtor } from "../shim/index.ts";

export interface SignedCallback {
  ticketId: string;
  payload: string;
  timestamp: string;
  signatureHex: string;
}

export interface BundleData {
  frontmatter: TicketFrontmatter;
  attestationSignatureHex: string;
  effects: EffectManifestEntry[];
  facts: Record<string, unknown>;
  corpusManifest: CorpusManifestEntry[];
  instructionsSha256: string;
  effectsSha256: string;
  factsSha256: string;
}

export interface AgentOutcome {
  finished: "fulfilled" | "escalated" | "failed";
  reason?: string;
}

export type Agent = (shim: EffectsShim) => AgentOutcome;

export type CallbackOutcome =
  | { outcome: "invalid-transport" }
  | { outcome: "duplicate" }
  | { outcome: "integrity-violated" }
  | { outcome: "revoked" }
  | { outcome: "expired" }
  | { outcome: "fulfilled" }
  | { outcome: "escalated"; trigger?: string }
  | { outcome: "failed"; cause?: string };

export interface OrchestratorDeps {
  store: TicketStore;
  transportSecretHex: string;
  toleranceMs: number;
  leaseTtlMs: number;
  denyThreshold: number;
  execute: (tool: string, params: Record<string, unknown>) => Record<string, unknown>;
  readBundle: (ticketId: string) => BundleData;
  creatorPublicKeyHex: string;
  crl: RevocationEntry[];
  agent: Agent;
}

// Paso 1: transporte. Mensaje no autenticado -> sin tocar el store en absoluto.
function verifyCallbackTransport(
  deps: OrchestratorDeps,
  callback: SignedCallback,
  now: string,
): boolean {
  return verifyTransport(
    callback.payload,
    deps.transportSecretHex,
    callback.timestamp,
    callback.signatureHex,
    now,
    deps.toleranceMs,
  );
}

// Paso 3: ensambla el payload de atestacion desde el bundle + frontmatter.
function assembleAttestation(
  bundle: BundleData,
  ticketId: string,
): AttestationPayload {
  return {
    ticketId,
    instructionsSha256: bundle.instructionsSha256,
    effectsSha256: bundle.effectsSha256,
    factsSha256: bundle.factsSha256,
    corpusManifest: bundle.corpusManifest,
    attestedAt: bundle.frontmatter.attestation.attestedAt,
    validUntil: bundle.frontmatter.attestation.validUntil,
  };
}

// Paso 3: cadena de atestacion + CRL + vigencia. Transiciona al terminal
// correspondiente en cada fallo; "proceed" deja el ticket en leased para el agente.
function runAttestationChain(
  deps: OrchestratorDeps,
  bundle: BundleData,
  ticketId: string,
  fencingToken: number,
  now: string,
): "proceed" | CallbackOutcome {
  const attestation = assembleAttestation(bundle, ticketId);
  const result = verifyPendingToLeased({
    attestation,
    attestationSignatureHex: bundle.attestationSignatureHex,
    creatorPublicKeyHex: deps.creatorPublicKeyHex,
    actualInstructionsSha256: bundle.instructionsSha256,
    actualEffectsSha256: bundle.effectsSha256,
    actualFactsSha256: bundle.factsSha256,
    actualCorpusManifest: bundle.corpusManifest,
    crl: deps.crl,
    now,
  });
  if (result.verdict === "proceed") return "proceed";
  if (result.verdict === "integrity-violated") {
    deps.store.transition(ticketId, fencingToken, ["leased"], "failed", "integrity-violated");
    return { outcome: "integrity-violated" };
  }
  if (result.verdict === "revoked") {
    deps.store.transition(ticketId, fencingToken, ["leased"], "cancelled");
    return { outcome: "revoked" };
  }
  // verdict === "expired"
  deps.store.transition(ticketId, fencingToken, ["leased"], "expired");
  return { outcome: "expired" };
}

// Paso 4: compila las constraints de cada efecto y construye el EffectsShim.
function assembleShim(
  deps: OrchestratorDeps,
  bundle: BundleData,
  ticketId: string,
  fencingToken: number,
  now: string,
): EffectsShim {
  const compiledConstraints = new Map<string, CompiledConstraint[]>();
  for (const effect of bundle.effects) {
    compiledConstraints.set(effect.effectId, effect.constraints.map(compileConstraint));
  }
  return new EffectsShimCtor({
    store: deps.store,
    ticketId,
    fencingToken,
    manifest: bundle.effects,
    compiledConstraints,
    facts: bundle.facts,
    now,
    denyThreshold: deps.denyThreshold,
    execute: deps.execute,
  });
}

// Paso 5: invoca al agente y transiciona segun su outcome.
function invokeAgent(
  deps: OrchestratorDeps,
  ticketId: string,
  fencingToken: number,
  shim: EffectsShim,
): CallbackOutcome {
  const outcome = deps.agent(shim);
  if (outcome.finished === "fulfilled") {
    deps.store.transition(ticketId, fencingToken, ["leased"], "fulfilled");
    return { outcome: "fulfilled" };
  }
  if (outcome.finished === "escalated") {
    deps.store.transition(ticketId, fencingToken, ["leased"], "escalated");
    const result: CallbackOutcome = { outcome: "escalated" };
    if (outcome.reason !== undefined) result.trigger = outcome.reason;
    return result;
  }
  // finished === "failed"
  deps.store.transition(ticketId, fencingToken, ["leased"], "failed", "agent-aborted");
  const result: CallbackOutcome = { outcome: "failed" };
  if (outcome.reason !== undefined) result.cause = outcome.reason;
  return result;
}

export function handleCallback(
  deps: OrchestratorDeps,
  callback: SignedCallback,
  now: string,
): CallbackOutcome {
  // 1. Transporte: sin tocar el store si falla.
  if (!verifyCallbackTransport(deps, callback, now)) {
    return { outcome: "invalid-transport" };
  }
  // 2. CAS: duplicado / no pending / inexistente -> absorbido como duplicate.
  const lease = deps.store.acquireLease(callback.ticketId, deps.leaseTtlMs, now);
  if (!lease) return { outcome: "duplicate" };
  const fencingToken = lease.fencingToken;
  // 3. Atestacion + CRL + vigencia (readBundle una sola vez, reusado en paso 4).
  const bundle = deps.readBundle(callback.ticketId);
  const attestationResult = runAttestationChain(
    deps,
    bundle,
    callback.ticketId,
    fencingToken,
    now,
  );
  if (attestationResult !== "proceed") return attestationResult;
  // 4 + 5. Ensamblar el shim e invocar al agente.
  const shim = assembleShim(deps, bundle, callback.ticketId, fencingToken, now);
  return invokeAgent(deps, callback.ticketId, fencingToken, shim);
}