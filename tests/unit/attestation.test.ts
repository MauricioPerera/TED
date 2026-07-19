// Oraculo congelado para knowledge/contracts/ted-attestation.md. NO editar
// como parte de la implementacion -- ver touch_only del contrato.
import test from "node:test";
import assert from "node:assert/strict";
import { generateAttestationKeyPair, signAttestation } from "../../src/crypto/index.ts";
import {
  hashCorpusManifest,
  canonicalizeAttestationPayload,
  verifyAttestationSignature,
  isRevoked,
  isExpired,
  verifyPendingToLeased,
} from "../../src/attestation/index.ts";
import type { AttestationPayload, CorpusManifestEntry } from "../../src/types.ts";
import type { RevocationEntry } from "../../src/attestation/index.ts";

const CORPUS: CorpusManifestEntry[] = [
  { path: "a.md", sha256: "aa".repeat(32) },
  { path: "b.md", sha256: "bb".repeat(32) },
];

function basePayload(): AttestationPayload {
  return {
    ticketId: "20260719-abc123",
    instructionsSha256: "11".repeat(32),
    effectsSha256: "22".repeat(32),
    factsSha256: "33".repeat(32),
    corpusManifest: CORPUS,
    attestedAt: "2026-07-19T00:00:00.000Z",
    validUntil: "2026-08-19T00:00:00.000Z",
  };
}

function signPayload(payload: AttestationPayload, privateKeyHex: string): string {
  return signAttestation(canonicalizeAttestationPayload(payload), privateKeyHex);
}

test("hashCorpusManifest is deterministic for the same manifest", () => {
  const h1 = hashCorpusManifest(CORPUS);
  const h2 = hashCorpusManifest(CORPUS);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("hashCorpusManifest changes if any entry's hash changes", () => {
  const tampered: CorpusManifestEntry[] = [
    { path: "a.md", sha256: "aa".repeat(32) },
    { path: "b.md", sha256: "cc".repeat(32) },
  ];
  assert.notEqual(hashCorpusManifest(CORPUS), hashCorpusManifest(tampered));
});

test("verifyAttestationSignature accepts a genuine signature and rejects a tampered payload", () => {
  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  const payload = basePayload();
  const sig = signPayload(payload, privateKeyHex);
  assert.equal(verifyAttestationSignature(payload, sig, publicKeyHex), true);
  const tampered = { ...payload, instructionsSha256: "ff".repeat(32) };
  assert.equal(verifyAttestationSignature(tampered, sig, publicKeyHex), false);
});

test("isRevoked is true only for a genuinely signed revocation matching the ticketId", () => {
  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  const ticketId = "20260719-abc123";
  const revokedAt = "2026-07-20T00:00:00.000Z";
  const signatureHex = signAttestation(`${ticketId}:${revokedAt}:revoked`, privateKeyHex);
  const crl: RevocationEntry[] = [{ ticketId, revokedAt, signatureHex }];
  assert.equal(isRevoked(ticketId, crl, publicKeyHex), true);
  assert.equal(isRevoked("other-ticket", crl, publicKeyHex), false);
  const tamperedCrl: RevocationEntry[] = [{ ticketId, revokedAt, signatureHex: "00".repeat(64) }];
  assert.equal(isRevoked(ticketId, tamperedCrl, publicKeyHex), false);
});

test("isExpired compares now against valid_until, never the system clock", () => {
  const payload = basePayload();
  assert.equal(isExpired(payload, "2026-08-01T00:00:00.000Z"), false);
  assert.equal(isExpired(payload, "2026-09-01T00:00:00.000Z"), true);
  assert.equal(isExpired(payload, payload.validUntil), false, "exactly at valid_until is not expired");
});

test("verifyPendingToLeased proceeds when signature, content hashes, CRL and freshness all check out", () => {
  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  const payload = basePayload();
  const sig = signPayload(payload, privateKeyHex);
  const result = verifyPendingToLeased({
    attestation: payload,
    attestationSignatureHex: sig,
    creatorPublicKeyHex: publicKeyHex,
    actualInstructionsSha256: payload.instructionsSha256,
    actualEffectsSha256: payload.effectsSha256,
    actualFactsSha256: payload.factsSha256,
    actualCorpusManifest: CORPUS,
    crl: [],
    now: "2026-07-19T12:00:00.000Z",
  });
  assert.deepEqual(result, { verdict: "proceed" });
});

test("verifyPendingToLeased reports integrity-violated on an invalid signature (checked first)", () => {
  const { publicKeyHex } = generateAttestationKeyPair();
  const { privateKeyHex: wrongKey } = generateAttestationKeyPair();
  const payload = basePayload();
  const badSig = signAttestation(canonicalizeAttestationPayload(payload), wrongKey);
  const result = verifyPendingToLeased({
    attestation: payload,
    attestationSignatureHex: badSig,
    creatorPublicKeyHex: publicKeyHex,
    actualInstructionsSha256: payload.instructionsSha256,
    actualEffectsSha256: payload.effectsSha256,
    actualFactsSha256: payload.factsSha256,
    actualCorpusManifest: CORPUS,
    crl: [],
    now: "2026-07-19T12:00:00.000Z",
  });
  assert.deepEqual(result, { verdict: "integrity-violated" });
});

test("verifyPendingToLeased reports integrity-violated when content on disk no longer matches the attestation (S5 point 2)", () => {
  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  const payload = basePayload();
  const sig = signPayload(payload, privateKeyHex);
  const result = verifyPendingToLeased({
    attestation: payload,
    attestationSignatureHex: sig,
    creatorPublicKeyHex: publicKeyHex,
    actualInstructionsSha256: "ff".repeat(32),
    actualEffectsSha256: payload.effectsSha256,
    actualFactsSha256: payload.factsSha256,
    actualCorpusManifest: CORPUS,
    crl: [],
    now: "2026-07-19T12:00:00.000Z",
  });
  assert.deepEqual(result, { verdict: "integrity-violated" });
});

test("verifyPendingToLeased reports revoked when the ticket is on the CRL, even if not expired", () => {
  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  const payload = basePayload();
  const sig = signPayload(payload, privateKeyHex);
  const revokedAt = "2026-07-19T06:00:00.000Z";
  const revSig = signAttestation(`${payload.ticketId}:${revokedAt}:revoked`, privateKeyHex);
  const result = verifyPendingToLeased({
    attestation: payload,
    attestationSignatureHex: sig,
    creatorPublicKeyHex: publicKeyHex,
    actualInstructionsSha256: payload.instructionsSha256,
    actualEffectsSha256: payload.effectsSha256,
    actualFactsSha256: payload.factsSha256,
    actualCorpusManifest: CORPUS,
    crl: [{ ticketId: payload.ticketId, revokedAt, signatureHex: revSig }],
    now: "2026-07-19T12:00:00.000Z",
  });
  assert.deepEqual(result, { verdict: "revoked" });
});

test("verifyPendingToLeased reports expired when validity window has passed and there is no revocation", () => {
  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  const payload = basePayload();
  const sig = signPayload(payload, privateKeyHex);
  const result = verifyPendingToLeased({
    attestation: payload,
    attestationSignatureHex: sig,
    creatorPublicKeyHex: publicKeyHex,
    actualInstructionsSha256: payload.instructionsSha256,
    actualEffectsSha256: payload.effectsSha256,
    actualFactsSha256: payload.factsSha256,
    actualCorpusManifest: CORPUS,
    crl: [],
    now: "2026-09-01T00:00:00.000Z",
  });
  assert.deepEqual(result, { verdict: "expired" });
});

test("verifyPendingToLeased checks the CRL before freshness: revoked wins when both are true (S6.3 step order)", () => {
  const { publicKeyHex, privateKeyHex } = generateAttestationKeyPair();
  const payload = basePayload();
  const sig = signPayload(payload, privateKeyHex);
  const revokedAt = "2026-08-25T00:00:00.000Z";
  const revSig = signAttestation(`${payload.ticketId}:${revokedAt}:revoked`, privateKeyHex);
  const result = verifyPendingToLeased({
    attestation: payload,
    attestationSignatureHex: sig,
    creatorPublicKeyHex: publicKeyHex,
    actualInstructionsSha256: payload.instructionsSha256,
    actualEffectsSha256: payload.effectsSha256,
    actualFactsSha256: payload.factsSha256,
    actualCorpusManifest: CORPUS,
    crl: [{ ticketId: payload.ticketId, revokedAt, signatureHex: revSig }],
    now: "2026-09-01T00:00:00.000Z", // also past validUntil
  });
  assert.deepEqual(result, { verdict: "revoked" });
});
