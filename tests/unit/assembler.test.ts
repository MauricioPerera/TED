// Oraculo congelado para knowledge/contracts/ted-assembler.md. NO editar
// como parte de la implementacion -- ver touch_only del contrato.
import test from "node:test";
import assert from "node:assert/strict";
import { assembleContext } from "../../src/assembler/index.ts";
import type { AssemblerInput } from "../../src/assembler/index.ts";

function baseInput(overrides?: Partial<AssemblerInput>): AssemblerInput {
  return {
    instructionsText: "Do the thing.",
    effectsText: "effects: []",
    factsText: "facts: {}",
    triggerPayload: "triggered",
    worldContext: "some background context",
    maxTokens: 10000,
    reserveOutput: 500,
    ...overrides,
  };
}

function baseInputNoWorldContext(): AssemblerInput {
  return {
    instructionsText: "Do the thing.",
    effectsText: "effects: []",
    factsText: "facts: {}",
    triggerPayload: "triggered",
    maxTokens: 10000,
    reserveOutput: 500,
  };
}

test("happy path: everything fits, nothing truncated, all five slots present in priority order", () => {
  const result = assembleContext(baseInput());
  assert.equal(result.slots.length, 5);
  assert.deepEqual(
    result.slots.map((s) => s.id),
    ["ticket_instructions", "effects_manifest", "signed_facts", "trigger_payload", "world_context"],
  );
  assert.ok(result.slots.every((s) => s.truncated === false));
  assert.equal(result.budgetExceededBeforeTruncation, false);
});

test("the prompt concatenates slot headers and content in priority order", () => {
  const result = assembleContext(baseInput());
  const instructionsIdx = result.prompt.indexOf("Do the thing.");
  const effectsIdx = result.prompt.indexOf("effects: []");
  const factsIdx = result.prompt.indexOf("facts: {}");
  const triggerIdx = result.prompt.indexOf("triggered");
  const worldIdx = result.prompt.indexOf("some background context");
  assert.ok(instructionsIdx < effectsIdx);
  assert.ok(effectsIdx < factsIdx);
  assert.ok(factsIdx < triggerIdx);
  assert.ok(triggerIdx < worldIdx);
});

test("trigger_payload is truncated to its own 1000-token cap even when overall budget is huge", () => {
  const hugeTrigger = "x".repeat(20000); // ~5000 tokens at 4 chars/token
  const result = assembleContext(baseInput({ triggerPayload: hugeTrigger, maxTokens: 1000000, reserveOutput: 0 }));
  const triggerSlot = result.slots.find((s) => s.id === "trigger_payload");
  assert.equal(triggerSlot?.truncated, true);
  assert.ok(triggerSlot!.content.length <= 1000 * 4 + 20); // + marker margin
});

test("world_context is truncated to its own 6000-token cap even when overall budget is huge", () => {
  const hugeWorld = "y".repeat(50000); // ~12500 tokens at 4 chars/token
  const result = assembleContext(baseInput({ worldContext: hugeWorld, maxTokens: 1000000, reserveOutput: 0 }));
  const worldSlot = result.slots.find((s) => s.id === "world_context");
  assert.equal(worldSlot?.truncated, true);
  assert.ok(worldSlot!.content.length <= 6000 * 4 + 20);
});

test("signed slots (instructions/effects/facts) are never truncated, even under a starved budget", () => {
  const bigInstructions = "z".repeat(8000); // ~2000 tokens
  const result = assembleContext(
    baseInput({ instructionsText: bigInstructions, maxTokens: 10, reserveOutput: 0 }),
  );
  const instructions = result.slots.find((s) => s.id === "ticket_instructions");
  const effects = result.slots.find((s) => s.id === "effects_manifest");
  const facts = result.slots.find((s) => s.id === "signed_facts");
  assert.equal(instructions?.content, bigInstructions);
  assert.equal(instructions?.truncated, false);
  assert.equal(effects?.truncated, false);
  assert.equal(facts?.truncated, false);
});

test("under a starved budget, trigger_payload and world_context are squeezed to empty rather than touching signed slots", () => {
  const bigInstructions = "z".repeat(8000);
  const result = assembleContext(
    baseInput({ instructionsText: bigInstructions, maxTokens: 10, reserveOutput: 0 }),
  );
  const trigger = result.slots.find((s) => s.id === "trigger_payload");
  const world = result.slots.find((s) => s.id === "world_context");
  assert.equal(trigger?.content, "");
  assert.equal(world?.content, "");
});

test("priority sacrifice: when only enough budget remains for trigger_payload, world_context is squeezed out first", () => {
  // Presupuesto: 3 tokens para los signed slots ("a"/"b"/"c") + exactamente los
  // 4 tokens que ocupa el trigger de abajo, y nada mas para world_context.
  const result = assembleContext(
    baseInput({
      instructionsText: "a",
      effectsText: "b",
      factsText: "c",
      triggerPayload: "short trigger",
      worldContext: "y".repeat(4000),
      maxTokens: 7,
      reserveOutput: 0,
    }),
  );
  const trigger = result.slots.find((s) => s.id === "trigger_payload");
  const world = result.slots.find((s) => s.id === "world_context");
  assert.equal(trigger?.content, "short trigger");
  assert.equal(trigger?.truncated, false);
  assert.equal(world?.content, "");
});

test("world_context omitted (undefined) yields an empty slot and no heading in the prompt", () => {
  const result = assembleContext(baseInputNoWorldContext());
  const world = result.slots.find((s) => s.id === "world_context");
  assert.equal(world?.content, "");
  assert.equal(world?.truncated, false);
  assert.equal(result.prompt.includes("some background context"), false);
});

test("budgetExceededBeforeTruncation reflects the RAW (pre-truncation) total against the available budget", () => {
  const fits = assembleContext(baseInput({ maxTokens: 10000, reserveOutput: 0 }));
  assert.equal(fits.budgetExceededBeforeTruncation, false);
  const overflow = assembleContext(baseInput({ worldContext: "w".repeat(100000), maxTokens: 10000, reserveOutput: 0 }));
  assert.equal(overflow.budgetExceededBeforeTruncation, true);
});

test("truncated content carries a fixed, detectable marker", () => {
  const result = assembleContext(baseInput({ triggerPayload: "x".repeat(20000), maxTokens: 1000000, reserveOutput: 0 }));
  const trigger = result.slots.find((s) => s.id === "trigger_payload");
  assert.ok(trigger!.content.includes("[truncado]"));
});

test("assembling twice with identical input produces a byte-identical prompt (determinism)", () => {
  const input = baseInput();
  const a = assembleContext(input);
  const b = assembleContext(input);
  assert.equal(a.prompt, b.prompt);
  assert.equal(a.totalEstimatedTokens, b.totalEstimatedTokens);
});
