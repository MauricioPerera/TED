// Oraculo congelado para knowledge/contracts/ted-mcp-server.md. NO editar
// como parte de la implementacion -- ver touch_only del contrato.
import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TicketStore } from "../../src/store/index.ts";
import { compileConstraint } from "../../src/constraints/index.ts";
import { EffectsShim } from "../../src/shim/index.ts";
import { createShimMcpServer } from "../../src/mcp-server/index.ts";
import type { EffectManifestEntry } from "../../src/types.ts";
import type { AgentOutcome } from "../../src/orchestrator/index.ts";

const NOW = "2026-07-19T00:00:00.000Z";

function entry(overrides: Partial<EffectManifestEntry>): EffectManifestEntry {
  return {
    effectId: "e",
    tool: "svc.op",
    constraints: [],
    idempotencyKey: "t1:e",
    maxInvocations: 5,
    escalation: { hardTriggers: [], softTriggersEnabled: false },
    kind: "write",
    ...overrides,
  };
}

async function setup(manifest: EffectManifestEntry[]) {
  const store = new TicketStore(":memory:");
  store.createPending("t1", 3);
  store.acquireLease("t1", 600000, NOW);

  const compiledConstraints = new Map(
    manifest.map((e) => [e.effectId, e.constraints.map(compileConstraint)]),
  );

  const shim = new EffectsShim({
    store,
    ticketId: "t1",
    fencingToken: 1,
    manifest,
    compiledConstraints,
    facts: { limit: 100 },
    now: NOW,
    denyThreshold: 3,
    execute: (_tool, params) => ({ receipt: "r1", amount: params["amount"], extra: "unlisted" }),
  });

  const reportedOutcomes: AgentOutcome[] = [];
  const mcpServer: McpServer = createShimMcpServer({
    shim,
    manifest,
    onReportOutcome: (o) => reportedOutcomes.push(o),
  });

  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "ted-test-client", version: "0.1.0" });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, reportedOutcomes };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text === undefined) {
    throw new Error("expected a text content block");
  }
  return JSON.parse(first.text);
}

test("the server exposes exactly the manifest's effects plus report_outcome, nothing else", async () => {
  const manifest = [entry({ effectId: "charge" }), entry({ effectId: "refund" })];
  const { client } = await setup(manifest);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((t) => t.name).sort(),
    ["charge", "refund", "report_outcome"],
  );
});

test("calling a known effect tool routes through the shim and returns its result as JSON text", async () => {
  const manifest = [entry({ effectId: "charge", constraints: ["params.amount <= facts.limit"] })];
  const { client } = await setup(manifest);
  const result = await client.callTool({ name: "charge", arguments: { amount: 10 } });
  const parsed = textOf(result as never) as { outcome: string; data: Record<string, unknown> };
  assert.equal(parsed.outcome, "result");
  assert.equal(parsed.data["amount"], 10);
  assert.equal(result.isError, undefined);
});

test("a constraint denial surfaces as a rejected outcome, not an MCP-level error", async () => {
  const manifest = [entry({ effectId: "charge", constraints: ["params.amount <= facts.limit"] })];
  const { client } = await setup(manifest);
  const result = await client.callTool({ name: "charge", arguments: { amount: 500 } });
  const parsed = textOf(result as never) as { outcome: string; reason: string };
  assert.equal(parsed.outcome, "rejected");
  assert.equal(parsed.reason, "constraint-denied");
  assert.equal(result.isError, undefined);
});

test("a constraint evaluation error surfaces as an escalated outcome", async () => {
  const manifest = [entry({ effectId: "charge", constraints: ["facts.missing_fact == 1"] })];
  const { client } = await setup(manifest);
  const result = await client.callTool({ name: "charge", arguments: { amount: 1 } });
  const parsed = textOf(result as never) as { outcome: string; trigger: string };
  assert.equal(parsed.outcome, "escalated");
  assert.equal(parsed.trigger, "constraint-error");
});

test("a read effect's response is filtered to the declared schema before it reaches the tool result", async () => {
  const manifest = [
    entry({
      effectId: "getbalance",
      kind: "read",
      constraints: [],
    }),
  ];
  manifest[0]!.responseSchema = { amount: "number" };
  const { client } = await setup(manifest);
  const result = await client.callTool({ name: "getbalance", arguments: { amount: 7 } });
  const parsed = textOf(result as never) as { outcome: string; data: Record<string, unknown> };
  assert.equal(parsed.outcome, "result");
  assert.deepEqual(parsed.data, { amount: 7 });
});

test("calling an unregistered tool name never reaches the shim: it is an MCP-level error", async () => {
  const manifest = [entry({ effectId: "charge" })];
  const { client } = await setup(manifest);
  const result = await client.callTool({ name: "does_not_exist_in_manifest", arguments: {} });
  assert.equal(result.isError, true);
});

test("report_outcome with just a finished status records an outcome with no reason", async () => {
  const manifest = [entry({ effectId: "charge" })];
  const { client, reportedOutcomes } = await setup(manifest);
  await client.callTool({ name: "report_outcome", arguments: { finished: "fulfilled" } });
  assert.deepEqual(reportedOutcomes, [{ finished: "fulfilled" }]);
});

test("report_outcome with a reason records both fields", async () => {
  const manifest = [entry({ effectId: "charge" })];
  const { client, reportedOutcomes } = await setup(manifest);
  await client.callTool({ name: "report_outcome", arguments: { finished: "failed", reason: "agent-aborted" } });
  assert.deepEqual(reportedOutcomes, [{ finished: "failed", reason: "agent-aborted" }]);
});

test("re-invoking an already-confirmed effect through the MCP layer replays the cached result", async () => {
  const manifest = [entry({ effectId: "charge", constraints: [] })];
  const { client } = await setup(manifest);
  const first = await client.callTool({ name: "charge", arguments: { amount: 3 } });
  const second = await client.callTool({ name: "charge", arguments: { amount: 3 } });
  assert.deepEqual(textOf(first as never), textOf(second as never));
});
