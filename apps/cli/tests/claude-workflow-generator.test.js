import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createTempRepo } from "../../../packages/smithers/tests/e2e-helpers.js";

const SMITHERS_BIN = resolve(import.meta.dir, "../../../node_modules/.bin/smithers");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function runSmithersBin(args, options) {
    const result = spawnSync(SMITHERS_BIN, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
    });
    return {
        exitCode: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        json: result.status === 0 ? JSON.parse((result.stdout ?? "").trim()) : undefined,
    };
}

describe("smithers graph --emit-claude-workflow", () => {
    test("emits a deterministic parseable mirror script without absolute paths", () => {
        const repo = createTempRepo();
        repo.write("workflow.tsx", `
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Task, Workflow, Sequence } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, outputs } = createSmithers({
  result: z.object({ text: z.string() }),
});
const agent = { id: "fake", generate: async () => ({ text: "ok" }) };

export default smithers(() => (
  <Workflow name="mirror-test">
    <Sequence label="Review">
      <Task id="review" output={outputs.result} agent={agent}>Review</Task>
    </Sequence>
  </Workflow>
));
`);
        const out = ".claude/workflows/test.mjs";
        const first = runSmithersBin(["graph", "workflow.tsx", "--emit-claude-workflow", "--out", out, "--format", "json"], {
            cwd: repo.dir,
        });
        expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
        const outputPath = join(repo.dir, out);
        const firstBytes = readFileSync(outputPath, "utf8");
        const second = runSmithersBin(["graph", "workflow.tsx", "--emit-claude-workflow", "--out", out, "--format", "json"], {
            cwd: repo.dir,
        });
        expect(second.exitCode, `${second.stdout}\n${second.stderr}`).toBe(0);
        const secondBytes = readFileSync(outputPath, "utf8");

        expect(first.json.outputPath).toBe(outputPath);
        expect(second.json.nodes).toBe(first.json.nodes);
        expect(firstBytes.startsWith("export const meta =")).toBe(true);
        expect(firstBytes).toBe(secondBytes);
        expect(firstBytes.includes(repo.dir)).toBe(false);
        expect(firstBytes.includes("const PHASE_MAP")).toBe(true);
        expect(firstBytes.includes("nodeId).split('@@')[0]")).toBe(true);
        new AsyncFunction(firstBytes.replace("export const meta =", "const meta ="));
    });

    test("emitted script reads runId when the runtime delivers args as a JSON string", async () => {
        const repo = createTempRepo();
        repo.write("workflow.tsx", `
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Task, Workflow } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, outputs } = createSmithers({ result: z.object({ text: z.string() }) });
const agentImpl = { id: "fake", generate: async () => ({ text: "ok" }) };

export default smithers(() => (
  <Workflow name="args-shape">
    <Task id="only" output={outputs.result} agent={agentImpl}>Do</Task>
  </Workflow>
));
`);
        const out = ".claude/workflows/args.mjs";
        const result = runSmithersBin(["graph", "workflow.tsx", "--emit-claude-workflow", "--out", out, "--format", "json"], {
            cwd: repo.dir,
        });
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        // Strip the `export const meta = {...};` block entirely, the way the
        // Workflow runtime does. This guarantees the body never references `meta`
        // (the runtime does not expose it as a body variable).
        const raw = readFileSync(join(repo.dir, out), "utf8");
        const body = raw.replace(/export const meta = \{[\s\S]*?\n\};\n/, "");
        expect(body.includes("meta")).toBe(false);
        // Drive the body with stubbed hooks. discover() resolves terminal so the
        // loop exits immediately; args is a JSON string, as the real runtime sends it.
        const agentStub = async () => ({ runStatus: "finished", nodes: [] });
        const parallelStub = async (thunks) => Promise.all(thunks.map((t) => t()));
        const noop = () => {};
        const fn = new AsyncFunction("agent", "parallel", "phase", "log", "args", body);
        const value = await fn(agentStub, parallelStub, noop, noop, JSON.stringify({ runId: "run-xyz" }));
        expect(value.runId).toBe("run-xyz");

        // A string with no runId must fail loud, not silently mirror nothing.
        await expect(fn(agentStub, parallelStub, noop, noop, "not json")).rejects.toThrow("args.runId is required");
    });

    test("emitted script mirrors final-frame nodes when the run goes terminal", async () => {
        const repo = createTempRepo();
        repo.write("workflow.tsx", `
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Task, Workflow } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, outputs } = createSmithers({ result: z.object({ text: z.string() }) });
const agentImpl = { id: "fake", generate: async () => ({ text: "ok" }) };

export default smithers(() => (
  <Workflow name="late-node">
    <Task id="first" output={outputs.result} agent={agentImpl}>Do</Task>
  </Workflow>
));
`);
        const out = ".claude/workflows/late.mjs";
        const result = runSmithersBin(["graph", "workflow.tsx", "--emit-claude-workflow", "--out", out, "--format", "json"], {
            cwd: repo.dir,
        });
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
        const body = readFileSync(join(repo.dir, out), "utf8").replace(/export const meta = \{[\s\S]*?\n\};\n/, "");

        // Scripted runtime: first discovery shows the run still running with only
        // `first`; the frame wait reports the stream ended (run went terminal); the
        // final discovery surfaces a `late` node that only materialized in the last
        // frame. The mirror must spawn a watcher for `late` before stopping.
        const watcherLabels = [];
        let discovery = 0;
        const agentStub = async (_prompt, opts = {}) => {
            if (opts.label === "Discover Smithers nodes") {
                discovery += 1;
                return discovery === 1
                    ? { runStatus: "running", nodes: [{ nodeId: "first", label: "first", state: "running" }] }
                    : { runStatus: "finished", nodes: [{ nodeId: "first", label: "first", state: "finished" }, { nodeId: "late", label: "late", state: "finished" }] };
            }
            if (opts.label === "Await Smithers frame") {
                return { next: "done" };
            }
            watcherLabels.push(opts.label);
            return "ok";
        };
        const parallelStub = async (thunks) => Promise.all(thunks.map((t) => t()));
        const noop = () => {};
        const fn = new AsyncFunction("agent", "parallel", "phase", "log", "args", body);
        const value = await fn(agentStub, parallelStub, noop, noop, JSON.stringify({ runId: "late-run" }));

        expect(value.mirrored).toContain("first");
        expect(value.mirrored).toContain("late");
        expect(watcherLabels).toContain("late");
    });
});
