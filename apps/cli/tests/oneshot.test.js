import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildOneshotWorkflow } from "../src/oneshot/buildOneshotWorkflow.js";
import { buildOneshotChildArgs } from "../src/oneshot/buildOneshotChildArgs.js";
import { loadOneshotConfig } from "../src/oneshot/loadOneshotConfig.js";
import { saveOneshotConfig } from "../src/oneshot/saveOneshotConfig.js";
import { resolveOneshotChain } from "../src/oneshot/resolveOneshotChain.js";
import { rewriteOneshotBooleanValues } from "../src/oneshot/rewriteOneshotBooleanValues.js";
import { cleanStatusLine } from "../src/oneshot/startOneshotStatusUpdater.js";
import { bundleGatewayUiEntry } from "../../../packages/server/src/gatewayUi/bundle.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
const cliEntry = join(repoRoot, "apps/cli/src/index.js");
const tempDirs = [];
const temp = (prefix) => { const path = mkdtempSync(join(tmpdir(), prefix)); tempDirs.push(path); return path; };
afterEach(() => { for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

const availability = (id, usable = true) => ({ id, usable, deprecated: false });

describe("oneshot config", () => {
    test("round trips under SMITHERS_HOME and preserves unknown top-level keys", () => {
        const home = temp("smithers-oneshot-config-");
        writeFileSync(join(home, "config.json"), JSON.stringify({ future: { enabled: true }, version: 7 }));
        const env = { SMITHERS_HOME: home };
        saveOneshotConfig({ review: "on", trivial: "direct", announced: true }, env);
        expect(loadOneshotConfig(env)).toEqual({ review: "on", trivial: "direct", announced: true });
        const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
        expect(raw.future).toEqual({ enabled: true });
        expect(raw.version).toBe(1);
        expect(Bun.file(join(home, "config.json")).stat().then((stat) => stat.mode & 0o777)).resolves.toBe(0o600);
    });

    test("corrupt config falls back to unset defaults", () => {
        const home = temp("smithers-oneshot-corrupt-");
        writeFileSync(join(home, "config.json"), "{broken");
        expect(loadOneshotConfig({ SMITHERS_HOME: home })).toEqual({ review: null, trivial: null, announced: false });
    });
});

describe("oneshot model chain", () => {
    const all = [availability("codex"), availability("kimi"), availability("claude"), availability("opencode")];
    test("uses Sol, Kimi, Fable, Opus priority", () => {
        expect(resolveOneshotChain(all, { env: { SMITHERS_CODEX_PAUSED: "0" } })).toEqual([
            { engine: "codex", model: "gpt-5.6-sol" },
            { engine: "kimi", model: "kimi-code/k3" },
            { engine: "claude", model: "claude-fable-5" },
            { engine: "claude", model: "claude-opus-4-8" },
        ]);
    });
    test("drops paused Codex and maps model slots", () => {
        expect(resolveOneshotChain(all, { env: { SMITHERS_CODEX_PAUSED: "1" } })[0]).toEqual({ engine: "kimi", model: "kimi-code/k3" });
        expect(resolveOneshotChain(all, { model: "terra", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({ engine: "codex", model: "gpt-5.6-terra" });
        expect(resolveOneshotChain(all, { model: "opus", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({ engine: "claude", model: "claude-opus-4-8" });
        expect(resolveOneshotChain(all, { model: "kimi", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({ engine: "kimi", model: "kimi-code/k3" });
        expect(resolveOneshotChain(all, { model: "kimi-code/k3", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({ engine: "kimi", model: "kimi-code/k3" });
    });
    test("maps canonical model ids or requires an explicit engine", () => {
        expect(resolveOneshotChain(all, { model: "gpt-future-codex", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({ engine: "codex", model: "gpt-future-codex" });
        expect(resolveOneshotChain(all, { model: "claude-future", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({ engine: "claude", model: "claude-future" });
        expect(() => resolveOneshotChain(all, { model: "future-model", env: { SMITHERS_CODEX_PAUSED: "0" } })).toThrow("Pass --agent");
        expect(resolveOneshotChain(all, { model: "future-model", agent: "kimi", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({ engine: "kimi", model: "future-model" });
    });
});

describe("oneshot status updater", () => {
    test("cleans narrator output to a single bounded line", () => {
        expect(cleanStatusLine("Editing foo.ts.")).toBe("Editing foo.ts");
        expect(cleanStatusLine("\n- \"Running tests.\"\nsome second line")).toBe("Running tests");
        expect(cleanStatusLine("")).toBeNull();
        expect(cleanStatusLine("   \n  ")).toBeNull();
        expect(cleanStatusLine("x".repeat(200))).toHaveLength(140);
    });
});

test("detached child re-invokes oneshot and forwards launch flags", () => {
    const cliPath = join("root", "cli", "index.js");
    const workspace = join("root", "workspace");
    const goalFile = join(workspace, "goal.txt");
    expect(buildOneshotChildArgs({
        cliPath,
        goal: "focused goal",
        goalFile,
        cwd: workspace,
        review: "on",
        model: "terra",
        agent: "codex",
        open: true,
        startedByHarness: "codex",
        startedBySession: "thread-1",
        startedByPrompt: "launch context",
    })).toEqual([
        cliPath, "oneshot", "--goal-file", goalFile,
        "--cwd", workspace, "--detach", "false", "--open", "true",
        "--review", "on", "--model", "terra", "--agent", "codex",
        "--started-by-harness", "codex", "--started-by-session", "thread-1", "--started-by-prompt", "launch context",
    ]);
});

test("oneshot accepts explicit boolean values for default-true flags", () => {
    expect(rewriteOneshotBooleanValues(["oneshot", "goal", "--detach", "false", "--open=true"]))
        .toEqual(["oneshot", "goal", "--no-detach", "--open"]);
    expect(rewriteOneshotBooleanValues(["oneshot", "goal", "-d", "false", "--open", "false"]))
        .toEqual(["oneshot", "goal", "--no-detach", "--no-open"]);
});

describe("oneshot workflow", () => {
    const agent = { generate: async () => ({ text: "unused" }) };
    test.each([[false, ["implement"]], [true, ["implement", "review"]]])("builds review=%s shape", async (review, taskIds) => {
        const cwd = temp("smithers-oneshot-builder-");
        const workflow = await buildOneshotWorkflow({ cwd, goal: "Make the focused test change", agents: [agent], reviewAgents: [agent], review });
        try {
            const root = workflow.build();
            const children = review ? root.props.children.props.children : [root.props.children];
            expect(children.map((child) => child.props.id)).toEqual(taskIds);
            expect(children.every((child) => child.props.hijack === undefined)).toBe(true);
            expect([...workflow.schemaRegistry.keys()]).toEqual(review ? ["oneshotResult", "oneshotReview"] : ["oneshotResult"]);
            for (const key of workflow.schemaRegistry.keys()) expect(["runId", "nodeId", "iteration", "id", "created_at"]).not.toContain(key);
            expect(root.props.children.type.name).toBe(review ? "Sequence" : "Task");
        } finally { workflow.db.$client.close(); }
    });
});

test("status is JSON and the availability gate fails without supported CLIs", () => {
    const home = temp("smithers-oneshot-cli-");
    const baseEnv = { ...process.env, HOME: home, SMITHERS_HOME: home, PATH: "/usr/bin:/bin" };
    const status = spawnSync(process.execPath, ["run", cliEntry, "oneshot", "--status", "--format", "json"], { cwd: home, env: baseEnv, encoding: "utf8" });
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).usableAgents).toEqual([]);
    const red = spawnSync(process.execPath, ["run", cliEntry, "oneshot", "fix the thing", "--detach", "false", "--open", "false", "--format", "json"], { cwd: home, env: baseEnv, encoding: "utf8" });
    expect(red.status).not.toBe(0);
    expect(`${red.stdout}${red.stderr}`).toContain("NO_USABLE_AGENTS");
}, 30_000);

test("oneshot UI bundles for the browser", async () => {
    const body = await bundleGatewayUiEntry({ entry: join(repoRoot, "apps/cli/src/oneshot/oneshot-ui.tsx") }, new Map());
    expect(body).toContain("Oneshot");
    expect(body.length).toBeGreaterThan(1000);
}, 60_000);

test("workspace override receives goal, review, and model input", () => {
    const cwd = temp("smithers-oneshot-override-");
    const workflowDir = join(cwd, ".smithers", "workflows");
    const binDir = join(cwd, "bin");
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const fakeCodex = join(binDir, process.platform === "win32" ? "codex.cmd" : "codex");
    writeFileSync(fakeCodex, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCodex, 0o755);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ type: "module", dependencies: { "smithers-orchestrator": "workspace:*", zod: "*" } }));
    const receipt = join(cwd, "override-input.json");
    writeFileSync(join(workflowDir, "oneshot.tsx"), `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "${pathToFileURL(join(repoRoot, "packages/smithers/src/index.js")).href}";
import { z } from "${pathToFileURL(join(repoRoot, "node_modules/zod/index.js")).href}";
const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ goal: z.string(), review: z.enum(["on", "off"]), model: z.string() }),
  receipt: z.object({ ok: z.boolean() }),
});
export default smithers((ctx) => <Workflow name="custom-oneshot"><Task id="record" output={outputs.receipt}>{async () => {
  await Bun.write(${JSON.stringify(receipt)}, JSON.stringify(ctx.input));
  return { ok: true };
}}</Task></Workflow>);
`);
    const result = spawnSync(process.execPath, ["run", cliEntry, "oneshot", "use the override", "--detach", "false", "--open", "false", "--review", "on", "--model", "terra", "--format", "json"], {
        cwd,
        env: { ...process.env, SMITHERS_HOME: join(cwd, "home"), SMITHERS_NO_SKILL_REFRESH: "1", OPENAI_API_KEY: "test", PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
        encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`override run exited ${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    if (!existsSync(receipt)) throw new Error(`override produced no receipt\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ goal: "use the override", review: "on", model: "terra" });
}, 30_000);
