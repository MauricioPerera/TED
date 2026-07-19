// Oraculo congelado para knowledge/contracts/ted-crypto.md. NO editar como
// parte de la implementacion -- ver touch_only del contrato.
import test from "node:test";
import assert from "node:assert/strict";
import {
  signTransport,
  verifyTransport,
  sha256Hex,
  generateAttestationKeyPair,
  signAttestation,
  verifyAttestation,
} from "../../src/crypto/index.ts";

test("sha256Hex matches known vectors", () => {
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("transport signature round-trips with matching secret/timestamp inside tolerance", () => {
  const secret = "aa".repeat(32);
  const timestamp = "2026-07-19T00:00:00.000Z";
  const sig = signTransport("payload", secret, timestamp);
  assert.equal(typeof sig, "string");
  assert.match(sig, /^[0-9a-f]{64}$/);
  const now = "2026-07-19T00:00:05.000Z";
  assert.equal(verifyTransport("payload", secret, timestamp, sig, now, 60000), true);
});

test("transport signature rejects wrong secret", () => {
  const secret = "bb".repeat(32);
  const other = "cc".repeat(32);
  const timestamp = "2026-07-19T00:00:00.000Z";
  const sig = signTransport("payload", secret, timestamp);
  assert.equal(
    verifyTransport("payload", other, timestamp, sig, timestamp, 60000),
    false,
  );
});

test("transport signature rejects tampered payload", () => {
  const secret = "dd".repeat(32);
  const timestamp = "2026-07-19T00:00:00.000Z";
  const sig = signTransport("payload", secret, timestamp);
  assert.equal(
    verifyTransport("payload-tampered", secret, timestamp, sig, timestamp, 60000),
    false,
  );
});

test("transport signature rejects timestamps outside the tolerance window (anti-replay, S5)", () => {
  const secret = "ee".repeat(32);
  const timestamp = "2026-07-19T00:00:00.000Z";
  const sig = signTransport("payload", secret, timestamp);
  const tooLate = "2026-07-19T00:05:01.000Z";
  assert.equal(
    verifyTransport("payload", secret, timestamp, sig, tooLate, 300000),
    false,
  );
});

test("transport signature accepts a timestamp exactly at the tolerance boundary", () => {
  const secret = "ff".repeat(32);
  const timestamp = "2026-07-19T00:00:00.000Z";
  const sig = signTransport("payload", secret, timestamp);
  const atBoundary = "2026-07-19T00:05:00.000Z";
  assert.equal(
    verifyTransport("payload", secret, timestamp, sig, atBoundary, 300000),
    true,
  );
});

test("Ed25519 attestation round-trips", () => {
  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  assert.equal(typeof publicKeyHex, "string");
  assert.equal(typeof privateKeyHex, "string");
  const payload = JSON.stringify({ ticketId: "abc123", validUntil: "2026-08-01T00:00:00Z" });
  const sig = signAttestation(payload, privateKeyHex);
  assert.equal(verifyAttestation(payload, sig, publicKeyHex), true);
});

test("Ed25519 attestation rejects a tampered payload (mix-attack surface, S5 point 3)", () => {
  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  const payload = JSON.stringify({ ticketId: "abc123" });
  const sig = signAttestation(payload, privateKeyHex);
  const tampered = JSON.stringify({ ticketId: "xyz999" });
  assert.equal(verifyAttestation(tampered, sig, publicKeyHex), false);
});

test("Ed25519 attestation rejects verification against the wrong public key", () => {
  const pairA = generateAttestationKeyPair();
  const pairB = generateAttestationKeyPair();
  const payload = "same-payload";
  const sig = signAttestation(payload, pairA.privateKeyHex);
  assert.equal(verifyAttestation(payload, sig, pairB.publicKeyHex), false);
});

test("generateAttestationKeyPair produces a distinct key pair on each call", () => {
  const a = generateAttestationKeyPair();
  const b = generateAttestationKeyPair();
  assert.notEqual(a.privateKeyHex, b.privateKeyHex);
  assert.notEqual(a.publicKeyHex, b.publicKeyHex);
});
