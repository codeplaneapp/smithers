/** @jsxImportSource smthrs */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { closeTrackedSmithers, createTrackedSmithers as createSmithers } from "./fixtures/tracked-smithers.js";
import { SmithersDb } from "@smthrs/db/adapter";
import { Gateway } from "../src/gateway.js";
import { sleep } from "../../smithers/tests/helpers.js";

afterAll(closeTrackedSmithers);

/**
 * Covers the gateway's disk/DB-backed read RPCs and the ticket CRUD RPCs by
 * seeding REAL data (a prompts directory, scorer rows, memory facts, run nodes,
 * work docs) against a REAL in-memory gateway and driving the /v1/rpc surface.
 */

function getPort(server) {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {}
  }
});

function makeWorkspace(name) {
  const root = join(tmpdir(), `smithers-rpc-cov-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function createValueWorkflow(dbPath) {
  const { smithers, Workflow, Task, outputs } = createSmithers({ result: z.object({ value: z.number() }) }, { dbPath });
  const workflow = smithers((ctx) => (
    <Workflow name="rpc-cov">
      <Task id="task1" output={outputs.result}>
        {{ value: Number(ctx.input?.value ?? 1) }}
      </Task>
    </Workflow>
  ));
  return { workflow, dbPath };
}

async function rpc(baseUrl, method, params = {}) {
  const response = await fetch(`${baseUrl}/v1/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function launch(baseUrl, workflow, input = {}) {
  const { json } = await rpc(baseUrl, "launchRun", { workflow, input });
  expect(json.ok).toBe(true);
  return json.payload.runId;
}

async function waitFinished(baseUrl, runId) {
  for (let i = 0; i < 200; i += 1) {
    const { json } = await rpc(baseUrl, "getRun", { runId });
    if (json.ok && ["finished", "failed", "continued"].includes(json.payload?.status)) return json.payload;
    await sleep(25);
  }
  throw new Error(`run ${runId} never finished`);
}

describe("gateway disk/DB RPC coverage", () => {
  test("listPrompts walks the workspace .smithers/prompts tree", async () => {
    const root = makeWorkspace("prompts");
    const promptsDir = join(root, ".smithers", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    // Top-level: a hidden dotfile (skipped), a .md and .mdx (included), a
    // non-markdown file (ignored by extension), a nested directory (recursed),
    // an unreadable directory (readdir throws -> caught), and a broken symlink
    // (neither file nor directory -> skipped).
    writeFileSync(join(promptsDir, ".hidden.md"), "# hidden\n");
    writeFileSync(join(promptsDir, "alpha.md"), "# Alpha\n");
    writeFileSync(join(promptsDir, "beta.mdx"), "# Beta\n");
    writeFileSync(join(promptsDir, "notes.txt"), "ignored\n");
    mkdirSync(join(promptsDir, "sub"), { recursive: true });
    writeFileSync(join(promptsDir, "sub", "gamma.md"), "# Gamma\n");
    const locked = join(promptsDir, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "secret.md"), "# secret\n");
    let lockedChmodApplied = false;
    try {
      chmodSync(locked, 0o000);
      lockedChmodApplied = true;
    } catch {}
    try {
      symlinkSync(join(promptsDir, "does-not-exist"), join(promptsDir, "dangling-link"));
    } catch {}
    cleanups.push(() => {
      try {
        chmodSync(locked, 0o755);
      } catch {}
    });

    const dbPath = join(root, "wf.db");
    const { workflow } = createValueWorkflow(dbPath);
    const gateway = new Gateway({ workspaceRoot: root });
    gateway.register("rpc-cov", workflow);
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => gateway.close());
    const baseUrl = `http://127.0.0.1:${getPort(server)}`;

    const { json } = await rpc(baseUrl, "listPrompts", {});
    expect(json.ok).toBe(true);
    const ids = json.payload.map((row) => row.id).sort();
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
    expect(ids).toContain("sub/gamma");
    // Hidden dotfile and non-markdown file never surface; if the locked dir was
    // truly unreadable its child is skipped, otherwise it is fine to include it.
    expect(ids).not.toContain(".hidden");
    expect(ids).not.toContain("notes");
    if (lockedChmodApplied) {
      expect(ids).not.toContain("locked/secret");
    }
  });

  test("getRun summary, listScores, listMemoryFacts, tickets, and watchers", async () => {
    const root = makeWorkspace("data");
    const dbPath = join(root, "wf.db");
    const { workflow } = createValueWorkflow(dbPath);
    const gateway = new Gateway({ workspaceRoot: root });
    gateway.register("rpc-cov", workflow);
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => gateway.close());
    const baseUrl = `http://127.0.0.1:${getPort(server)}`;

    const runId = await launch(baseUrl, "rpc-cov", { value: 5 });
    await waitFinished(baseUrl, runId);

    // getRun's node-state summary reduce only runs when the run has nodes; a
    // finished single-task run already has one, so getRun exercises the reduce.
    const got = await rpc(baseUrl, "getRun", { runId });
    expect(got.json.ok).toBe(true);
    expect(got.json.payload.summary).toBeDefined();
    expect(Object.keys(got.json.payload.summary).length).toBeGreaterThan(0);

    // Seed scorer rows so listScores maps a non-empty result set.
    const adapter = new SmithersDb(workflow.db);
    await adapter.insertScorerResult({
      id: `${runId}:task1:s1`,
      runId,
      nodeId: "task1",
      iteration: 0,
      attempt: 1,
      scorerId: "s1",
      scorerName: "quality",
      source: "llm",
      score: 0.9,
      reason: "looks good",
      scoredAtMs: Date.now(),
      latencyMs: 12,
      durationMs: 34,
    });
    // A second row lacking the optional fields exercises the null-coalescing map.
    await adapter.insertScorerResult({
      id: `${runId}:task1:s2`,
      runId,
      nodeId: "task1",
      iteration: 0,
      attempt: 1,
      scorerId: "s2",
      scorerName: "safety",
      source: "heuristic",
      score: 1,
      reason: null,
      scoredAtMs: Date.now(),
      latencyMs: null,
      durationMs: null,
    });
    const scores = await rpc(baseUrl, "listScores", { runId });
    expect(scores.json.ok).toBe(true);
    expect(scores.json.payload.length).toBe(2);
    expect(scores.json.payload[0].scorerId).toBeDefined();
    // Scoped by nodeId as well.
    const scopedScores = await rpc(baseUrl, "listScores", { runId, nodeId: "task1" });
    expect(scopedScores.json.ok).toBe(true);
    // Unknown run -> NOT_FOUND.
    const missingScores = await rpc(baseUrl, "listScores", { runId: "nope" });
    expect(missingScores.json.ok).toBe(false);

    // Seed >=2 memory facts across namespaces so the cross-workflow sort runs.
    const raw = workflow.db.$client;
    const nowMs = Date.now();
    for (const [ns, key] of [
      ["alpha", "one"],
      ["alpha", "two"],
      ["beta", "one"],
    ]) {
      raw.run(
        "INSERT INTO _smithers_memory_facts (namespace, key, value_json, schema_sig, created_at_ms, updated_at_ms, ttl_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [ns, key, JSON.stringify({ v: 1 }), "sig", nowMs, nowMs, null],
      );
    }
    const facts = await rpc(baseUrl, "listMemoryFacts", {});
    expect(facts.json.ok).toBe(true);
    expect(facts.json.payload.length).toBeGreaterThanOrEqual(3);
    // Namespace-scoped read too.
    const scopedFacts = await rpc(baseUrl, "listMemoryFacts", { namespace: "alpha" });
    expect(scopedFacts.json.ok).toBe(true);

    // Ticket CRUD: create -> list -> update (content + status) -> delete, plus
    // the not-found and re-create/revive branches.
    const created = await rpc(baseUrl, "createTicket", {
      path: "docs/plan.md",
      content: "hello",
      kind: "plan",
      status: "todo",
    });
    expect(created.json.ok).toBe(true);
    expect(created.json.payload.contentHash).toBeDefined();
    // Re-create the same path revives/overwrites (existing row path).
    const recreated = await rpc(baseUrl, "createTicket", { path: "docs/plan.md", content: "hello again" });
    expect(recreated.json.ok).toBe(true);

    const listed = await rpc(baseUrl, "listTickets", {});
    expect(listed.json.ok).toBe(true);
    expect(listed.json.payload.some((row) => row.path === "docs/plan.md")).toBe(true);
    const listedKind = await rpc(baseUrl, "listTickets", { kind: "plan" });
    expect(listedKind.json.ok).toBe(true);

    const updated = await rpc(baseUrl, "updateTicket", {
      path: "docs/plan.md",
      content: "updated body",
      status: "done",
    });
    expect(updated.json.ok).toBe(true);
    expect(updated.json.payload.content).toBe("updated body");
    // Status-only update keeps the existing content/hash.
    const statusOnly = await rpc(baseUrl, "updateTicket", { path: "docs/plan.md", status: "in-progress" });
    expect(statusOnly.json.ok).toBe(true);
    // Updating an unknown ticket -> NOT_FOUND.
    const updateMissing = await rpc(baseUrl, "updateTicket", { path: "docs/missing.md", content: "x" });
    expect(updateMissing.json.ok).toBe(false);

    const deleted = await rpc(baseUrl, "deleteTicket", { path: "docs/plan.md" });
    expect(deleted.json.ok).toBe(true);
    // Deleting again (already tombstoned) -> NOT_FOUND.
    const deleteMissing = await rpc(baseUrl, "deleteTicket", { path: "docs/plan.md" });
    expect(deleteMissing.json.ok).toBe(false);

    // watchTicketsDirectory: null dir, a real dir (starts a watcher), and a
    // repeat call for the same dir (returns the existing watcher).
    expect(gateway.watchTicketsDirectory("")).toBeNull();
    const ticketsDir = join(root, "tickets");
    mkdirSync(ticketsDir, { recursive: true });
    const watcher = gateway.watchTicketsDirectory(ticketsDir);
    expect(watcher).not.toBeNull();
    const again = gateway.watchTicketsDirectory(ticketsDir);
    expect(again).toBe(watcher);
    watcher?.close?.();
  });

  test("ticket writes with no registered workflow report the no-adapter branch", async () => {
    const gateway = new Gateway({});
    const server = await gateway.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => gateway.close());
    const baseUrl = `http://127.0.0.1:${getPort(server)}`;

    // With no workflow registered, primaryDocsAdapter() is null: create/update/
    // delete all report the "no workflow" error branch, and watchTicketsDirectory
    // returns null for a real dir because there is no adapter to back it.
    const created = await rpc(baseUrl, "createTicket", { path: "p.md", content: "x" });
    expect(created.json.ok).toBe(false);
    const updated = await rpc(baseUrl, "updateTicket", { path: "p.md", content: "x" });
    expect(updated.json.ok).toBe(false);
    const deleted = await rpc(baseUrl, "deleteTicket", { path: "p.md" });
    expect(deleted.json.ok).toBe(false);
    const root = makeWorkspace("noadapter");
    expect(gateway.watchTicketsDirectory(root)).toBeNull();
    // Empty list surfaces cleanly with no adapters.
    const listed = await rpc(baseUrl, "listTickets", {});
    expect(listed.json.ok).toBe(true);
    expect(listed.json.payload).toEqual([]);
  });
});
