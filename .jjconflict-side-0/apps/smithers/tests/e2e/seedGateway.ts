/**
 * The e2e seed Gateway. Boots a real `smithers gateway` (the same
 * `@smithers-orchestrator/server/gateway` the CLI uses) over a hermetic, freshly
 * reset workspace DB in this directory, and registers the two no-agent seed
 * workflows. No mocks: the UI under test talks to this real gateway over RPC/WS.
 *
 * `globalSetup.ts` launches the seed runs against it via the real `launchRun`
 * RPC once it is listening.
 */
import { Gateway, mdxPlugin } from "smithers-orchestrator";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync } from "node:fs";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
// The workspace is this directory; chdir before importing the workflows so they
// bind their backend to the hermetic DB here, not the repo root.
process.chdir(here);

const port = Number(process.env.PORT ?? "7331");
const host = process.env.HOST ?? "127.0.0.1";
const authToken = process.env.SMITHERS_E2E_GATEWAY_AUTH_TOKEN;

// Hermetic: start from a fresh DB each run so old runs/approvals never bleed in.
if (process.env.SMITHERS_E2E_RESET_DB !== "0") {
  for (const name of ["smithers.db", "smithers.db-shm", "smithers.db-wal"]) {
    const p = resolve(here, name);
    if (existsSync(p)) rmSync(p);
  }
}

const monitorUiEntry = resolve(
  here,
  "..",
  "..",
  "..",
  "cli",
  "src",
  "monitor-ui",
  "monitor.tsx",
);
const gateway = new Gateway({
  heartbeatMs: 1_000,
  workspaceRoot: here,
  ...(authToken
    ? {
        auth: {
          mode: "token" as const,
          tokens: { [authToken]: { role: "admin", scopes: ["*"] } },
        },
      }
    : {}),
  ui: {
    entry: monitorUiEntry,
    path: "/monitor",
    title: "Smithers Monitor E2E",
  },
});
let seedDb: Parameters<typeof ensureSmithersTables>[0] | null = null;

for (const key of [
  "e2e-task",
  "e2e-approval",
  "e2e-monitor",
  "e2e-monitor-failure",
  "e2e-monitor-live",
]) {
  const mod = await import(`./workflows/${key}.tsx`);
  if (key === "e2e-task") seedDb = mod.default.db;
  // e2e-task gets a custom UI (built from the shared gateway-ui components) so
  // the workflow store has a `hasUi` workflow to render and open.
  const uiEntry = resolve(here, "ui", `${key}.tsx`);
  const options = existsSync(uiEntry)
    ? { ui: { entry: uiEntry, title: "E2E Task" } }
    : {};
  gateway.register(key, mod.default, options);
  console.log(
    `[seed-gateway] registered ${key}${existsSync(uiEntry) ? " (with UI)" : ""}`,
  );
}

if (!seedDb) throw new Error("e2e-task did not expose its database");
ensureSmithersTables(seedDb);

// Deterministic real memory rows. The gateway reads these through the same
// `_smithers_memory_facts` adapter used by production workflows.
const rawDb = seedDb.$client;
const factTime = 1_720_000_000_000;
for (const fact of [
  [
    "project:smithers",
    "testing-style",
    JSON.stringify("Prefer real backends and no mocks."),
    null,
  ],
  [
    "project:smithers",
    "release-channel",
    JSON.stringify({ channel: "stable", owner: "platform" }),
    86_400_000,
  ],
  [
    "agent:codex-main",
    "specialty",
    JSON.stringify("Rendered browser coverage for local UI surfaces."),
    null,
  ],
] as const) {
  rawDb.run(
    "INSERT OR IGNORE INTO _smithers_memory_facts (namespace, key, value_json, schema_sig, created_at_ms, updated_at_ms, ttl_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      fact[0],
      fact[1],
      fact[2],
      "e2e-memory-v1",
      factTime,
      factTime + 1_000,
      fact[3],
    ],
  );
}

// A real persisted run with no task rows gives the Monitor a stable empty-tree
// state without intercepting or fabricating any browser transport.
rawDb.run(
  "INSERT OR IGNORE INTO _smithers_runs (run_id, workflow_name, status, created_at_ms, started_at_ms, finished_at_ms, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  [
    "e2e-empty-tree",
    "e2e-task",
    "finished",
    factTime + 10_000,
    factTime + 10_100,
    factTime + 10_200,
    JSON.stringify({ gatewayWorkflowKey: "e2e-task" }),
  ],
);

// Register a few REAL default-pack workflows so the concierge has genuine work
// to background — including `create-workflow`, the meta-workflow that builds a
// new workflow. This is what proves "the concierge can create a workflow".
// Pack workflows that ship a `.smithers/ui/<key>.tsx` are registered WITH that
// custom UI so `/workflows/<key>` serves the real UI for the e2e specs.
const PACK = resolve(here, "..", "..", "..", "..", ".smithers", "workflows");
const PACK_UI = resolve(here, "..", "..", "..", "..", ".smithers", "ui");
for (const key of [
  "create-workflow",
  "implement",
  "research-plan-implement",
  "review",
  "debug",
]) {
  const entry = resolve(PACK, `${key}.tsx`);
  if (!existsSync(entry)) continue;
  try {
    const mod = await import(entry);
    const packUi = resolve(PACK_UI, `${key}.tsx`);
    const options = existsSync(packUi)
      ? { ui: { entry: packUi, title: key } }
      : {};
    gateway.register(key, mod.default, options);
    console.log(
      `[seed-gateway] registered pack workflow ${key}${existsSync(packUi) ? " (with UI)" : ""}`,
    );
  } catch (err) {
    console.warn(
      `[seed-gateway] skipped ${key}: ${(err as Error).message?.slice(0, 120)}`,
    );
  }
}

await gateway.listen({ host, port });
console.log(`[seed-gateway] listening on http://${host}:${port}`);

// Runs are launched by globalSetup after the gateway starts. Watch the real run
// table and attach deterministic scorer rows to each completed e2e-task run so
// the Scores surface can switch between genuinely persisted run results.
const adapter = new SmithersDb(seedDb);
const scoredRunIds = new Set<string>();
let monitorHijackSeeded = false;
void (async () => {
  for (;;) {
    try {
      const runs = await adapter.listRuns(100, undefined, "e2e-task");
      for (const run of runs) {
        if (scoredRunIds.has(run.runId) || run.status !== "finished") continue;
        const checksum = [...run.runId].reduce(
          (sum, char) => sum + char.charCodeAt(0),
          0,
        );
        const quality = 0.75 + (checksum % 20) / 100;
        await adapter.insertScorerResult({
          id: `${run.runId}:compute:quality`,
          runId: run.runId,
          nodeId: "compute",
          iteration: 0,
          attempt: 1,
          scorerId: "quality",
          scorerName: "Quality",
          source: "e2e",
          score: quality,
          reason: `Seeded quality result for ${run.runId}`,
          scoredAtMs: run.createdAtMs + 10,
          latencyMs: 120 + (checksum % 40),
          durationMs: 180 + (checksum % 40),
        });
        await adapter.insertScorerResult({
          id: `${run.runId}:compute:safety`,
          runId: run.runId,
          nodeId: "compute",
          iteration: 0,
          attempt: 1,
          scorerId: "safety",
          scorerName: "Safety",
          source: "e2e",
          score: 1,
          reason: `No unsafe output in ${run.runId}`,
          scoredAtMs: run.createdAtMs + 20,
          latencyMs: 80,
          durationMs: 95,
        });
        scoredRunIds.add(run.runId);
      }
      if (!monitorHijackSeeded) {
        const monitorRuns = await adapter.listRuns(
          10,
          undefined,
          "e2e-monitor",
        );
        const monitorRun = monitorRuns.find((run) => run.status === "finished");
        if (monitorRun) {
          rawDb.run(
            "UPDATE _smithers_attempts SET meta_json = ? WHERE run_id = ? AND node_id = ? AND attempt = ?",
            [
              JSON.stringify({
                agentEngine: "codex",
                agentResume: "e2e-resumable-session",
              }),
              monitorRun.runId,
              "intake",
              1,
            ],
          );
          monitorHijackSeeded = true;
        }
      }
    } catch (error) {
      console.warn(
        `[seed-gateway] score seeding retry: ${(error as Error).message}`,
      );
    }
    await Bun.sleep(100);
  }
})();
