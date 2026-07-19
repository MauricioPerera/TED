// Suite end-to-end: T0 (bundle real en disco, firmado con Ed25519 real) hasta
// T2 (orchestrator.handleCallback real, contra un store SQLite real). A
// diferencia de tests/unit/orchestrator.test.ts (que inyecta un readBundle
// falso para aislar la logica de secuenciacion), esta suite conecta
// src/bundle de verdad -- es la prueba de que los nueve modulos, integrados,
// cumplen el ciclo completo del Apendice A de la spec.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";

import { TicketStore } from "../../src/store/index.ts";
import {
  generateAttestationKeyPair,
  signAttestation,
  signTransport,
} from "../../src/crypto/index.ts";
import {
  readTicketFrontmatter,
  writeTicketFrontmatter,
  hashFile,
  buildCorpusManifest,
  readEffectsManifest,
  readFacts,
} from "../../src/bundle/index.ts";
import { canonicalizeAttestationPayload } from "../../src/attestation/index.ts";
import type { RevocationEntry } from "../../src/attestation/index.ts";
import { handleCallback } from "../../src/orchestrator/index.ts";
import { EffectsShim } from "../../src/shim/index.ts";
import type {
  BundleData,
  SignedCallback,
  OrchestratorDeps,
  Agent,
} from "../../src/orchestrator/index.ts";
import type { AttestationPayload } from "../../src/types.ts";

const TRANSPORT_SECRET = "cd".repeat(32);

interface EffectSpec {
  effectId: string;
  tool: string;
  constraints: string[];
  maxInvocations: number;
  kind: "read" | "write";
}

interface WriteTicketOptions {
  ticketId: string;
  validUntil: string;
  attestedAt: string;
  effects: EffectSpec[];
  facts: Record<string, unknown>;
}

// T0: escribe un bundle real en disco (ticket.md, instructions.md, effects.md,
// facts.md, context/), lo firma con una clave Ed25519 real, y devuelve todo
// lo que un "creador" real necesitaria: el keypair y la ruta del bundle.
function writeTicketBundle(basePath: string, opts: WriteTicketOptions) {
  const ticketDir = join(basePath, "tickets", opts.ticketId);
  mkdirSync(join(ticketDir, "context"), { recursive: true });

  writeFileSync(join(ticketDir, "instructions.md"), "Ejecuta el efecto autorizado.\n", "utf-8");

  const effectsDoc = {
    effects: opts.effects.map((e) => ({
      effect_id: e.effectId,
      tool: e.tool,
      constraints: e.constraints,
      idempotency_key: `${opts.ticketId}:${e.effectId}`,
      max_invocations: e.maxInvocations,
      escalation: { hard_triggers: [], soft_triggers_enabled: false },
      kind: e.kind,
    })),
  };
  writeFileSync(join(ticketDir, "effects.md"), `---\n${yamlStringify(effectsDoc)}---\n`, "utf-8");
  writeFileSync(join(ticketDir, "facts.md"), `---\n${yamlStringify({ facts: opts.facts })}---\n`, "utf-8");

  const instructionsSha256 = hashFile(join(ticketDir, "instructions.md"));
  const effectsSha256 = hashFile(join(ticketDir, "effects.md"));
  const factsSha256 = hashFile(join(ticketDir, "facts.md"));
  const corpusManifest = buildCorpusManifest(join(ticketDir, "context"));

  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  const attestationPayload: AttestationPayload = {
    ticketId: opts.ticketId,
    instructionsSha256,
    effectsSha256,
    factsSha256,
    corpusManifest,
    attestedAt: opts.attestedAt,
    validUntil: opts.validUntil,
  };
  const attestationSignatureHex = signAttestation(
    canonicalizeAttestationPayload(attestationPayload),
    privateKeyHex,
  );

  writeTicketFrontmatter(
    ticketDir,
    {
      type: "Ticket",
      title: "Ticket e2e",
      description: "Escenario de prueba end-to-end",
      timestamp: opts.attestedAt,
      ccddProvenance: { author: "human:e2e", generatedAt: opts.attestedAt, approvedBy: "human:e2e" },
      ticketId: opts.ticketId,
      supersedes: null,
      supersededBy: null,
      trigger: {
        kind: "external_callback",
        expectedFrom: "system:e2e",
        correlationKey: opts.ticketId,
      },
      attestation: {
        attestedBy: "human:e2e",
        attestedAt: opts.attestedAt,
        validUntil: opts.validUntil,
        signatureRef: `/tickets/attestations.json#${opts.ticketId}`,
      },
      projectedState: "pending",
      projectedAttempts: 0,
      projectedAsOf: opts.attestedAt,
    },
    "# Ticket e2e\n",
  );

  return { ticketDir, publicKeyHex, privateKeyHex, attestationSignatureHex };
}

// El "readBundle" REAL: lee del disco vía src/bundle, tal como haría un
// orquestador de producción (a diferencia del fake inyectado en
// tests/unit/orchestrator.test.ts).
function makeReadBundle(basePath: string, attestations: Record<string, string>) {
  return (ticketId: string): BundleData => {
    const ticketDir = join(basePath, "tickets", ticketId);
    return {
      frontmatter: readTicketFrontmatter(ticketDir),
      attestationSignatureHex: attestations[ticketId] as string,
      effects: readEffectsManifest(ticketDir),
      facts: readFacts(ticketDir),
      corpusManifest: buildCorpusManifest(join(ticketDir, "context")),
      instructionsSha256: hashFile(join(ticketDir, "instructions.md")),
      effectsSha256: hashFile(join(ticketDir, "effects.md")),
      factsSha256: hashFile(join(ticketDir, "facts.md")),
    };
  };
}

function signedCallback(ticketId: string, now: string): SignedCallback {
  return {
    ticketId,
    payload: "triggered",
    timestamp: now,
    signatureHex: signTransport("triggered", TRANSPORT_SECRET, now),
  };
}

// El agente T2 de referencia (Batch 4, DEFINITION.md "Fuera de alcance"):
// determinista, sin modelo real. Llama UN efecto y traduce el resultado del
// shim al vocabulario de AgentOutcome. El caso "already-confirmed-data-
// unavailable" (S11.2: un sucesor sin caché local no puede recuperar el
// payload exacto, pero el store SÍ confirma que el efecto ya ocurrió) se
// trata como éxito -- la propiedad de seguridad que importa es "nunca
// re-ejecutar", no "siempre recuperar los mismos bytes".
function singleEffectAgent(effectId: string, params: Record<string, unknown>): Agent {
  return (shim) => {
    const result = shim.invoke(effectId, params);
    if (result.outcome === "result") return { finished: "fulfilled" };
    if (result.outcome === "rejected" && result.reason === "already-confirmed-data-unavailable") {
      return { finished: "fulfilled" };
    }
    if (result.outcome === "escalated") return { finished: "escalated", reason: result.trigger };
    return { finished: "failed", reason: result.outcome === "rejected" ? result.reason : "agent-aborted" };
  };
}

function baseDeps(
  store: TicketStore,
  basePath: string,
  attestations: Record<string, string>,
  publicKeyHex: string,
  crl: RevocationEntry[],
  agent: Agent,
  executeCalls: Array<{ tool: string; params: Record<string, unknown> }>,
): OrchestratorDeps {
  return {
    store,
    transportSecretHex: TRANSPORT_SECRET,
    toleranceMs: 300000,
    leaseTtlMs: 600000,
    denyThreshold: 3,
    execute: (tool, params) => {
      executeCalls.push({ tool, params });
      return { receipt: `r${executeCalls.length}`, amount: params["amount"] };
    },
    readBundle: makeReadBundle(basePath, attestations),
    creatorPublicKeyHex: publicKeyHex,
    crl,
    agent,
  };
}

function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), "ted-e2e-"));
}

test("happy path: a real signed bundle on disk runs through to fulfilled", () => {
  const base = tmpBase();
  const { publicKeyHex, attestationSignatureHex } = writeTicketBundle(base, {
    ticketId: "t-happy",
    attestedAt: "2026-07-19T00:00:00.000Z",
    validUntil: "2026-08-19T00:00:00.000Z",
    effects: [{ effectId: "charge", tool: "billing.charge", constraints: ["params.amount <= facts.limit"], maxInvocations: 3, kind: "write" }],
    facts: { limit: 100 },
  });
  const executeCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const store = new TicketStore(":memory:");
  store.createPending("t-happy", 3);
  const deps = baseDeps(store, base, { "t-happy": attestationSignatureHex }, publicKeyHex, [], singleEffectAgent("charge", { amount: 10 }), executeCalls);
  const now = "2026-07-19T01:00:00.000Z";
  const result = handleCallback(deps, signedCallback("t-happy", now), now);
  assert.deepEqual(result, { outcome: "fulfilled" });
  assert.equal(store.getRecord("t-happy")?.state, "fulfilled");
  assert.equal(executeCalls.length, 1);
  assert.equal(executeCalls[0]?.tool, "billing.charge");
  rmSync(base, { recursive: true, force: true });
});

test("content tampered with after signing is caught as integrity-violated (S5 point 2)", () => {
  const base = tmpBase();
  const { publicKeyHex, attestationSignatureHex } = writeTicketBundle(base, {
    ticketId: "t-tamper",
    attestedAt: "2026-07-19T00:00:00.000Z",
    validUntil: "2026-08-19T00:00:00.000Z",
    effects: [{ effectId: "charge", tool: "billing.charge", constraints: [], maxInvocations: 3, kind: "write" }],
    facts: {},
  });
  // Alguien reescribe instructions.md DESPUES de la firma.
  writeFileSync(join(base, "tickets", "t-tamper", "instructions.md"), "Instrucciones alteradas.\n", "utf-8");
  const executeCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const store = new TicketStore(":memory:");
  store.createPending("t-tamper", 3);
  const deps = baseDeps(store, base, { "t-tamper": attestationSignatureHex }, publicKeyHex, [], singleEffectAgent("charge", {}), executeCalls);
  const now = "2026-07-19T01:00:00.000Z";
  const result = handleCallback(deps, signedCallback("t-tamper", now), now);
  assert.deepEqual(result, { outcome: "integrity-violated" });
  assert.equal(store.getRecord("t-tamper")?.state, "failed");
  assert.equal(store.getRecord("t-tamper")?.failureCause, "integrity-violated");
  assert.equal(executeCalls.length, 0, "a tampered ticket must never reach execution");
  rmSync(base, { recursive: true, force: true });
});

test("a window that has closed is caught as expired before the agent ever runs", () => {
  const base = tmpBase();
  const { publicKeyHex, attestationSignatureHex } = writeTicketBundle(base, {
    ticketId: "t-expired",
    attestedAt: "2026-06-01T00:00:00.000Z",
    validUntil: "2026-07-01T00:00:00.000Z",
    effects: [],
    facts: {},
  });
  const executeCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const store = new TicketStore(":memory:");
  store.createPending("t-expired", 3);
  const deps = baseDeps(store, base, { "t-expired": attestationSignatureHex }, publicKeyHex, [], () => ({ finished: "fulfilled" }), executeCalls);
  const now = "2026-07-19T00:00:00.000Z";
  const result = handleCallback(deps, signedCallback("t-expired", now), now);
  assert.deepEqual(result, { outcome: "expired" });
  assert.equal(store.getRecord("t-expired")?.state, "expired");
  rmSync(base, { recursive: true, force: true });
});

test("a ticket cancelled via a real signed CRL entry never reaches the agent", () => {
  const base = tmpBase();
  const { publicKeyHex, privateKeyHex, attestationSignatureHex } = writeTicketBundle(base, {
    ticketId: "t-revoked",
    attestedAt: "2026-07-19T00:00:00.000Z",
    validUntil: "2026-08-19T00:00:00.000Z",
    effects: [],
    facts: {},
  });
  const revokedAt = "2026-07-19T00:30:00.000Z";
  const crl: RevocationEntry[] = [
    { ticketId: "t-revoked", revokedAt, signatureHex: signAttestation(`t-revoked:${revokedAt}:revoked`, privateKeyHex) },
  ];
  const executeCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const store = new TicketStore(":memory:");
  store.createPending("t-revoked", 3);
  const deps = baseDeps(store, base, { "t-revoked": attestationSignatureHex }, publicKeyHex, crl, () => ({ finished: "fulfilled" }), executeCalls);
  const now = "2026-07-19T01:00:00.000Z";
  const result = handleCallback(deps, signedCallback("t-revoked", now), now);
  assert.deepEqual(result, { outcome: "revoked" });
  assert.equal(store.getRecord("t-revoked")?.state, "cancelled");
  rmSync(base, { recursive: true, force: true });
});

test("a duplicate callback on the same ticket is absorbed with no second effect execution", () => {
  const base = tmpBase();
  const { publicKeyHex, attestationSignatureHex } = writeTicketBundle(base, {
    ticketId: "t-dup",
    attestedAt: "2026-07-19T00:00:00.000Z",
    validUntil: "2026-08-19T00:00:00.000Z",
    effects: [{ effectId: "charge", tool: "billing.charge", constraints: [], maxInvocations: 3, kind: "write" }],
    facts: {},
  });
  const executeCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const store = new TicketStore(":memory:");
  store.createPending("t-dup", 3);
  const deps = baseDeps(store, base, { "t-dup": attestationSignatureHex }, publicKeyHex, [], singleEffectAgent("charge", { amount: 1 }), executeCalls);
  const now = "2026-07-19T01:00:00.000Z";
  const first = handleCallback(deps, signedCallback("t-dup", now), now);
  const second = handleCallback(deps, signedCallback("t-dup", now), now);
  assert.deepEqual(first, { outcome: "fulfilled" });
  assert.deepEqual(second, { outcome: "duplicate" });
  assert.equal(executeCalls.length, 1);
  rmSync(base, { recursive: true, force: true });
});

test("a constraint that cannot be evaluated escalates the ticket rather than denying or crashing (S12.3)", () => {
  const base = tmpBase();
  // facts.md no declara "limit", pero la constraint del efecto lo referencia
  // -> error de evaluacion, no deny (S12.3: el contrato esta mal formado).
  const { publicKeyHex, attestationSignatureHex } = writeTicketBundle(base, {
    ticketId: "t-escalate",
    attestedAt: "2026-07-19T00:00:00.000Z",
    validUntil: "2026-08-19T00:00:00.000Z",
    effects: [{ effectId: "charge", tool: "billing.charge", constraints: ["params.amount <= facts.limit"], maxInvocations: 3, kind: "write" }],
    facts: {},
  });
  const executeCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const store = new TicketStore(":memory:");
  store.createPending("t-escalate", 3);
  const deps = baseDeps(store, base, { "t-escalate": attestationSignatureHex }, publicKeyHex, [], singleEffectAgent("charge", { amount: 10 }), executeCalls);
  const now = "2026-07-19T01:00:00.000Z";
  const result = handleCallback(deps, signedCallback("t-escalate", now), now);
  assert.deepEqual(result, { outcome: "escalated", trigger: "constraint-error" });
  assert.equal(store.getRecord("t-escalate")?.state, "escalated");
  assert.equal(executeCalls.length, 0);
  rmSync(base, { recursive: true, force: true });
});

test("a successor recovers after a crash: the confirmed effect is never re-executed, even with a fresh shim instance and a new fencing token", () => {
  const base = tmpBase();
  const { publicKeyHex, attestationSignatureHex } = writeTicketBundle(base, {
    ticketId: "t-recover",
    attestedAt: "2026-07-19T00:00:00.000Z",
    validUntil: "2026-08-19T00:00:00.000Z",
    effects: [{ effectId: "charge", tool: "billing.charge", constraints: [], maxInvocations: 3, kind: "write" }],
    facts: {},
  });
  const executeCalls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const store = new TicketStore(":memory:");
  store.createPending("t-recover", 3);

  // Simula el "attempt 1": un agente confirma el efecto contra el shim y
  // luego el proceso muere ANTES de que el orquestador transicione el
  // ticket a fulfilled (el ticket queda "leased").
  const t1 = "2026-07-19T01:00:00.000Z";
  const lease1 = store.acquireLease("t-recover", 60000, t1);
  assert.equal(lease1?.state, "leased");
  const crashedAttemptShim = new EffectsShim({
    store,
    ticketId: "t-recover",
    fencingToken: lease1?.fencingToken as number,
    manifest: readEffectsManifest(join(base, "tickets", "t-recover")),
    compiledConstraints: new Map(),
    facts: {},
    now: t1,
    denyThreshold: 3,
    execute: (tool, params) => {
      executeCalls.push({ tool, params });
      return { receipt: `r${executeCalls.length}`, amount: params["amount"] };
    },
  });
  assert.equal(crashedAttemptShim.invoke("charge", { amount: 5 }).outcome, "result");
  assert.equal(executeCalls.length, 1);
  assert.equal(store.getRecord("t-recover")?.state, "leased", "the crashed attempt never finalized the ticket state");

  // El reloj/proximo orquestador constata el lease vencido -> vuelve a pending.
  const reclaimed = store.reclaimExpiredLease("t-recover", "2026-07-19T01:20:00.000Z");
  assert.equal(reclaimed?.state, "pending");

  // Un sucesor real, vía handleCallback completo, con un NUEVO fencing token
  // y un EffectsShim SIN caché local (instancia nueva).
  const deps = baseDeps(store, base, { "t-recover": attestationSignatureHex }, publicKeyHex, [], singleEffectAgent("charge", { amount: 5 }), executeCalls);
  const t2 = "2026-07-19T01:21:00.000Z";
  const secondAttempt = handleCallback(deps, signedCallback("t-recover", t2), t2);
  assert.deepEqual(secondAttempt, { outcome: "fulfilled" });
  assert.equal(store.getRecord("t-recover")?.state, "fulfilled");
  assert.equal(executeCalls.length, 1, "the successor's fresh shim must never re-execute an effect the store already confirmed");
  rmSync(base, { recursive: true, force: true });
});

test("exhausting max_attempts without ever completing lands the ticket in failed/retry-exhausted (S6.4 invariant 2)", () => {
  const store = new TicketStore(":memory:");
  store.createPending("t-exhausted", 2); // max_attempts: 2
  const t1 = "2026-07-19T01:00:00.000Z";

  // Dos ciclos de lease-adquirido-y-nunca-completado (el agente cuelga o el
  // proceso muere antes de invocarlo siquiera), cada uno reclamado por el
  // reloj tras vencer.
  store.acquireLease("t-exhausted", 1000, t1);
  const afterFirstReclaim = store.reclaimExpiredLease("t-exhausted", "2026-07-19T01:00:02.000Z");
  assert.equal(afterFirstReclaim?.state, "pending");
  assert.equal(afterFirstReclaim?.attempts, 1);

  store.acquireLease("t-exhausted", 1000, "2026-07-19T01:00:03.000Z");
  const afterSecondReclaim = store.reclaimExpiredLease("t-exhausted", "2026-07-19T01:00:05.000Z");
  assert.equal(afterSecondReclaim?.state, "failed");
  assert.equal(afterSecondReclaim?.failureCause, "retry-exhausted");

  // Terminal: ningun callback posterior puede reabrirlo.
  const laterLease = store.acquireLease("t-exhausted", 1000, "2026-07-19T02:00:00.000Z");
  assert.equal(laterLease, null);
});
