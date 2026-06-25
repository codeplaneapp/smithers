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
});
