// Cadena de verificacion de atestacion + CRL (paso 3 de pending -> leased).
// Contrato: knowledge/contracts/ted-attestation.md. Funciones puras: sin
// estado, sin I/O de disco, sin reloj del sistema (todo tiempo es parametro).
import type { AttestationPayload, CorpusManifestEntry } from "../types.ts";
import { sha256Hex, verifyAttestation } from "../crypto/index.ts";

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

// SHA-256 de la lista ordenada `path:sha256` unida por `\n`. El caller ya
// entrega el manifiesto ordenado (p.ej. desde src/bundle).
export function hashCorpusManifest(manifest: CorpusManifestEntry[]): string {
  const serialized = manifest.map((e) => `${e.path}:${e.sha256}`).join("\n");
  return sha256Hex(serialized);
}

// Determinista: mismo payload -> mismo string, SIEMPRE. La tupla firmada
// incluye el hash del manifiesto de corpus (S5 punto 3: firmar todos los
// hashes juntos impide el ataque de mezcla).
export function canonicalizeAttestationPayload(payload: AttestationPayload): string {
  const corpusHash = hashCorpusManifest(payload.corpusManifest);
  return [
    payload.ticketId,
    payload.instructionsSha256,
    payload.effectsSha256,
    payload.factsSha256,
    corpusHash,
    payload.attestedAt,
    payload.validUntil,
  ].join("|");
}

export function verifyAttestationSignature(
  payload: AttestationPayload,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  return verifyAttestation(
    canonicalizeAttestationPayload(payload),
    signatureHex,
    publicKeyHex,
  );
}

// True solo si hay una entrada en el CRL cuyo ticketId coincide Y cuya firma
// (sobre `${ticketId}:${revokedAt}:revoked`) verifica contra la clave publica
// del creador (Ed25519). Firma invalida/tampered -> false.
export function isRevoked(
  ticketId: string,
  crl: RevocationEntry[],
  creatorPublicKeyHex: string,
): boolean {
  for (const entry of crl) {
    if (entry.ticketId !== ticketId) continue;
    const signed = `${entry.ticketId}:${entry.revokedAt}:revoked`;
    if (verifyAttestation(signed, entry.signatureHex, creatorPublicKeyHex)) {
      return true;
    }
  }
  return false;
}

// now === validUntil NO cuenta como expirado (estrictamente posterior).
export function isExpired(payload: AttestationPayload, now: string): boolean {
  return Date.parse(now) > Date.parse(payload.validUntil);
}

// Evalua en el orden exacto del contrato y corta en el primer fallo
// (short-circuit): firma -> hashes de contenido (+ manifiesto) -> CRL ->
// vigencia. revoked gana sobre expired (CRL antes que vigencia).
export function verifyPendingToLeased(params: {
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
  // 1. firma de atestacion valida.
  if (
    !verifyAttestationSignature(
      params.attestation,
      params.attestationSignatureHex,
      params.creatorPublicKeyHex,
    )
  ) {
    return { verdict: "integrity-violated" };
  }

  // 2. los 3 hashes de contenido actuales + el hash del manifiesto de corpus
  // actual coinciden con los firmados.
  const a = params.attestation;
  if (
    params.actualInstructionsSha256 !== a.instructionsSha256 ||
    params.actualEffectsSha256 !== a.effectsSha256 ||
    params.actualFactsSha256 !== a.factsSha256 ||
    hashCorpusManifest(params.actualCorpusManifest) !== hashCorpusManifest(a.corpusManifest)
  ) {
    return { verdict: "integrity-violated" };
  }

  // 3. el ticket no esta en el CRL con una revocacion firmada valida.
  if (isRevoked(a.ticketId, params.crl, params.creatorPublicKeyHex)) {
    return { verdict: "revoked" };
  }

  // 4. now no supero validUntil.
  if (isExpired(a, params.now)) {
    return { verdict: "expired" };
  }

  return { verdict: "proceed" };
}