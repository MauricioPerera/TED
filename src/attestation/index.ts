// STUB -- implementado por el dev delegado bajo knowledge/contracts/ted-attestation.md
import type { AttestationPayload, CorpusManifestEntry } from "../types.ts";

export interface RevocationEntry {
  ticketId: string;
  revokedAt: string;
  signatureHex: string;
}

export type VerificationOutcome =
  | { verdict: "proceed" }
  | { verdict: "integrity-violated" }
  | { verdict: "revoked" }
  | { verdict: "expired" };

export function hashCorpusManifest(_manifest: CorpusManifestEntry[]): string {
  throw new Error("not implemented");
}

export function canonicalizeAttestationPayload(_payload: AttestationPayload): string {
  throw new Error("not implemented");
}

export function verifyAttestationSignature(
  _payload: AttestationPayload,
  _signatureHex: string,
  _publicKeyHex: string,
): boolean {
  throw new Error("not implemented");
}

export function isRevoked(
  _ticketId: string,
  _crl: RevocationEntry[],
  _creatorPublicKeyHex: string,
): boolean {
  throw new Error("not implemented");
}

export function isExpired(_payload: AttestationPayload, _now: string): boolean {
  throw new Error("not implemented");
}

export function verifyPendingToLeased(_params: {
  attestation: AttestationPayload;
  attestationSignatureHex: string;
  creatorPublicKeyHex: string;
  actualInstructionsSha256: string;
  actualEffectsSha256: string;
  actualFactsSha256: string;
  actualCorpusManifest: CorpusManifestEntry[];
  crl: RevocationEntry[];
  now: string;
}): VerificationOutcome {
  throw new Error("not implemented");
}
