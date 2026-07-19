// Primitivas de firma de TED (transporte, contenido, atestacion).
// Contrato: knowledge/contracts/ted-crypto.md. Funciones puras: sin estado,
// sin I/O, sin reloj del sistema (todo tiempo es parametro explicito).
import {
  createHmac,
  createHash,
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  sign as edSign,
  verify as edVerify,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";

// HMAC-SHA256 sobre `${timestamp}.${payload}` con clave en hex.
function transportMac(payload: string, secretHex: string, timestamp: string): Buffer {
  const key: BinaryLike = Buffer.from(secretHex, "hex");
  return createHmac("sha256", key).update(`${timestamp}.${payload}`).digest();
}

// Epoch ms a partir de un timestamp ISO. No lee el reloj del sistema.
function epochMs(iso: string): number {
  return Date.parse(iso);
}

export function signTransport(
  payload: string,
  secretHex: string,
  timestamp: string,
): string {
  return transportMac(payload, secretHex, timestamp).toString("hex");
}

export function verifyTransport(
  payload: string,
  secretHex: string,
  timestamp: string,
  signatureHex: string,
  now: string,
  toleranceMs: number,
): boolean {
  try {
    const ts = epochMs(timestamp);
    const nowMs = epochMs(now);
    if (Number.isNaN(ts) || Number.isNaN(nowMs)) return false;
    // Ventana anti-replay [timestamp, timestamp + toleranceMs].
    if (nowMs < ts || nowMs - ts > toleranceMs) return false;
    const expected = transportMac(payload, secretHex, timestamp);
    const got = Buffer.from(signatureHex, "hex");
    if (got.length !== expected.length) return false;
    return timingSafeEqual(expected, got);
  } catch {
    return false;
  }
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function generateAttestationKeyPair(): {
  publicKeyHex: string;
  privateKeyHex: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey
    .export({ type: "spki", format: "der" })
    .toString("hex");
  const privateKeyHex = privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("hex");
  return { publicKeyHex, privateKeyHex };
}

export function signAttestation(
  canonicalPayload: string,
  privateKeyHex: string,
): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyHex, "hex"),
    format: "der",
    type: "pkcs8",
  });
  return edSign(null, Buffer.from(canonicalPayload, "utf8"), privateKey).toString(
    "hex",
  );
}

export function verifyAttestation(
  canonicalPayload: string,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyHex, "hex"),
      format: "der",
      type: "spki",
    });
    const signature = Buffer.from(signatureHex, "hex");
    return edVerify(
      null,
      Buffer.from(canonicalPayload, "utf8"),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}