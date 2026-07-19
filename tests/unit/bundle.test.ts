// Oraculo congelado para knowledge/contracts/ted-bundle.md. NO editar como
// parte de la implementacion -- ver touch_only del contrato.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTicketFrontmatter,
  writeTicketFrontmatter,
  hashFile,
  verifyCriticalFilesHash,
  buildCorpusManifest,
  verifyCorpusManifest,
  readEffectsManifest,
  readFacts,
} from "../../src/bundle/index.ts";
import type { TicketFrontmatter } from "../../src/types.ts";

function newTicketDir(): string {
  return mkdtempSync(join(tmpdir(), "ted-bundle-test-"));
}

const TICKET_MD = `---
type: Ticket
title: Enviar recordatorio de pago
description: Recordatorio automatico al vencer la factura
timestamp: "2026-07-19T00:00:00.000Z"

ccdd_provenance:
  author: "human:mauricio"
  generated_at: "2026-07-19T00:00:00.000Z"
  approved_by: "human:mauricio"

ticket_id: 20260719-abc123
supersedes: null
superseded_by: null

trigger:
  kind: external_callback
  expected_from: "system:billing"
  correlation_key: 20260719-abc123

attestation:
  attested_by: "human:mauricio"
  attested_at: "2026-07-19T00:00:00.000Z"
  valid_until: "2026-08-19T00:00:00.000Z"
  signature_ref: "/tickets/attestations.json#20260719-abc123"

projected_state: pending
projected_attempts: 0
projected_as_of: "2026-07-19T00:00:00.000Z"
---

# Recordatorio de pago
`;

test("readTicketFrontmatter parses nested snake_case YAML into the typed camelCase shape", () => {
  const dir = newTicketDir();
  writeFileSync(join(dir, "ticket.md"), TICKET_MD, "utf-8");
  const fm = readTicketFrontmatter(dir);
  assert.equal(fm.type, "Ticket");
  assert.equal(fm.ticketId, "20260719-abc123");
  assert.equal(fm.supersedes, null);
  assert.equal(fm.ccddProvenance.generatedAt, "2026-07-19T00:00:00.000Z");
  assert.equal(fm.trigger.expectedFrom, "system:billing");
  assert.equal(fm.trigger.correlationKey, "20260719-abc123");
  assert.equal(fm.attestation.validUntil, "2026-08-19T00:00:00.000Z");
  assert.equal(fm.projectedState, "pending");
  assert.equal(fm.projectedAttempts, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("writeTicketFrontmatter then readTicketFrontmatter round-trips every field", () => {
  const dir = newTicketDir();
  writeFileSync(join(dir, "ticket.md"), TICKET_MD, "utf-8");
  const original = readTicketFrontmatter(dir);
  const updated: TicketFrontmatter = {
    ...original,
    projectedState: "leased",
    projectedAttempts: 1,
    projectedAsOf: "2026-07-19T00:05:00.000Z",
  };
  writeTicketFrontmatter(dir, updated, "# Recordatorio de pago\n");
  const reread = readTicketFrontmatter(dir);
  assert.deepEqual(reread, updated);
  rmSync(dir, { recursive: true, force: true });
});

test("hashFile computes the SHA-256 hex of the exact file bytes", () => {
  const dir = newTicketDir();
  const filePath = join(dir, "sample.txt");
  writeFileSync(filePath, "abc", "utf-8");
  assert.equal(
    hashFile(filePath),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("verifyCriticalFilesHash detects tampering of a signed slot (S5 point 2)", () => {
  const dir = newTicketDir();
  writeFileSync(join(dir, "instructions.md"), "do the thing", "utf-8");
  writeFileSync(join(dir, "effects.md"), "effect list", "utf-8");
  writeFileSync(join(dir, "facts.md"), "fact list", "utf-8");
  const expected = {
    instructionsSha256: hashFile(join(dir, "instructions.md")),
    effectsSha256: hashFile(join(dir, "effects.md")),
    factsSha256: hashFile(join(dir, "facts.md")),
  };
  assert.equal(verifyCriticalFilesHash(dir, expected), true);
  writeFileSync(join(dir, "instructions.md"), "do something else", "utf-8");
  assert.equal(verifyCriticalFilesHash(dir, expected), false);
  rmSync(dir, { recursive: true, force: true });
});

test("buildCorpusManifest lists context/ files sorted by path with their hash (S10.1)", () => {
  const dir = newTicketDir();
  const contextDir = join(dir, "context");
  mkdirSync(contextDir);
  writeFileSync(join(contextDir, "b.md"), "segundo", "utf-8");
  writeFileSync(join(contextDir, "a.md"), "primero", "utf-8");
  const manifest = buildCorpusManifest(contextDir);
  assert.deepEqual(manifest.map((e) => e.path), ["a.md", "b.md"]);
  assert.equal(manifest[0]?.sha256, hashFile(join(contextDir, "a.md")));
  rmSync(dir, { recursive: true, force: true });
});

test("verifyCorpusManifest rejects a file modified after the manifest was signed (S10.1)", () => {
  const dir = newTicketDir();
  const contextDir = join(dir, "context");
  mkdirSync(contextDir);
  writeFileSync(join(contextDir, "a.md"), "original", "utf-8");
  const manifest = buildCorpusManifest(contextDir);
  assert.equal(verifyCorpusManifest(contextDir, manifest), true);
  writeFileSync(join(contextDir, "a.md"), "modificado post-firma", "utf-8");
  assert.equal(verifyCorpusManifest(contextDir, manifest), false);
  rmSync(dir, { recursive: true, force: true });
});

test("verifyCorpusManifest rejects a declared file that no longer exists", () => {
  const dir = newTicketDir();
  const contextDir = join(dir, "context");
  mkdirSync(contextDir);
  writeFileSync(join(contextDir, "a.md"), "original", "utf-8");
  const manifest = buildCorpusManifest(contextDir);
  rmSync(join(contextDir, "a.md"));
  assert.equal(verifyCorpusManifest(contextDir, manifest), false);
  rmSync(dir, { recursive: true, force: true });
});

const EFFECTS_MD = `---
effects:
  - effect_id: send_email
    tool: email.send
    constraints:
      - "params.recipient == facts.authorized_recipient"
    idempotency_key: "20260719-abc123:send_email"
    max_invocations: 1
    escalation:
      hard_triggers: ["constraint-error"]
      soft_triggers_enabled: false
    kind: write
  - effect_id: check_balance
    tool: billing.read_balance
    constraints: []
    idempotency_key: "20260719-abc123:check_balance"
    max_invocations: 3
    escalation:
      hard_triggers: []
      soft_triggers_enabled: true
    kind: read
    response_schema:
      amount: number
      currency: string
---
`;

test("readEffectsManifest parses the closed effect list with snake_case->camelCase mapping (S4.3)", () => {
  const dir = newTicketDir();
  writeFileSync(join(dir, "effects.md"), EFFECTS_MD, "utf-8");
  const effects = readEffectsManifest(dir);
  assert.equal(effects.length, 2);
  const email = effects.find((e) => e.effectId === "send_email");
  assert.ok(email);
  assert.equal(email?.kind, "write");
  assert.equal(email?.idempotencyKey, "20260719-abc123:send_email");
  assert.equal(email?.escalation.hardTriggers[0], "constraint-error");
  assert.equal(email?.responseSchema, undefined);

  const balance = effects.find((e) => e.effectId === "check_balance");
  assert.equal(balance?.kind, "read");
  assert.deepEqual(balance?.responseSchema, { amount: "number", currency: "string" });
  rmSync(dir, { recursive: true, force: true });
});

const FACTS_MD = `---
facts:
  amount: 4200
  currency: USD
  budget_total: 10000
---
`;

test("readFacts returns the signed operational facts with primitive types intact", () => {
  const dir = newTicketDir();
  writeFileSync(join(dir, "facts.md"), FACTS_MD, "utf-8");
  const facts = readFacts(dir);
  assert.equal(facts["amount"], 4200);
  assert.equal(facts["currency"], "USD");
  assert.equal(facts["budget_total"], 10000);
  rmSync(dir, { recursive: true, force: true });
});
