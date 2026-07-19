// Oraculo congelado para knowledge/contracts/ted-escalation.md. NO editar
// como parte de la implementacion -- ver touch_only del contrato.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyEvent, DenyTracker } from "../../src/escalation/index.ts";

test("a constraint verdict of error is a hard trigger (S12.3 / S13.1)", () => {
  const d = classifyEvent({ kind: "constraint_verdict", verdict: "error" });
  assert.equal(d.escalate, true);
  assert.equal(d.trigger, "constraint-error");
});

test("a constraint verdict of deny or permit is NOT a hard trigger by itself", () => {
  assert.equal(classifyEvent({ kind: "constraint_verdict", verdict: "deny" }).escalate, false);
  assert.equal(classifyEvent({ kind: "constraint_verdict", verdict: "permit" }).escalate, false);
});

test("invoking an unknown tool is a hard trigger (S11.2 step 1: steering signal)", () => {
  const d = classifyEvent({ kind: "unknown_tool" });
  assert.equal(d.escalate, true);
  assert.equal(d.trigger, "unknown-tool-invoked");
});

test("reaching max_invocations is a hard trigger (S11.2 step 2)", () => {
  const d = classifyEvent({ kind: "max_invocations_reached" });
  assert.equal(d.escalate, true);
  assert.equal(d.trigger, "max-invocations-reached");
});

test("an ambiguous effect with no reconciliation path is a hard trigger (S11.3 option 3)", () => {
  const d = classifyEvent({ kind: "ambiguous_effect", reconciliationPossible: false });
  assert.equal(d.escalate, true);
  assert.equal(d.trigger, "ambiguous-effect");
});

test("an ambiguous effect that CAN be reconciled is not a trigger (S11.3 options 1/2)", () => {
  const d = classifyEvent({ kind: "ambiguous_effect", reconciliationPossible: true });
  assert.equal(d.escalate, false);
});

test("lease attempts one below max_attempts signal imminent retry exhaustion (S13.1)", () => {
  const d = classifyEvent({ kind: "lease_attempts", attempts: 2, maxAttempts: 3 });
  assert.equal(d.escalate, true);
  assert.equal(d.trigger, "retry-exhaustion-imminent");
});

test("lease attempts well below max_attempts do not trigger", () => {
  const d = classifyEvent({ kind: "lease_attempts", attempts: 1, maxAttempts: 10 });
  assert.equal(d.escalate, false);
});

test("DenyTracker escalates once a single effect is denied consecutively past the threshold", () => {
  const tracker = new DenyTracker();
  assert.equal(tracker.recordDeny("charge"), 1);
  assert.equal(tracker.recordDeny("charge"), 2);
  assert.equal(tracker.shouldEscalate("charge", 3), false);
  assert.equal(tracker.recordDeny("charge"), 3);
  assert.equal(tracker.shouldEscalate("charge", 3), true);
});

test("DenyTracker resets an effect's counter on a non-deny outcome", () => {
  const tracker = new DenyTracker();
  tracker.recordDeny("charge");
  tracker.recordDeny("charge");
  tracker.recordNonDeny("charge");
  assert.equal(tracker.shouldEscalate("charge", 2), false);
  assert.equal(tracker.recordDeny("charge"), 1);
});

test("DenyTracker keeps independent counters per effectId", () => {
  const tracker = new DenyTracker();
  tracker.recordDeny("charge");
  tracker.recordDeny("charge");
  assert.equal(tracker.recordDeny("refund"), 1);
  assert.equal(tracker.shouldEscalate("charge", 2), true);
  assert.equal(tracker.shouldEscalate("refund", 2), false);
});
