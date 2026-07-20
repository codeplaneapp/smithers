import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
    createExecutableDir,
    createTempRepo,
    runSmithers,
    writeFakeCodexBinary,
} from "../../../packages/smithers/tests/e2e-helpers.js";

// The durable `init` workflow is compute-only (smithers-disable-model-invocation)
// so it needs no agent CLIs; the fake codex binary just makes agent detection /
// agents.ts generation succeed on CI. Everything runs with --no-install so the
// tests stay fast and never shell out to `bun install`.
const DURABLE_TIMEOUT_MS = 180_000;

/** @param {string} homeDir */
function buildInitEnv(homeDir) {
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    return {
        HOME: homeDir,
        PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
        OPENAI_API_KEY: "sk-test-openai-key",
        ANTHROPIC_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
    };
}

test("non-interactive re-init runs the seeded init workflow (durable JSON contract)", () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);

    // First init cannot go through the engine (the workflow file is itself a
    // pack file being scaffolded), so it stays imperative.
    const first = runSmithers(["init", "--no-install"], {
        cwd: repo.dir,
        format: "json",
        env,
        timeoutMs: DURABLE_TIMEOUT_MS,
    });
    expect(first.exitCode).toBe(0);
    expect(Array.isArray(first.json.writtenFiles)).toBe(true);
    expect(first.json.durable).toBeUndefined();
    expect(existsSync(join(repo.dir, ".smithers", "workflows", "init.tsx"))).toBe(true);

    // A CLAUDE.md created after the first init must get the smithers guidance
    // block from the DURABLE path too (matching the imperative path).
    repo.write("CLAUDE.md", "# Project instructions\n");

    // Every later non-interactive init upgrades to the durable `init` workflow.
    const second = runSmithers(["init", "--no-install"], {
        cwd: repo.dir,
        format: "json",
        env,
        timeoutMs: DURABLE_TIMEOUT_MS,
    });
    expect(second.exitCode).toBe(0);
    expect(second.json.durable).toBe(true);
    expect(second.json.workflow).toBe("init");
    expect(second.json.status).toBe("finished");
    expect(typeof second.json.runId).toBe("string");
    expect(second.json.runId.length).toBeGreaterThan(0);
    expect(readFileSync(join(repo.dir, "CLAUDE.md"), "utf8")).toContain("smithers:prefer-workflows");
}, DURABLE_TIMEOUT_MS);

test("a broken init workflow falls back to the imperative scaffold with exit 0", () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);

    const first = runSmithers(["init", "--no-install"], {
        cwd: repo.dir,
        format: "json",
        env,
        timeoutMs: DURABLE_TIMEOUT_MS,
    });
    expect(first.exitCode).toBe(0);

    // Corrupt the durable workflow file so its import throws at load.
    repo.write(
        ".smithers/workflows/init.tsx",
        '/** @jsxImportSource smithers-orchestrator */\nthrow new Error("intentionally broken init workflow");\n',
    );

    const broken = runSmithers(["init", "--no-install"], {
        cwd: repo.dir,
        format: "json",
        env,
        timeoutMs: DURABLE_TIMEOUT_MS,
    });
    expect(broken.exitCode).toBe(0);
    // Imperative result shape (not the durable `{ durable, runId, status }`).
    expect(broken.json).toHaveProperty("writtenFiles");
    expect(broken.json.durable).toBeUndefined();
    expect(broken.stderr).toContain("falling back");
}, DURABLE_TIMEOUT_MS);

test("durable re-init honors a persisted agent-doc deselection (AGENTS.md opted out)", () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);

    // First (imperative) init installs the pack incl. workflows/init.tsx.
    const first = runSmithers(["init", "--no-install"], {
        cwd: repo.dir,
        format: "json",
        env,
        timeoutMs: DURABLE_TIMEOUT_MS,
    });
    expect(first.exitCode).toBe(0);

    // Two DISTINCT agent docs (separate files/inodes so the guidance block is not
    // deduped) created after init — both are eligible for the block by default.
    repo.write("CLAUDE.md", "# Claude instructions\n");
    repo.write("AGENTS.md", "# Agents instructions\n");

    // Persist the à-la-carte deselection an interactive init writes when the user
    // unchecks AGENTS.md. This is the real pack-selections.json marker the durable
    // path reads (savePackSelections' format); it lives outside templateFiles so
    // --force never clobbers it.
    repo.write(
        ".smithers/pack-selections.json",
        `${JSON.stringify({ deselectedWorkflows: [], deselectedAgentDocs: ["AGENTS.md"] }, null, 2)}\n`,
    );

    // Durable non-interactive re-init must honor the deselection: CLAUDE.md gets
    // the guidance block, the opted-out AGENTS.md is left untouched.
    const second = runSmithers(["init", "--yes", "--no-install"], {
        cwd: repo.dir,
        format: "json",
        env,
        timeoutMs: DURABLE_TIMEOUT_MS,
    });
    expect(second.exitCode).toBe(0);
    expect(second.json.durable).toBe(true);
    expect(readFileSync(join(repo.dir, "CLAUDE.md"), "utf8")).toContain("smithers:prefer-workflows");
    expect(readFileSync(join(repo.dir, "AGENTS.md"), "utf8")).not.toContain("smithers:prefer-workflows");
}, DURABLE_TIMEOUT_MS);

test("durable re-init with --no-skill does not (re)install the curated skill", () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    // Seed ~/.claude so the curated skill COULD be installed there (agentPresent).
    repo.write(".claude/.keep", "");
    const skillDir = join(repo.dir, ".claude", "skills", "smithers");

    // First init WITHOUT the skill: installs init.tsx but writes no skill.
    const first = runSmithers(["init", "--no-skill", "--no-install"], {
        cwd: repo.dir,
        format: "json",
        env,
        timeoutMs: DURABLE_TIMEOUT_MS,
    });
    expect(first.exitCode).toBe(0);
    expect(existsSync(skillDir)).toBe(false);

    // Durable re-init must honor --no-skill: the seeded workflow defaults
    // refreshSkills to true, so without threading the flag it would install here.
    const second = runSmithers(["init", "--yes", "--no-skill", "--no-install"], {
        cwd: repo.dir,
        format: "json",
        env,
        timeoutMs: DURABLE_TIMEOUT_MS,
    });
    expect(second.exitCode).toBe(0);
    expect(second.json.durable).toBe(true);
    expect(existsSync(skillDir)).toBe(false);
}, DURABLE_TIMEOUT_MS);
