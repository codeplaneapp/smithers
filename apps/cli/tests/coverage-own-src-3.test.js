import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { regenerateAgentsTsIfPresent } from "../src/agent-commands/regenerateAgentsTsIfPresent.js";
import { launchPostFailureAutopsy } from "../src/launchPostFailureAutopsy.js";
import { formatOutputValue } from "../src/monitor-ui/monitorModel.ts";
import { resolveSmithersDocsSource } from "../src/docs-command.js";
import { installCuratedSkill, resolveSkillSource } from "../src/installCuratedSkill.js";

const tempDirs = [];
function tempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}
afterEach(() => {
    while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("regenerateAgentsTsIfPresent", () => {
    test("no .smithers/agents.ts in cwd → nothing to rewrite", () => {
        const cwd = tempDir("regen-none-");
        const result = regenerateAgentsTsIfPresent(cwd);
        expect(result).toEqual({
            rewritten: false,
            path: null,
            reason: "no .smithers/agents.ts in cwd",
        });
    });

    test("hand-edited agents.ts (no sentinel) is left untouched", () => {
        const cwd = tempDir("regen-edited-");
        mkdirSync(join(cwd, ".smithers"), { recursive: true });
        const path = join(cwd, ".smithers", "agents.ts");
        writeFileSync(path, "// my own hand-written agents\nexport default {};\n", "utf8");
        const result = regenerateAgentsTsIfPresent(cwd);
        expect(result.rewritten).toBe(false);
        expect(result.path).toBe(path);
        expect(result.reason).toContain("edited by hand");
        // File is unchanged.
        expect(readFileSync(path, "utf8")).toContain("hand-written");
    });

    test("stale generated agents.ts is rewritten; a second pass is a no-op", () => {
        const cwd = tempDir("regen-stale-");
        const agentsDir = join(cwd, ".smithers", "agents");
        mkdirSync(agentsDir, { recursive: true });
        // A scaffold file present so the scaffoldProviderIds filter selects it.
        writeFileSync(join(agentsDir, "codex.ts"), "export default {};\n", "utf8");
        const path = join(cwd, ".smithers", "agents.ts");
        // Sentinel present but deliberately stale content → regeneration changes it.
        writeFileSync(path, "// smithers-source: generated\n// STALE PLACEHOLDER\n", "utf8");

        const first = regenerateAgentsTsIfPresent(cwd);
        expect(first.rewritten).toBe(true);
        expect(first.path).toBe(path);
        const regenerated = readFileSync(path, "utf8");
        expect(regenerated.startsWith("// smithers-source: generated")).toBe(true);
        expect(regenerated).not.toContain("STALE PLACEHOLDER");

        // The file now equals the canonical output → the second pass reports no changes.
        const second = regenerateAgentsTsIfPresent(cwd);
        expect(second).toEqual({ rewritten: false, path, reason: "no changes" });
        expect(readFileSync(path, "utf8")).toBe(regenerated);
    }, 30000); // first call pays one-time scaffold generation cost; > default 5s under load
});

describe("launchPostFailureAutopsy guard branches", () => {
    test("no failedRunId → no-run-id", () => {
        expect(launchPostFailureAutopsy({ failedRunId: null })).toEqual({ launched: false, reason: "no-run-id" });
    });

    test("enabled:false → flag-disabled", () => {
        expect(launchPostFailureAutopsy({ failedRunId: "r", enabled: false })).toEqual({ launched: false, reason: "flag-disabled" });
    });

    test("SMITHERS_POST_FAILURE=0 → env-disabled", () => {
        expect(
            launchPostFailureAutopsy({ failedRunId: "r", env: { SMITHERS_POST_FAILURE: "0" } }),
        ).toEqual({ launched: false, reason: "env-disabled" });
    });

    test("failing workflow is itself an ops workflow → ops-workflow (recursion guard)", () => {
        const result = launchPostFailureAutopsy({
            failedRunId: "r",
            workflowPath: "/somewhere/.smithers/workflows/post-failure.tsx",
            env: {},
        });
        expect(result).toEqual({ launched: false, reason: "ops-workflow" });
    });

    test("post-failure workflow not installed → not-installed CTA via the default stderr writer", () => {
        const home = tempDir("autopsy-empty-home-");
        const emptyWfDir = tempDir("autopsy-empty-wf-");
        const originalWrite = process.stderr.write;
        let captured = "";
        // Exercise the default `write` arrow (no override) → process.stderr.
        process.stderr.write = (chunk) => { captured += String(chunk); return true; };
        try {
            const result = launchPostFailureAutopsy({
                failedRunId: "failed-x",
                cwd: tempDir("autopsy-empty-cwd-"),
                // Empty explicit path → resolveWorkflow("post-failure") throws → not-installed.
                env: { SMITHERS_WORKFLOW_PATHS: emptyWfDir, HOME: home, PATH: process.env.PATH ?? "" },
            });
            expect(result).toEqual({ launched: false, reason: "not-installed" });
        } finally {
            process.stderr.write = originalWrite;
        }
        expect(captured).toContain("post-failure workflow is not installed");
        expect(captured).toContain("targetRunId");
    });
});

describe("launchPostFailureAutopsy launch path (injected spawn)", () => {
    function installedWorkflowEnv() {
        const wfDir = tempDir("autopsy-wf-");
        const home = tempDir("autopsy-home-");
        // A resolvable `post-failure` workflow on the explicit workflow path.
        writeFileSync(join(wfDir, "post-failure.tsx"), "export default {};\n", "utf8");
        return {
            cwd: tempDir("autopsy-cwd-"),
            env: { SMITHERS_WORKFLOW_PATHS: wfDir, HOME: home, PATH: process.env.PATH ?? "" },
        };
    }

    test("spawns the autopsy detached and reports the launched run id", () => {
        const { cwd, env } = installedWorkflowEnv();
        const spawnArgs = [];
        const closedFds = [];
        let errorHandler;
        const lines = [];
        const spawnFn = (cmd, args, options) => {
            spawnArgs.push({ cmd, args, options });
            return {
                unref() {},
                on(event, cb) { if (event === "error") errorHandler = cb; },
            };
        };
        const result = launchPostFailureAutopsy({
            failedRunId: "failed-99",
            workflowPath: "workflow.tsx",
            cwd,
            env,
            cliPath: "/fake/index.js",
            spawnFn,
            openFn: () => 91,
            closeFn: (fd) => closedFds.push(fd),
            write: (line) => lines.push(line),
        });
        expect(result.launched).toBe(true);
        expect(result.autopsyRunId).toStartWith("post-failure-");
        expect(result.logFile).toEndWith(".log");
        expect(spawnArgs).toHaveLength(1);
        expect(spawnArgs[0].args).toContain("up");
        expect(spawnArgs[0].args).toContain("--run-id");
        expect(spawnArgs[0].options).toMatchObject({ detached: true });
        expect(spawnArgs[0].options.stdio).toEqual(["ignore", 91, 91]);
        expect(spawnArgs[0].options.env.SMITHERS_POST_FAILURE).toBe("0");
        expect(closedFds).toEqual([91]);
        expect(lines.join("")).toContain("Post-failure autopsy launched");

        // The async spawn `error` handler surfaces a late ENOENT on stderr.
        expect(typeof errorHandler).toBe("function");
        errorHandler(new Error("late boom"));
        expect(lines.join("")).toContain("failed to start: late boom");
    });

    test("tolerates a child without an `on` method (no error subscription)", () => {
        const { cwd, env } = installedWorkflowEnv();
        const lines = [];
        const result = launchPostFailureAutopsy({
            failedRunId: "failed-1",
            cwd,
            env,
            spawnFn: () => ({ unref() {} }),
            write: (line) => lines.push(line),
        });
        expect(result.launched).toBe(true);
        expect(lines.join("")).toContain("autopsy launched");
    });

    test("a spawn that throws → spawn-failed", () => {
        const { cwd, env } = installedWorkflowEnv();
        const closedFds = [];
        const result = launchPostFailureAutopsy({
            failedRunId: "failed-2",
            cwd,
            env,
            spawnFn: () => { throw new Error("no execPath"); },
            openFn: () => 92,
            closeFn: (fd) => closedFds.push(fd),
            write: () => {},
        });
        expect(result).toEqual({ launched: false, reason: "spawn-failed" });
        expect(closedFds).toEqual([92]);
    });

    test("safeWrite swallows a throwing writer without breaking the launch", () => {
        const { cwd, env } = installedWorkflowEnv();
        const result = launchPostFailureAutopsy({
            failedRunId: "failed-3",
            cwd,
            env,
            spawnFn: () => ({ unref() {} }),
            write: () => { throw new Error("stderr closed"); },
        });
        // The throwing writer is swallowed by safeWrite → launch still succeeds.
        expect(result.launched).toBe(true);
    });
});

describe("monitorModel.formatOutputValue JSON.stringify failure", () => {
    test("falls back to String(value) when the value cannot be JSON-stringified", () => {
        // A bigint reaches the stringify branch (not a string, not undefined) and
        // JSON.stringify throws on bigint → the catch returns String(value).
        expect(formatOutputValue(10n)).toBe("10");
    });
});

describe("resolveSmithersDocsSource fallback + local override", () => {
    test("an invalid package version falls back to the latest (unversioned) URL", () => {
        // versionedDocsUrl → normalizeDocsVersion throws on a non-semver version,
        // so the catch swaps in the LATEST_DOCS_BASE_URL/<file> fallback.
        const result = resolveSmithersDocsSource({ file: "llms.txt", packageVersion: "not-a-semver" });
        expect(result.kind).toBe("remote");
        expect(result.url).toContain("llms.txt");
        expect(result.url).not.toContain("-vnot-a-semver");
    });

    test("returns the on-disk copy when a local docs root contains the file", () => {
        const root = tempDir("docs-local-");
        writeFileSync(join(root, "llms.txt"), "local docs\n", "utf8");
        const result = resolveSmithersDocsSource({
            file: "llms.txt",
            packageVersion: "0.28.0",
            localDocsRoots: [root],
        });
        expect(result.kind).toBe("local");
        expect(result.path).toBe(join(root, "llms.txt"));
    });

    test("a local docs root that lacks the file is skipped, yielding the remote source", () => {
        // The loop iterates (existsSync is false for this root) then falls
        // through to the remote result — covers the non-matching loop body.
        const emptyRoot = tempDir("docs-empty-");
        const result = resolveSmithersDocsSource({
            file: "llms.txt",
            packageVersion: "0.28.0",
            localDocsRoots: [emptyRoot],
        });
        expect(result.kind).toBe("remote");
        expect(result.url).toContain("llms-v0.28.0.txt");
    });
});

describe("installCuratedSkill source resolution + copy failure", () => {
    test("resolveSkillSource() with no override resolves the bundled (packaged/monorepo) skill", () => {
        // The default candidate list (no override) resolves the real SKILL.md +
        // llms-full.txt that ship beside the CLI / in the monorepo.
        const source = resolveSkillSource();
        expect(source).not.toBeNull();
        expect(source.skillMd).toContain("SKILL.md");
        expect(source.llmsFull).toContain("llms-full.txt");
    });

    test("resolveSkillSource(override) returns null when the override dir has no skill files", () => {
        const empty = tempDir("skill-empty-");
        expect(resolveSkillSource(empty)).toBeNull();
    });

    test("a per-agent copy failure is recorded in skipped and never throws", () => {
        const home = tempDir("skill-home-");
        const source = tempDir("skill-src-");
        writeFileSync(join(source, "SKILL.md"), "# skill\n", "utf8");
        writeFileSync(join(source, "llms-full.txt"), "docs\n", "utf8");
        // Pre-create the destination SKILL.md as a DIRECTORY so copyFileSync
        // throws EISDIR → the per-agent try/catch records it in `skipped`.
        mkdirSync(join(home, ".claude", "skills", "smithers", "SKILL.md"), { recursive: true });
        const result = installCuratedSkill({
            homeDir: home,
            sourceDir: source,
            detections: [{ id: "claude", hasBinary: true, hasAuthSignal: false, hasApiKeySignal: false }],
            targets: ["claude"],
        });
        expect(result.installed).toHaveLength(0);
        expect(result.skipped.map((s) => s.agent)).toContain("Claude Code");
        expect(result.skipped[0].reason.length).toBeGreaterThan(0);
    });
});
