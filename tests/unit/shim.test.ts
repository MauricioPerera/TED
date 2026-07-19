// Oraculo congelado para knowledge/contracts/ted-shim.md. NO editar como
// parte de la implementacion -- ver touch_only del contrato.
import test from "node:test";
import assert from "node:assert/strict";
import { TicketStore } from "../../src/store/index.ts";
import { compileConstraint } from "../../src/constraints/index.ts";
import { EffectsShim } from "../../src/shim/index.ts";
import type { EffectManifestEntry } from "../../src/types.ts";

const NOW = "2026-07-19T00:00:00.000Z";

function entry(overrides: Partial<EffectManifestEntry>): EffectManifestEntry {
  return {
    effectId: "e",
    tool: "svc.op",
    constraints: [],
    idempotencyKey: "t1:e",
    maxInvocations: 5,
    escalation: { hardTriggers: [], softTriggersEnabled: false },
    kind: "write",
    ...overrides,
  };
}

function leasedStore(ticketId = "t1", maxAttempts = 3): TicketStore {
  const store = new TicketStore(":memory:");
  store.createPending(ticketId, maxAttempts);
  store.acquireLease(ticketId, 600000, NOW);
  return store;
}

test("invoking an unknown effect escalates without calling execute", () => {
  const store = leasedStore();
  let calls = 0;
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [entry({ effectId: "known" })],
    compiledConstraints: new Map(),
    facts: {},
    now: NOW,
    denyThreshold: 3,
    execute: () => {
      calls++;
      return {};
    },
  });
  const result = shim.invoke("unknown", {});
  assert.deepEqual(result, { outcome: "escalated", trigger: "unknown-tool-invoked" });
  assert.equal(calls, 0);
});

test("a permitted invocation executes once and returns the result", () => {
  const store = leasedStore();
  let calls = 0;
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [entry({ effectId: "charge" })],
    compiledConstraints: new Map([["charge", [compileConstraint("params.amount <= facts.limit")]]]),
    facts: { limit: 100 },
    now: NOW,
    denyThreshold: 3,
    execute: (_tool, params) => {
      calls++;
      return { receipt: "r1", amount: params["amount"] };
    },
  });
  const result = shim.invoke("charge", { amount: 50 });
  assert.deepEqual(result, { outcome: "result", data: { receipt: "r1", amount: 50 } });
  assert.equal(calls, 1);
});

test("re-invoking a confirmed effect on the SAME shim returns the cached result without re-executing", () => {
  const store = leasedStore();
  let calls = 0;
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [entry({ effectId: "charge" })],
    compiledConstraints: new Map([["charge", [compileConstraint("params.amount <= facts.limit")]]]),
    facts: { limit: 100 },
    now: NOW,
    denyThreshold: 3,
    execute: (_tool, params) => {
      calls++;
      return { receipt: "r1", amount: params["amount"] };
    },
  });
  const first = shim.invoke("charge", { amount: 50 });
  const second = shim.invoke("charge", { amount: 50 });
  assert.deepEqual(second, first);
  assert.equal(calls, 1, "execute must not run twice for an already-confirmed effect");
});

test("a denied invocation is rejected and never executes", () => {
  const store = leasedStore();
  let calls = 0;
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [entry({ effectId: "charge" })],
    compiledConstraints: new Map([["charge", [compileConstraint("params.amount <= facts.limit")]]]),
    facts: { limit: 10 },
    now: NOW,
    denyThreshold: 3,
    execute: () => {
      calls++;
      return {};
    },
  });
  const result = shim.invoke("charge", { amount: 50 });
  assert.deepEqual(result, { outcome: "rejected", reason: "constraint-denied" });
  assert.equal(calls, 0);
});

test("repeated denies of the same effect escalate once the threshold is reached", () => {
  const store = leasedStore();
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [entry({ effectId: "charge" })],
    compiledConstraints: new Map([["charge", [compileConstraint("params.amount <= facts.limit")]]]),
    facts: { limit: 10 },
    now: NOW,
    denyThreshold: 3,
    execute: () => ({}),
  });
  assert.deepEqual(shim.invoke("charge", { amount: 50 }), { outcome: "rejected", reason: "constraint-denied" });
  assert.deepEqual(shim.invoke("charge", { amount: 50 }), { outcome: "rejected", reason: "constraint-denied" });
  assert.deepEqual(shim.invoke("charge", { amount: 50 }), { outcome: "escalated", trigger: "repeated-deny" });
});

test("deny counters are independent per effect: denying one effect twice does not push an unrelated effect toward escalation", () => {
  const store = leasedStore();
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [entry({ effectId: "charge" }), entry({ effectId: "other" })],
    compiledConstraints: new Map([
      ["charge", [compileConstraint("params.amount <= facts.limit")]],
      ["other", [compileConstraint("params.amount <= facts.limit")]],
    ]),
    facts: { limit: 10 },
    now: NOW,
    denyThreshold: 2,
    execute: () => ({}),
  });
  assert.equal(shim.invoke("charge", { amount: 50 }).outcome, "rejected"); // charge deny 1
  assert.equal(shim.invoke("charge", { amount: 50 }).outcome, "escalated"); // charge deny 2 -> threshold
  assert.equal(shim.invoke("other", { amount: 50 }).outcome, "rejected", "a different effect's deny count starts fresh, unaffected by charge's escalation");
});

test("a constraint that errors escalates instead of denying", () => {
  const store = leasedStore();
  let calls = 0;
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [entry({ effectId: "charge" })],
    compiledConstraints: new Map([["charge", [compileConstraint("facts.missing_fact == 1")]]]),
    facts: {},
    now: NOW,
    denyThreshold: 3,
    execute: () => {
      calls++;
      return {};
    },
  });
  const result = shim.invoke("charge", { amount: 1 });
  assert.deepEqual(result, { outcome: "escalated", trigger: "constraint-error" });
  assert.equal(calls, 0);
});

test("reaching max_invocations (without ever confirming) escalates and never executes", () => {
  const store = leasedStore();
  // Simula 2 intentos previos (crash-recovery) sin confirmar, con el mismo fencing token.
  store.ledgerMarkAttempted("t1", "charge", 1, "hashA", NOW);
  store.ledgerMarkAttempted("t1", "charge", 1, "hashB", NOW);
  let calls = 0;
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [entry({ effectId: "charge", maxInvocations: 2 })],
    compiledConstraints: new Map([["charge", []]]),
    facts: {},
    now: NOW,
    denyThreshold: 3,
    execute: () => {
      calls++;
      return {};
    },
  });
  const result = shim.invoke("charge", { amount: 1 });
  assert.deepEqual(result, { outcome: "escalated", trigger: "max-invocations-reached" });
  assert.equal(calls, 0);
});

test("a stale fencing token (zombie agent) is rejected before execution (S6.4 invariant 4)", () => {
  const store = leasedStore();
  // Un sucesor reclama el lease vencido y lo vuelve a adquirir: el token pasa a 2.
  store.reclaimExpiredLease("t1", "2026-07-19T00:20:00.000Z");
  store.acquireLease("t1", 600000, "2026-07-19T00:20:01.000Z");
  let calls = 0;
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1, // el token viejo, ya no vigente
    manifest: [entry({ effectId: "charge" })],
    compiledConstraints: new Map([["charge", []]]),
    facts: {},
    now: NOW,
    denyThreshold: 3,
    execute: () => {
      calls++;
      return {};
    },
  });
  const result = shim.invoke("charge", { amount: 1 });
  assert.deepEqual(result, { outcome: "rejected", reason: "stale-lease" });
  assert.equal(calls, 0);
});

test("an effect already confirmed by another process, with no local cache, is rejected rather than re-executed", () => {
  const store = leasedStore();
  store.ledgerMarkAttempted("t1", "charge", 1, "hashA", NOW);
  store.ledgerMarkConfirmed("t1", "charge", "resulthashA", NOW);
  let calls = 0;
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [entry({ effectId: "charge" })],
    compiledConstraints: new Map([["charge", []]]),
    facts: {},
    now: NOW,
    denyThreshold: 3,
    execute: () => {
      calls++;
      return {};
    },
  });
  const result = shim.invoke("charge", { amount: 1 });
  assert.deepEqual(result, { outcome: "rejected", reason: "already-confirmed-data-unavailable" });
  assert.equal(calls, 0);
});

test("read effects validate the response against the declared schema, discarding undeclared fields", () => {
  const store = leasedStore();
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [
      entry({
        effectId: "getbalance",
        kind: "read",
        responseSchema: { amount: "number", currency: "string" },
      }),
    ],
    compiledConstraints: new Map([["getbalance", []]]),
    facts: {},
    now: NOW,
    denyThreshold: 3,
    execute: () => ({ amount: 42, currency: "USD", secretInternalField: "leak-me-not" }),
  });
  const result = shim.invoke("getbalance", {});
  assert.deepEqual(result, { outcome: "result", data: { amount: 42, currency: "USD" } });
});

test("read effects are rejected if the response violates the declared schema's types", () => {
  const store = leasedStore();
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [
      entry({
        effectId: "getbalance",
        kind: "read",
        responseSchema: { amount: "number", currency: "string" },
      }),
    ],
    compiledConstraints: new Map([["getbalance", []]]),
    facts: {},
    now: NOW,
    denyThreshold: 3,
    execute: () => ({ amount: "not-a-number", currency: "USD" }),
  });
  const result = shim.invoke("getbalance", {});
  assert.deepEqual(result, { outcome: "rejected", reason: "schema-violation" });
});

test("confirmed effects feed the local business ledger so a later sum() budget constraint sees them (S12.6)", () => {
  const store = leasedStore();
  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest: [
      entry({ effectId: "chargeA" }),
      entry({ effectId: "chargeB" }),
      entry({ effectId: "chargeC" }),
    ],
    compiledConstraints: new Map([
      ["chargeA", []],
      ["chargeB", []],
      ["chargeC", [compileConstraint("sum(ledger.*.amount) + params.amount <= facts.budget_total")]],
    ]),
    facts: { budget_total: 200 },
    now: NOW,
    denyThreshold: 3,
    execute: (_tool, params) => ({ amount: params["amount"] }),
  });
  assert.equal(shim.invoke("chargeA", { amount: 100 }).outcome, "result");
  assert.equal(shim.invoke("chargeB", { amount: 50 }).outcome, "result");
  // 100 + 50 + 40 = 190 <= 200 -> permit
  assert.equal(shim.invoke("chargeC", { amount: 40 }).outcome, "result");
});
