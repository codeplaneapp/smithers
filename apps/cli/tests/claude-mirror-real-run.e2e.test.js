import { describe, expect, test } from "bun:test";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

// Real-backend e2e for the `smithers claude ...` protocol behind the Claude
// Code plugin's /workflows mirror: seeds a detached run with a data-dependent
// <Parallel> fan-out, then drives `claude tick` / `claude node-wait` exactly
// the way the mirror script's agents do.

const FANOUT_WORKFLOW = `
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Parallel, Task, Workflow, Sequence } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, outputs } = createSmithers({
  items: z.object({ items: z.array(z.string()) }),
  result: z.object({ value: z.string() }),
});

export default smithers((ctx) => {
  const seed = ctx.outputMaybe("items", { nodeId: "seed" });
  return (
    <Workflow name="mirror-tick-e2e">
      <Sequence label="Plan">
        <Task id="seed" output={outputs.items}>
          {{ items: ["alpha", "beta", "gamma"] }}
        </Task>
        {seed ? (
          <Parallel label="Audit">
            {seed.items.map((it) => (
              <Task id={\`audit-\${it}\`} output={outputs.result}>
                {{ value: it }}
              </Task>
            ))}
          </Parallel>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
`;

/** @param {{ dir: string }} repo @param {string[]} args */
function claudeJson(repo, args) {
  const result = runSmithers(["claude", ...args], { cwd: repo.dir, format: "json" });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.json, result.stdout).toBeTruthy();
  return result.json;
}

const TERMINAL = new Set(["finished", "failed", "cancelled", "continued"]);

describe("claude mirror protocol (real run)", () => {
  test("tick reports phases, nodes, deltas, and outputs; node-wait resolves terminal and vanished nodes", () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write("workflow.tsx", FANOUT_WORKFLOW);

    const runId = "mirror-tick-run";
    const up = runSmithers(["up", "workflow.tsx", "--detach", "--run-id", runId], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(up.exitCode, `${up.stdout}\n${up.stderr}`).toBe(0);
    expect(up.json.runId).toBe(runId);

    // The detached engine creates the store asynchronously, so early ticks
    // can race it (CLI_DB_NOT_FOUND / RUN_NOT_FOUND). Poll until terminal.
    let tick;
    for (let index = 0; index < 150; index += 1) {
      const result = runSmithers(["claude", "tick", runId], { cwd: repo.dir, format: "json" });
      if (result.exitCode === 0 && result.json) {
        tick = result.json;
        if (TERMINAL.has(tick.status)) {
          break;
        }
      }
      Bun.sleepSync(150);
    }
    expect(tick, "run never became visible to claude tick").toBeTruthy();

    // Contract v1 envelope.
    expect(tick.contract).toBe(1);
    expect(tick.runId).toBe(runId);
    expect(tick.status).toBe("finished");
    expect(tick.timedOut).toBe(false);
    expect(tick.seq).toBeGreaterThan(0);
    expect(tick.frameNo).toBeGreaterThanOrEqual(1);
    expect(tick.continuedAs).toBeNull();
    expect(tick.approvals).toEqual([]);
    expect(tick.humanRequests).toEqual([]);
    for (const key of [
      "contract",
      "runId",
      "status",
      "seq",
      "frameNo",
      "timedOut",
      "phases",
      "nodes",
      "changed",
      "outputs",
      "approvals",
      "humanRequests",
      "continuedAs",
    ]) {
      expect(tick, `missing contract field ${key}`).toHaveProperty(key);
    }

    // Phases derive from the persisted frame's real container tree.
    const phaseTitles = tick.phases.map((phase) => phase.title);
    expect(phaseTitles).toContain("Plan");
    expect(phaseTitles).toContain("Audit");

    // Every node, including the data-dependent fan-out, with phase + kind.
    const byId = Object.fromEntries(tick.nodes.map((node) => [node.nodeId, node]));
    expect(byId.seed.phase).toBe("Plan");
    expect(byId.seed.state).toBe("finished");
    expect(byId.seed.kind).toBe("static");
    for (const item of ["alpha", "beta", "gamma"]) {
      expect(byId[`audit-${item}`].phase).toBe("Audit");
      expect(byId[`audit-${item}`].state).toBe("finished");
    }

    // Deltas from seq 0 cover the whole run; outputs carry the useful payload.
    expect(tick.changed).toContain("seed");
    expect(tick.changed).toContain("audit-alpha");
    expect(tick.outputs.seed).toContain("alpha");
    expect(tick.outputs["audit-beta"]).toContain("beta");

    // Cursor semantics: nothing changed after the final seq.
    const idle = claudeJson(repo, ["tick", runId, "--after-seq", String(tick.seq)]);
    expect(idle.changed).toEqual([]);
    expect(idle.outputs).toEqual({});

    // --wait on a terminal run returns immediately, not after the timeout.
    const waited = claudeJson(repo, [
      "tick",
      runId,
      "--after-seq",
      String(tick.seq),
      "--wait",
      "--timeout-ms",
      "30000",
    ]);
    expect(waited.status).toBe("finished");

    // node-wait: the watcher row's single blocking command.
    const nodeWait = claudeJson(repo, ["node-wait", "audit-alpha", "--run-id", runId]);
    expect(nodeWait.contract).toBe(1);
    expect(nodeWait.state).toBe("finished");
    expect(nodeWait.vanished).toBe(false);
    expect(nodeWait.timedOut).toBe(false);
    expect(nodeWait.output).toContain("alpha");

    // A node that never existed resolves as a vanished [skipped] row.
    const vanished = claudeJson(repo, ["node-wait", "no-such-node", "--run-id", runId]);
    expect(vanished.state).toBe("skipped");
    expect(vanished.vanished).toBe(true);

    // Unknown run fails loud with the standard exit code.
    const missing = runSmithers(["claude", "tick", "definitely-not-a-run"], { cwd: repo.dir, format: "json" });
    expect(missing.exitCode).toBe(4);
    // Seeds a real detached run and polls the CLI, so it needs more than
    // Bun's default 5s per-test budget.
  }, 60_000);
});
