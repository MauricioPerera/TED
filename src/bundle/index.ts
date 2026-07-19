// STUB -- implementado por el dev delegado bajo knowledge/contracts/ted-bundle.md
import type {
  TicketFrontmatter,
  EffectManifestEntry,
  CorpusManifestEntry,
} from "../types.ts";

export function readTicketFrontmatter(_ticketDir: string): TicketFrontmatter {
  throw new Error("not implemented");
}

export function writeTicketFrontmatter(
  _ticketDir: string,
  _frontmatter: TicketFrontmatter,
  _bodyMarkdown: string,
): void {
  throw new Error("not implemented");
}

export function hashFile(_path: string): string {
  throw new Error("not implemented");
}

export function verifyCriticalFilesHash(
  _ticketDir: string,
  _expected: {
    instructionsSha256: string;
    effectsSha256: string;
    factsSha256: string;
  },
): boolean {
  throw new Error("not implemented");
}

export function buildCorpusManifest(_contextDir: string): CorpusManifestEntry[] {
  throw new Error("not implemented");
}

export function verifyCorpusManifest(
  _contextDir: string,
  _manifest: CorpusManifestEntry[],
): boolean {
  throw new Error("not implemented");
}

export function readEffectsManifest(_ticketDir: string): EffectManifestEntry[] {
  throw new Error("not implemented");
}

export function readFacts(_ticketDir: string): Record<string, unknown> {
  throw new Error("not implemented");
}
