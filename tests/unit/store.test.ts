// Oraculo congelado para knowledge/contracts/ted-store.md. NO editar como
// parte de la implementacion -- ver touch_only del contrato.
import test from "node:test";
import assert from "node:assert/strict";
import { TicketStore } from "../../src/store/index.ts";

function freshStore(): TicketStore {
  return new TicketStore(":memory:");
}

test("createPending then getRecord round-trips the initial shape", () => {
  const store = freshStore();
  const created = store.createPending("t1", 3);
  assert.equal(created.ticketId, "t1");
  assert.equal(created.state, "pending");
  assert.equal(created.fencingToken, 0);
  assert.equal(created.leaseExpiresAt, null);
  assert.equal(created.attempts, 0);
  assert.equal(created.maxAttempts, 3);
  const fetched = store.getRecord("t1");
  assert.deepEqual(fetched, created);
  store.close();
});

test("createPending twice with the same ticketId throws", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  assert.throws(() => store.createPending("t1", 3));
  store.close();
});

test("getRecord returns undefined for an unknown ticket", () => {
  const store = freshStore();
  assert.equal(store.getRecord("nope"), undefined);
  store.close();
});

test("acquireLease from pending succeeds and bumps the fencing token", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  const leased = store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  assert.ok(leased);
  assert.equal(leased?.state, "leased");
  assert.equal(leased?.fencingToken, 1);
  assert.equal(leased?.leaseExpiresAt, "2026-07-19T00:01:00.000Z");
  store.close();
});

test("acquireLease on an already-leased ticket is absorbed as a no-op (duplicate callback, S6.3)", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  const second = store.acquireLease("t1", 60000, "2026-07-19T00:00:01.000Z");
  assert.equal(second, null);
  assert.equal(store.getRecord("t1")?.fencingToken, 1);
  store.close();
});

test("transition with the current fencing token moves leased to fulfilled", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  const result = store.transition("t1", 1, ["leased"], "fulfilled");
  assert.equal(result?.state, "fulfilled");
  store.close();
});

test("transition with a stale fencing token is rejected (zombie containment, S6.4 invariant 4)", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  const result = store.transition("t1", 0, ["leased"], "fulfilled");
  assert.equal(result, null);
  assert.equal(store.getRecord("t1")?.state, "leased");
  store.close();
});

test("transition out of a terminal state always fails (S6.4 invariant 1)", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  store.transition("t1", 1, ["leased"], "fulfilled");
  const attempt = store.transition("t1", 1, ["fulfilled"], "pending");
  assert.equal(attempt, null);
  assert.equal(store.getRecord("t1")?.state, "fulfilled");
  store.close();
});

test("reclaimExpiredLease is a no-op before the lease actually expires", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  const result = store.reclaimExpiredLease("t1", "2026-07-19T00:00:30.000Z");
  assert.equal(result, null);
  store.close();
});

test("reclaimExpiredLease moves an expired lease back to pending and increments attempts (S6.3 leased->pending)", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  const result = store.reclaimExpiredLease("t1", "2026-07-19T00:01:01.000Z");
  assert.equal(result?.state, "pending");
  assert.equal(result?.attempts, 1);
  assert.equal(result?.fencingToken, 1, "fencing token only grows on the NEXT acquireLease, not on reclaim");
  store.close();
});

test("exhausting max_attempts forces failed with retry-exhausted (S6.4 invariant 2)", () => {
  const store = freshStore();
  store.createPending("t1", 1);
  store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  const result = store.reclaimExpiredLease("t1", "2026-07-19T00:01:01.000Z");
  assert.equal(result?.state, "failed");
  assert.equal(result?.failureCause, "retry-exhausted");
  store.close();
});

test("acquireLease after a reclaim bumps the fencing token to the next value", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  store.reclaimExpiredLease("t1", "2026-07-19T00:01:01.000Z");
  const relaunched = store.acquireLease("t1", 60000, "2026-07-19T00:02:00.000Z");
  assert.equal(relaunched?.fencingToken, 2);
  store.close();
});

test("ledgerMarkAttempted rejects a stale fencing token (S11.2 step 4)", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  const result = store.ledgerMarkAttempted("t1", "charge", 0, "hash1", "2026-07-19T00:00:01.000Z");
  assert.equal(result, null);
  store.close();
});

test("ledger declared/attempted/confirmed round-trips with a matching fencing token", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  const attempted = store.ledgerMarkAttempted("t1", "charge", 1, "hash1", "2026-07-19T00:00:01.000Z");
  assert.equal(attempted?.state, "attempted");
  const confirmed = store.ledgerMarkConfirmed("t1", "charge", "resulthash1", "2026-07-19T00:00:02.000Z");
  assert.equal(confirmed?.state, "confirmed");
  assert.equal(confirmed?.resultHash, "resulthash1");
  assert.equal(store.ledgerGet("t1", "charge")?.state, "confirmed");
  store.close();
});

test("ledgerMarkAttempted on an already-confirmed entry is idempotent (S11.2 step 2)", () => {
  const store = freshStore();
  store.createPending("t1", 3);
  store.acquireLease("t1", 60000, "2026-07-19T00:00:00.000Z");
  store.ledgerMarkAttempted("t1", "charge", 1, "hash1", "2026-07-19T00:00:01.000Z");
  store.ledgerMarkConfirmed("t1", "charge", "resulthash1", "2026-07-19T00:00:02.000Z");
  const replay = store.ledgerMarkAttempted("t1", "charge", 1, "hash-different", "2026-07-19T00:05:00.000Z");
  assert.equal(replay?.state, "confirmed");
  assert.equal(replay?.resultHash, "resulthash1");
  store.close();
});
