// STUB -- implementado por el dev delegado bajo knowledge/contracts/ted-orchestrator.md
import type {
  TicketFrontmatter,
  EffectManifestEntry,
  CorpusManifestEntry,
} from "../types.ts";
import type { TicketStore } from "../store/index.ts";
import type { RevocationEntry } from "../attestation/index.ts";
import type { EffectsShim } from "../shim/index.ts";

export interface SignedCallback {
  ticketId: string;
  payload: string;
  timestamp: string;
  signatureHex: string;
}

export interface BundleData {
  frontmatter: TicketFrontmatter;
  attestationSignatureHex: string;
  effects: EffectManifestEntry[];
  facts: Record<string, unknown>;
  corpusManifest: CorpusManifestEntry[];
  instructionsSha256: string;
  effectsSha256: string;
  factsSha256: string;
}

export interface AgentOutcome {
  finished: "fulfilled" | "escalated" | "failed";
  reason?: string;
}

export type Agent = (shim: EffectsShim) => AgentOutcome;

export type CallbackOutcome =
  | { outcome: "invalid-transport" }
  | { outcome: "duplicate" }
  | { outcome: "integrity-violated" }
  | { outcome: "revoked" }
  | { outcome: "expired" }
  | { outcome: "fulfilled" }
  | { outcome: "escalated"; trigger?: string }
  | { outcome: "failed"; cause?: string };

export interface OrchestratorDeps {
  store: TicketStore;
  transportSecretHex: string;
  toleranceMs: number;
  leaseTtlMs: number;
  denyThreshold: number;
  execute: (tool: string, params: Record<string, unknown>) => Record<string, unknown>;
  readBundle: (ticketId: string) => BundleData;
  creatorPublicKeyHex: string;
  crl: RevocationEntry[];
  agent: Agent;
}

export function handleCallback(
  _deps: OrchestratorDeps,
  _callback: SignedCallback,
  _now: string,
): CallbackOutcome {
  throw new Error("not implemented");
}
