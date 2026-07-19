// Implementacion de knowledge/contracts/ted-bundle.md.
// Lee/escribe ticket.md, effects.md, facts.md (YAML delimitado por `---`),
// hashea archivos y construye/verifica el manifiesto de corpus de context/.
//
// Decision de formato (documentada en el contrato): los tres archivos usan
// YAML delimitado por `---`. El paquete `yaml` se usa con el schema core
// (default), que en esta version mantiene los timestamps bare como strings
// (no los convierte a Date) -- verificado empiricamente antes de implementar.
// El schema `json` se descarto porque rechaza claves sin comillas.
import { parse, stringify } from "yaml";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  TicketFrontmatter,
  EffectManifestEntry,
  CorpusManifestEntry,
} from "../types.ts";

// Extrae el bloque YAML entre el primer y el segundo `---` (inclusive el
// caso sin cuerpo tras el delimitador de cierre). No normaliza newlines.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function extractFrontmatter(content: string): string {
  const m = content.match(FRONTMATTER_RE);
  if (!m) {
    throw new Error("frontmatter delimiters (---) not found");
  }
  return m[1]!;
}

// --- ticket.md: mapeo explicito snake_case (YAML) <-> camelCase (TS) ---

function ticketFromYaml(raw: Record<string, any>): TicketFrontmatter {
  const ccp = raw.ccdd_provenance as Record<string, any>;
  const tr = raw.trigger as Record<string, any>;
  const at = raw.attestation as Record<string, any>;
  return {
    type: raw.type,
    title: raw.title,
    description: raw.description,
    timestamp: raw.timestamp,
    ccddProvenance: {
      author: ccp.author,
      generatedAt: ccp.generated_at,
      approvedBy: ccp.approved_by,
    },
    ticketId: raw.ticket_id,
    supersedes: raw.supersedes,
    supersededBy: raw.superseded_by,
    trigger: {
      kind: tr.kind,
      expectedFrom: tr.expected_from,
      correlationKey: tr.correlation_key,
    },
    attestation: {
      attestedBy: at.attested_by,
      attestedAt: at.attested_at,
      validUntil: at.valid_until,
      signatureRef: at.signature_ref,
    },
    projectedState: raw.projected_state,
    projectedAttempts: raw.projected_attempts,
    projectedAsOf: raw.projected_as_of,
  };
}

function ticketToYaml(fm: TicketFrontmatter): Record<string, any> {
  return {
    type: fm.type,
    title: fm.title,
    description: fm.description,
    timestamp: fm.timestamp,
    ccdd_provenance: {
      author: fm.ccddProvenance.author,
      generated_at: fm.ccddProvenance.generatedAt,
      approved_by: fm.ccddProvenance.approvedBy,
    },
    ticket_id: fm.ticketId,
    supersedes: fm.supersedes,
    superseded_by: fm.supersededBy,
    trigger: {
      kind: fm.trigger.kind,
      expected_from: fm.trigger.expectedFrom,
      correlation_key: fm.trigger.correlationKey,
    },
    attestation: {
      attested_by: fm.attestation.attestedBy,
      attested_at: fm.attestation.attestedAt,
      valid_until: fm.attestation.validUntil,
      signature_ref: fm.attestation.signatureRef,
    },
    projected_state: fm.projectedState,
    projected_attempts: fm.projectedAttempts,
    projected_as_of: fm.projectedAsOf,
  };
}

export function readTicketFrontmatter(ticketDir: string): TicketFrontmatter {
  const content = readFileSync(join(ticketDir, "ticket.md"), "utf-8");
  const raw = parse(extractFrontmatter(content)) as Record<string, any>;
  return ticketFromYaml(raw);
}

export function writeTicketFrontmatter(
  ticketDir: string,
  frontmatter: TicketFrontmatter,
  bodyMarkdown: string,
): void {
  const yamlText = stringify(ticketToYaml(frontmatter));
  const content = `---\n${yamlText}---\n${bodyMarkdown}`;
  writeFileSync(join(ticketDir, "ticket.md"), content, "utf-8");
}

// --- hashing ---

export function hashFile(path: string): string {
  const buf = readFileSync(path); // bytes exactos, sin normalizar newlines
  return createHash("sha256").update(buf).digest("hex");
}

export function verifyCriticalFilesHash(
  ticketDir: string,
  expected: {
    instructionsSha256: string;
    effectsSha256: string;
    factsSha256: string;
  },
): boolean {
  try {
    return (
      hashFile(join(ticketDir, "instructions.md")) === expected.instructionsSha256 &&
      hashFile(join(ticketDir, "effects.md")) === expected.effectsSha256 &&
      hashFile(join(ticketDir, "facts.md")) === expected.factsSha256
    );
  } catch {
    return false;
  }
}

// --- manifiesto de corpus de context/ (solo nivel directo, no recursivo) ---

export function buildCorpusManifest(contextDir: string): CorpusManifestEntry[] {
  const names = readdirSync(contextDir);
  const entries: CorpusManifestEntry[] = [];
  for (const name of names) {
    const full = join(contextDir, name);
    if (!statSync(full).isFile()) continue;
    entries.push({ path: name, sha256: hashFile(full) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

export function verifyCorpusManifest(
  contextDir: string,
  manifest: CorpusManifestEntry[],
): boolean {
  for (const entry of manifest) {
    const full = join(contextDir, entry.path);
    if (!existsSync(full)) return false;
    if (hashFile(full) !== entry.sha256) return false;
  }
  return true;
}

// --- effects.md: lista cerrada de efectos, snake_case -> camelCase ---

function effectFromYaml(e: Record<string, any>): EffectManifestEntry {
  const esc = e.escalation as Record<string, any>;
  const out: EffectManifestEntry = {
    effectId: e.effect_id,
    tool: e.tool,
    constraints: e.constraints,
    idempotencyKey: e.idempotency_key,
    maxInvocations: e.max_invocations,
    escalation: {
      hardTriggers: esc.hard_triggers,
      softTriggersEnabled: esc.soft_triggers_enabled,
    },
    kind: e.kind,
  };
  if (e.response_schema !== undefined) {
    out.responseSchema = e.response_schema;
  }
  return out;
}

export function readEffectsManifest(ticketDir: string): EffectManifestEntry[] {
  const content = readFileSync(join(ticketDir, "effects.md"), "utf-8");
  const raw = parse(extractFrontmatter(content)) as { effects: Record<string, any>[] };
  return raw.effects.map(effectFromYaml);
}

// --- facts.md: objeto plano de hechos operativos, claves tal cual (sin mapeo) ---

export function readFacts(ticketDir: string): Record<string, unknown> {
  const content = readFileSync(join(ticketDir, "facts.md"), "utf-8");
  const raw = parse(extractFrontmatter(content)) as { facts: Record<string, unknown> };
  return raw.facts;
}