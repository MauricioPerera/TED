// STUB -- implementado por el dev delegado bajo knowledge/contracts/ted-crypto.md
// No implementar aca: este archivo existe solo para que el contrato pueda
// referenciar un target real antes de delegar.

export function signTransport(
  _payload: string,
  _secretHex: string,
  _timestamp: string,
): string {
  throw new Error("not implemented");
}

export function verifyTransport(
  _payload: string,
  _secretHex: string,
  _timestamp: string,
  _signatureHex: string,
  _now: string,
  _toleranceMs: number,
): boolean {
  throw new Error("not implemented");
}

export function sha256Hex(_content: string): string {
  throw new Error("not implemented");
}

export function generateAttestationKeyPair(): {
  publicKeyHex: string;
  privateKeyHex: string;
} {
  throw new Error("not implemented");
}

export function signAttestation(
  _canonicalPayload: string,
  _privateKeyHex: string,
): string {
  throw new Error("not implemented");
}

export function verifyAttestation(
  _canonicalPayload: string,
  _signatureHex: string,
  _publicKeyHex: string,
): boolean {
  throw new Error("not implemented");
}
