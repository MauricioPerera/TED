// Oraculo congelado para knowledge/contracts/ted-orchestrator.md. NO editar
// como parte de la implementacion -- ver touch_only del contrato.
import test from "node:test";
import assert from "node:assert/strict";
import { TicketStore } from "../../src/store/index.ts";
import {
  generateAttestationKeyPair,
  signAttestation,
  signTransport,
} from "../../src/crypto/index.ts";
import {
  canonicalizeAttestationPayload,
} from "../../src/attestation/index.ts";
import type { RevocationEntry } from "../../src/attestation/index.ts";
import { handleCallback } from "../../src/orchestrator/index.ts";
import type {
  BundleData,
  SignedCallback,
  OrchestratorDeps,
  Agent,
} from "../../src/orchestrator/index.ts";
import type { TicketFrontmatter } from "../../src/types.ts";

const NOW = "2026-07-19T12:00:00.000Z";
const TRANSPORT_SECRET = "ab".repeat(32);

function baseFrontmatter(validUntil: string): TicketFrontmatter {
  return {
    type: "Ticket",
    title: "t",
    description: "d",
    timestamp: NOW,
    ccddProvenance: { author: "human:x", generatedAt: NOW, approvedBy: "human:x" },
    ticketId: "t1",
    supersedes: null,
    supersededBy: null,
    trigger: { kind: "external_callback", expectedFrom: "system:billing", correlationKey: "t1" },
    attestation: {
      attestedBy: "human:x",
      attestedAt: NOW,
      validUntil,
      signatureRef: "/tickets/attestations.json#t1",
    },
    projectedState: "pending",
    projectedAttempts: 0,
    projectedAsOf: NOW,
  };
}

function setup(overrides?: {
  validUntil?: string;
  tamperInstructions?: boolean;
  crl?: RevocationEntry[];
  agent?: Agent;
}) {
  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  const validUntil = overrides?.validUntil ?? "2026-08-19T00:00:00.000Z";
  const frontmatter = baseFrontmatter(validUntil);
  const signedPayload = {
    ticketId: "t1",
    instructionsSha256: "11".repeat(32),
    effectsSha256: "22".repeat(32),
    factsSha256: "33".repeat(32),
    corpusManifest: [],
    attestedAt: NOW,
    validUntil,
  };
  const attestationSignatureHex = signAttestation(
    canonicalizeAttestationPayload(signedPayload),
    privateKeyHex,
  );

  const bundle: BundleData = {
    frontmatter,
    attestationSignatureHex,
    effects: [
      {
        effectId: "charge",
        tool: "billing.charge",
        constraints: ["params.amount <= facts.limit"],
        idempotencyKey: "t1:charge",
        maxInvocations: 3,
        escalation: { hardTriggers: [], softTriggersEnabled: false },
        kind: "write",
      },
    ],
    facts: { limit: 100 },
    corpusManifest: [],
    instructionsSha256: overrides?.tamperInstructions ? "ff".repeat(32) : signedPayload.instructionsSha256,
    effectsSha256: signedPayload.effectsSha256,
    factsSha256: signedPayload.factsSha256,
  };

  const store = new TicketStore(":memory:");
  store.createPending("t1", 3);

  const callback: SignedCallback = {
    ticketId: "t1",
    payload: "triggered",
    timestamp: NOW,
    signatureHex: signTransport("triggered", TRANSPORT_SECRET, NOW),
  };

  const singleChargeAgent: Agent = (shim) => {
    const result = shim.invoke("charge", { amount: 10 });
    if (result.outcome === "result") return { finished: "fulfilled" };
    if (result.outcome === "escalated") return { finished: "escalated", reason: result.trigger };
    return { finished: "failed", reason: result.reason };
  };

  const deps: OrchestratorDeps = {
    store,
    transportSecretHex: TRANSPORT_SECRET,
    toleranceMs: 300000,
    leaseTtlMs: 600000,
    denyThreshold: 3,
    execute: (_tool, params) => ({ receipt: "r1", amount: params["amount"] }),
    readBundle: () => bundle,
    creatorPublicKeyHex: publicKeyHex,
    crl: overrides?.crl ?? [],
    agent: overrides?.agent ?? singleChargeAgent,
  };

  return { store, callback, deps };
}

test("an invalid transport signature is rejected without touching the store", () => {
  const { store, callback, deps } = setup();
  const badCallback = { ...callback, signatureHex: "00".repeat(32) };
  const result = handleCallback(deps, badCallback, NOW);
  assert.deepEqual(result, { outcome: "invalid-transport" });
  assert.equal(store.getRecord("t1")?.state, "pending");
});

test("a duplicate callback on an already-leased ticket is absorbed as duplicate", () => {
  const { callback, deps } = setup();
  handleCallback(deps, callback, NOW);
  const second = handleCallback(deps, callback, NOW);
  assert.deepEqual(second, { outcome: "duplicate" });
});

test("content that no longer matches the attestation is integrity-violated and lands in failed", () => {
  const { store, callback, deps } = setup({ tamperInstructions: true });
  const result = handleCallback(deps, callback, NOW);
  assert.deepEqual(result, { outcome: "integrity-violated" });
  assert.equal(store.getRecord("t1")?.state, "failed");
  assert.equal(store.getRecord("t1")?.failureCause, "integrity-violated");
});

test("a ticket on the CRL is revoked and lands in cancelled, even before checking freshness", () => {
  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  const revokedAt = "2026-07-19T06:00:00.000Z";
  const signatureHex = signAttestation(`t1:${revokedAt}:revoked`, privateKeyHex);
  // Reconstruimos setup con la MISMA clave para que la revocacion sea valida
  // contra el creatorPublicKeyHex real de este escenario.
  const validUntil = "2026-08-19T00:00:00.000Z";
  const frontmatter = baseFrontmatter(validUntil);
  const signedPayload = {
    ticketId: "t1",
    instructionsSha256: "11".repeat(32),
    effectsSha256: "22".repeat(32),
    factsSha256: "33".repeat(32),
    corpusManifest: [],
    attestedAt: NOW,
    validUntil,
  };
  const attestationSignatureHex = signAttestation(
    canonicalizeAttestationPayload(signedPayload),
    privateKeyHex,
  );
  const bundle: BundleData = {
    frontmatter,
    attestationSignatureHex,
    effects: [],
    facts: {},
    corpusManifest: [],
    instructionsSha256: signedPayload.instructionsSha256,
    effectsSha256: signedPayload.effectsSha256,
    factsSha256: signedPayload.factsSha256,
  };
  const store = new TicketStore(":memory:");
  store.createPending("t1", 3);
  const callback: SignedCallback = {
    ticketId: "t1",
    payload: "triggered",
    timestamp: NOW,
    signatureHex: signTransport("triggered", TRANSPORT_SECRET, NOW),
  };
  const deps: OrchestratorDeps = {
    store,
    transportSecretHex: TRANSPORT_SECRET,
    toleranceMs: 300000,
    leaseTtlMs: 600000,
    denyThreshold: 3,
    execute: () => ({}),
    readBundle: () => bundle,
    creatorPublicKeyHex: publicKeyHex,
    crl: [{ ticketId: "t1", revokedAt, signatureHex }],
    agent: () => ({ finished: "fulfilled" }),
  };
  const result = handleCallback(deps, callback, NOW);
  assert.deepEqual(result, { outcome: "revoked" });
  assert.equal(store.getRecord("t1")?.state, "cancelled");
});

test("an expired attestation window lands in expired, when not revoked", () => {
  const { store, callback, deps } = setup({ validUntil: "2026-07-01T00:00:00.000Z" });
  const result = handleCallback(deps, callback, NOW);
  assert.deepEqual(result, { outcome: "expired" });
  assert.equal(store.getRecord("t1")?.state, "expired");
});

test("the happy path runs the agent against the shim and lands in fulfilled", () => {
  const { store, callback, deps } = setup();
  const result = handleCallback(deps, callback, NOW);
  assert.deepEqual(result, { outcome: "fulfilled" });
  assert.equal(store.getRecord("t1")?.state, "fulfilled");
});

test("an agent that escalates lands the ticket in escalated with the trigger surfaced", () => {
  const escalatingAgent: Agent = (shim) => {
    const result = shim.invoke("does-not-exist", {});
    if (result.outcome === "escalated") return { finished: "escalated", reason: result.trigger };
    return { finished: "failed" };
  };
  const { store, callback, deps } = setup({ agent: escalatingAgent });
  const result = handleCallback(deps, callback, NOW);
  assert.deepEqual(result, { outcome: "escalated", trigger: "unknown-tool-invoked" });
  assert.equal(store.getRecord("t1")?.state, "escalated");
});

test("an agent that aborts lands the ticket in failed with the reported cause", () => {
  const abortingAgent: Agent = () => ({ finished: "failed", reason: "agent-aborted" });
  const { store, callback, deps } = setup({ agent: abortingAgent });
  const result = handleCallback(deps, callback, NOW);
  assert.deepEqual(result, { outcome: "failed", cause: "agent-aborted" });
  assert.equal(store.getRecord("t1")?.state, "failed");
});

test("a ticket that already reached a terminal state rejects a later callback as duplicate", () => {
  const { callback, deps } = setup();
  handleCallback(deps, callback, NOW); // -> fulfilled
  const later = handleCallback(deps, callback, "2026-07-19T12:00:04.000Z");
  assert.deepEqual(later, { outcome: "duplicate" });
});
