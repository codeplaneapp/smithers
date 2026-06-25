import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createTempRepo, pinSqliteBackend } from "../../../packages/smithers/tests/e2e-helpers.js";
import { diffMirrorNodes, eventSignalsFrame, isTerminalRunStatus, nodesFromInspect } from "../src/claude-workflow/mirrorState.js";

const SMITHERS_BIN = resolve(import.meta.dir, "../../../node_modules/.bin/smithers");

function runSmithers(args, options) {
    const result = spawnSync(SMITHERS_BIN, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: options.timeoutMs ?? 120_000,
    });
    let json;
    if (result.status === 0 && result.stdout.trim()) {
        try {
            json = JSON.parse(result.stdout.trim());
        }
        catch {
            json = undefined;
        }
    }
    return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        json,
    };
}

function inspectRun(repo, runId) {
    const result = runSmithers(["inspect", runId, "--format", "json"], { cwd: repo.dir });
    return result.exitCode === 0 ? result.json : null;
}

function events(repo, runId, type) {
    const result = runSmithers(["events", runId, "--type", type, "--json"], { cwd: repo.dir });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("claude workflow mirror real run", () => {
    test("discovers nodes across frames and terminal state from real CLI JSON", () => {
        const repo = createTempRepo();
        pinSqliteBackend(repo.dir);
        repo.write("workflow.tsx", `
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
    <Workflow name="mirror-real">
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
`);

        const runId = "mirror-real-run";
        const up = runSmithers(["up", "workflow.tsx", "--detach", "--run-id", runId, "--format", "json"], {
            cwd: repo.dir,
            timeoutMs: 120_000,
        });
        expect(up.exitCode, `${up.stdout}\n${up.stderr}`).toBe(0);

        const earlyInspect = inspectRun(repo, runId);

        let finalInspect = inspectRun(repo, runId);
        for (let index = 0; index < 80 && !isTerminalRunStatus(finalInspect?.run?.status); index += 1) {
            Bun.sleepSync(100);
            finalInspect = inspectRun(repo, runId);
        }
        expect(finalInspect).toBeTruthy();
        expect(isTerminalRunStatus(finalInspect.run?.status)).toBe(true);

        const graph = runSmithers(["graph", "workflow.tsx", "--run-id", runId, "--emit-claude-workflow", "--out", ".claude/workflows/mirror.mjs", "--mirror-all-nodes", "--format", "json"], {
            cwd: repo.dir,
        });
        expect(graph.exitCode, `${graph.stdout}\n${graph.stderr}`).toBe(0);
        const phasePlan = { phases: graph.json.phases, nodes: graph.json.phaseNodes };
        const later = nodesFromInspect(finalInspect, phasePlan, { mirrorAllNodes: true });
        const laterIds = later.nodes.map((node) => node.nodeId);
        const early = earlyInspect ? nodesFromInspect(earlyInspect, phasePlan, { mirrorAllNodes: true }) : { nodes: [] };
        const earlyIds = early.nodes.map((node) => node.nodeId);
        const baselineIds = earlyIds.length === 0 || earlyIds.includes("audit-alpha") || earlyIds.includes("audit-beta") || earlyIds.includes("audit-gamma")
            ? new Set(["seed"])
            : new Set(earlyIds);
        const diff = diffMirrorNodes(baselineIds, later.nodes);

        expect(laterIds).toContain("seed");
        expect(laterIds).toContain("audit-alpha");
        expect(laterIds).toContain("audit-beta");
        expect(laterIds).toContain("audit-gamma");
        expect(laterIds.some((nodeId) => nodeId.includes("@@"))).toBe(false);
        expect(new Set(diff.added)).toEqual(new Set(["audit-alpha", "audit-beta", "audit-gamma"]));

        const frameSignals = events(repo, runId, "frame").map((event) => eventSignalsFrame(event, -1)).filter(Boolean);
        const nodeEventIds = events(repo, runId, "node").map((event) => event.payload?.nodeId).filter(Boolean);
        expect(frameSignals.some((signal) => signal.kind === "frame")).toBe(true);
        expect(nodeEventIds).toContain("audit-alpha");
        expect(nodeEventIds).toContain("audit-beta");
        expect(nodeEventIds).toContain("audit-gamma");
        expect(later.runStatus).toBe("finished");
    });
});
