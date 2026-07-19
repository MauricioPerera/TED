// Oraculo congelado para knowledge/contracts/ted-constraints.md. NO editar
// como parte de la implementacion -- ver touch_only del contrato.
import test from "node:test";
import assert from "node:assert/strict";
import {
  compileConstraint,
  evaluateConstraint,
  evaluateAll,
  ConstraintCompileError,
} from "../../src/constraints/index.ts";
import type { ConstraintLedgerSnapshot } from "../../src/types.ts";

const NOW = "2026-07-19T00:00:00.000Z";
const EMPTY_LEDGER: ConstraintLedgerSnapshot = {};

test("compileConstraint accepts expressions referencing only params/facts/ledger/now", () => {
  const compiled = compileConstraint('params.amount == facts.limit');
  assert.equal(compiled.source, 'params.amount == facts.limit');
});

test("compileConstraint rejects an identifier outside the closed environment (S12.2 — not deny, does not compile)", () => {
  assert.throws(
    () => compileConstraint("context.foo == 1"),
    ConstraintCompileError,
  );
});

test("evaluateConstraint permits a cleanly-true comparison", () => {
  const c = compileConstraint("params.amount == facts.limit");
  const result = evaluateConstraint(c, { amount: 100 }, { limit: 100 }, EMPTY_LEDGER, NOW);
  assert.equal(result.verdict, "permit");
});

test("evaluateConstraint denies a cleanly-false comparison (the system working, S12.3)", () => {
  const c = compileConstraint("params.amount == facts.limit");
  const result = evaluateConstraint(c, { amount: 100 }, { limit: 50 }, EMPTY_LEDGER, NOW);
  assert.equal(result.verdict, "deny");
});

test("evaluateConstraint errors (not denies) when a referenced fact is absent (S12.3)", () => {
  const c = compileConstraint("params.amount == facts.limit");
  const result = evaluateConstraint(c, { amount: 100 }, {}, EMPTY_LEDGER, NOW);
  assert.equal(result.verdict, "error");
});

test("evaluateConstraint errors on a type mismatch across an ordering operator (S12.3)", () => {
  const c = compileConstraint("params.amount <= facts.limit");
  const result = evaluateConstraint(c, { amount: 100 }, { limit: "not-a-number" }, EMPTY_LEDGER, NOW);
  assert.equal(result.verdict, "error");
});

test("evaluateConstraint reads `now` as an explicit input, never the system clock (S12.4)", () => {
  const c = compileConstraint("now <= facts.valid_until");
  const stillValid = evaluateConstraint(c, {}, { valid_until: "2026-08-01T00:00:00.000Z" }, EMPTY_LEDGER, NOW);
  assert.equal(stillValid.verdict, "permit");
  const expired = evaluateConstraint(c, {}, { valid_until: "2026-01-01T00:00:00.000Z" }, EMPTY_LEDGER, NOW);
  assert.equal(expired.verdict, "deny");
});

test("evaluateConstraint supports a ledger path predicate (S12.6 ordering example)", () => {
  const c = compileConstraint('ledger.charge.state == "confirmed"');
  const ledger: ConstraintLedgerSnapshot = { charge: { state: "confirmed" } };
  assert.equal(evaluateConstraint(c, {}, {}, ledger, NOW).verdict, "permit");
  const ledgerPending: ConstraintLedgerSnapshot = { charge: { state: "attempted" } };
  assert.equal(evaluateConstraint(c, {}, {}, ledgerPending, NOW).verdict, "deny");
});

test("evaluateConstraint supports sum() aggregation over a ledger wildcard (S12.6 budget example)", () => {
  const c = compileConstraint("sum(ledger.*.amount) + params.amount <= facts.budget_total");
  const ledger: ConstraintLedgerSnapshot = {
    charge1: { amount: 100 },
    charge2: { amount: 50 },
  };
  const withinBudget = evaluateConstraint(c, { amount: 30 }, { budget_total: 200 }, ledger, NOW);
  assert.equal(withinBudget.verdict, "permit");
  const overBudget = evaluateConstraint(c, { amount: 30 }, { budget_total: 150 }, ledger, NOW);
  assert.equal(overBudget.verdict, "deny");
});

test("evaluateAll permits only when every constraint permits (S12.5 conjunctive composition)", () => {
  const constraints = [
    compileConstraint("params.amount == facts.limit"),
    compileConstraint('ledger.charge.state == "confirmed"'),
  ];
  const ledger: ConstraintLedgerSnapshot = { charge: { state: "confirmed" } };
  const result = evaluateAll(constraints, { amount: 100 }, { limit: 100 }, ledger, NOW);
  assert.equal(result.verdict, "permit");
});

test("evaluateAll denies the whole set if any single constraint denies", () => {
  const constraints = [
    compileConstraint("params.amount == facts.limit"),
    compileConstraint('ledger.charge.state == "confirmed"'),
  ];
  const ledger: ConstraintLedgerSnapshot = { charge: { state: "attempted" } };
  const result = evaluateAll(constraints, { amount: 100 }, { limit: 100 }, ledger, NOW);
  assert.equal(result.verdict, "deny");
});

test("evaluateAll surfaces error over deny when any constraint cannot be evaluated (malformed contract takes priority)", () => {
  const constraints = [
    compileConstraint("params.amount == facts.limit"), // would deny: 100 != 999
    compileConstraint("facts.missing_fact == 1"), // errors: absent fact
  ];
  const result = evaluateAll(constraints, { amount: 100 }, { limit: 999 }, EMPTY_LEDGER, NOW);
  assert.equal(result.verdict, "error");
});

test("the audit trail is reproducible: identical inputs yield identical hashes (S12.7)", () => {
  const c = compileConstraint("params.amount == facts.limit");
  const a = evaluateConstraint(c, { amount: 100 }, { limit: 100 }, EMPTY_LEDGER, NOW);
  const b = evaluateConstraint(c, { amount: 100 }, { limit: 100 }, EMPTY_LEDGER, NOW);
  assert.deepEqual(a.auditTrail, b.auditTrail);
  assert.equal(a.auditTrail.now, NOW);
});
