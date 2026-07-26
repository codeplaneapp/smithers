import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";

// Cross-feature combo: <Subflow mode="childRun"> under a gateway-started
// parent. The parent is stamped public by Gateway.startRun; the child run row
// is written by the engine (`executeChildWorkflow` -> `runWorkflow`), which
// never passes `config.gatewaySystem`. The listing layer's visibility filter
// is fail-closed on the stamp, so this fixture reproduces exactly what the
// gateway reads back for the run list the UI renders.
function createDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  ensureSmithersTables(db);
  return { sqlite, adapter: new SmithersDb(db) };
}

const now = 1_700_000_000_000;

/** Config a gateway-launched parent gets (Gateway.startRun stamps the boolean). */
const gatewayParentConfig = JSON.stringify({
  gatewayWorkflowKey: "main",
  gatewayTriggeredBy: "test",
  gatewaySystem: false,
  maxConcurrency: 4,
  rootDir: "/tmp/x",
  allowNetwork: false,
});

/**
 * Config the engine writes for a `<Subflow mode="childRun">` child. There is no
 * `gatewaySystem` key anywhere in this object because `executeChildWorkflow`
 * forwards no `config` to `runWorkflow`.
 */
const engineChildConfig = JSON.stringify({
  maxConcurrency: 4,
  rootDir: "/tmp/x",
  allowNetwork: false,
  maxOutputBytes: 1_000_000,
  toolTimeoutMs: 600_000,
});

const runRow = (runId, extra = {}) => ({
  runId,
  workflowName: "workflow",
  status: "finished",
  createdAtMs: now,
  ...extra,
});

describe("xcombo child-run visibility: parent + <Subflow> child in the run list", () => {
  test("a child run of a public parent is listed alongside its parent", async () => {
    const { adapter } = createDb();
    await adapter.insertRun(runRow("parent", { createdAtMs: now, configJson: gatewayParentConfig }));
    await adapter.insertRun(
      runRow("parent:child:review:0", {
        createdAtMs: now + 1,
        parentRunId: "parent",
        configJson: engineChildConfig,
      }),
    );

    // The DB knows the linkage.
    const descendants = await adapter.listRunDescendants("parent");
    expect(descendants.map((row) => row.runId)).toEqual(["parent", "parent:child:review:0"]);

    // ...but the visibility filter the gateway applies to every ordinary list
    // drops the child, because the engine never stamps `gatewaySystem` on a
    // child run and the filter is fail-closed. A child of a visible parent
    // must be visible: it is the run the user is asking about when they say
    // "show me the sub-runs of my run".
    const listed = await adapter.listRuns(50, undefined, undefined, { includeSystem: false });
    expect(listed.map((row) => row.runId).sort()).toEqual(["parent", "parent:child:review:0"]);
  });

  test("child rows carry parentRunId through listRuns so a tree can be built", async () => {
    const { adapter } = createDb();
    await adapter.insertRun(runRow("parent", { configJson: gatewayParentConfig }));
    await adapter.insertRun(
      runRow("parent:child:review:0", {
        createdAtMs: now + 1,
        parentRunId: "parent",
        configJson: engineChildConfig,
      }),
    );

    const rows = await adapter.listRuns(50);
    const child = rows.find((row) => row.runId === "parent:child:review:0");
    expect(child?.parentRunId).toBe("parent");
    const parent = rows.find((row) => row.runId === "parent");
    expect(parent?.parentRunId ?? null).toBeNull();
  });

  test("grandchildren of a public parent survive the ordinary visibility filter", async () => {
    const { adapter } = createDb();
    await adapter.insertRun(runRow("parent", { configJson: gatewayParentConfig }));
    await adapter.insertRun(
      runRow("child", { createdAtMs: now + 1, parentRunId: "parent", configJson: engineChildConfig }),
    );
    await adapter.insertRun(
      runRow("grandchild", { createdAtMs: now + 2, parentRunId: "child", configJson: engineChildConfig }),
    );

    const listed = await adapter.listRuns(50, undefined, undefined, { includeSystem: false });
    expect(listed.map((row) => row.runId).sort()).toEqual(["child", "grandchild", "parent"]);
  });
});
