import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildOneshotWorkflow } from "../src/oneshot/buildOneshotWorkflow.js";
import { loadOneshotConfig } from "../src/oneshot/loadOneshotConfig.js";
import { saveOneshotConfig } from "../src/oneshot/saveOneshotConfig.js";
import { resolveOneshotChain } from "../src/oneshot/resolveOneshotChain.js";
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
            { engine: "kimi", model: "kimi-k2.7-code" },
            { engine: "claude", model: "claude-fable-5" },
            { engine: "claude", model: "claude-opus-4-8" },
        ]);
    });
    test("drops paused Codex and maps model slots", () => {
        expect(resolveOneshotChain(all, { env: { SMITHERS_CODEX_PAUSED: "1" } })[0]).toEqual({ engine: "kimi", model: "kimi-k2.7-code" });
        expect(resolveOneshotChain(all, { model: "terra", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({ engine: "codex", model: "gpt-5.6-terra" });
        expect(resolveOneshotChain(all, { model: "opus", env: { SMITHERS_CODEX_PAUSED: "0" } })[0]).toEqual({ engine: "claude", model: "claude-opus-4-8" });
    });
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
