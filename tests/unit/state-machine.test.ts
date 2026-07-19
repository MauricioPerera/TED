// Oraculo congelado para knowledge/contracts/ted-state-machine.md. NO editar
// como parte de la implementacion -- ver touch_only del contrato.
import test from "node:test";
import assert from "node:assert/strict";
import { TRANSITIONS, isLegalTransition, legalTargets } from "../../src/state-machine/index.ts";

test("the graph has exactly nine transitions (S6: siete estados, nueve transiciones)", () => {
  assert.equal(TRANSITIONS.length, 9);
});

test("pending -> leased requires the fulfillment_system credential (S6.2/S6.3)", () => {
  assert.equal(isLegalTransition("pending", "leased", "fulfillment_system"), true);
  assert.equal(isLegalTransition("pending", "leased", "orchestrator"), false);
  assert.equal(isLegalTransition("pending", "leased", "creator"), false);
  assert.equal(isLegalTransition("pending", "leased", "clock"), false);
});

test("leased -> fulfilled/failed/escalated require the orchestrator credential (fencing token)", () => {
  assert.equal(isLegalTransition("leased", "fulfilled", "orchestrator"), true);
  assert.equal(isLegalTransition("leased", "failed", "orchestrator"), true);
  assert.equal(isLegalTransition("leased", "escalated", "orchestrator"), true);
  assert.equal(isLegalTransition("leased", "fulfilled", "creator"), false);
});

test("leased -> pending (reclaim) and pending -> expired require the clock (no credential, S6.2 point 4)", () => {
  assert.equal(isLegalTransition("leased", "pending", "clock"), true);
  assert.equal(isLegalTransition("leased", "pending", "orchestrator"), false);
  assert.equal(isLegalTransition("pending", "expired", "clock"), true);
  assert.equal(isLegalTransition("pending", "expired", "creator"), false);
});

test("escalated -> pending/cancelled and pending -> cancelled require the creator credential (S6.3)", () => {
  assert.equal(isLegalTransition("escalated", "pending", "creator"), true);
  assert.equal(isLegalTransition("escalated", "pending", "orchestrator"), false);
  assert.equal(isLegalTransition("escalated", "cancelled", "creator"), true);
  assert.equal(isLegalTransition("pending", "cancelled", "creator"), true);
  assert.equal(isLegalTransition("pending", "cancelled", "fulfillment_system"), false);
});

test("any transition out of a terminal state is illegal for every actor (S6.4 invariant 1)", () => {
  const actors: Array<"creator" | "fulfillment_system" | "orchestrator" | "clock"> = [
    "creator",
    "fulfillment_system",
    "orchestrator",
    "clock",
  ];
  for (const actor of actors) {
    assert.equal(isLegalTransition("fulfilled", "pending", actor), false);
    assert.equal(isLegalTransition("failed", "pending", actor), false);
    assert.equal(isLegalTransition("expired", "pending", actor), false);
    assert.equal(isLegalTransition("cancelled", "pending", actor), false);
  }
});

test("a transition between two states with no edge in the graph is illegal regardless of actor", () => {
  assert.equal(isLegalTransition("pending", "fulfilled", "orchestrator"), false);
  assert.equal(isLegalTransition("pending", "escalated", "orchestrator"), false);
});

test("legalTargets returns every state reachable by that actor from that state", () => {
  assert.deepEqual([...legalTargets("pending", "creator")].sort(), ["cancelled"]);
  assert.deepEqual([...legalTargets("pending", "clock")].sort(), ["expired"]);
  assert.deepEqual([...legalTargets("pending", "fulfillment_system")].sort(), ["leased"]);
  assert.deepEqual([...legalTargets("leased", "orchestrator")].sort(), ["escalated", "failed", "fulfilled"]);
});

test("legalTargets from a terminal state is always empty, for every actor", () => {
  assert.deepEqual(legalTargets("fulfilled", "orchestrator"), []);
  assert.deepEqual(legalTargets("cancelled", "creator"), []);
});
