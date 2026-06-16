import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createExecutableDir, createTempRepo, runSmithers, writeFakeCodexBinary, writeTestWorkflow, } from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * Minimal discoverable workflow file. Discovery only reads the file for metadata
 * comments (it never imports it), so a stub is enough for `workflow list`.
 *
 * @param {string} displayName
 */
function stubWorkflow(displayName) {
    return [
        `// smithers-display-name: ${displayName}`,
        "export default null;",
        "",
    ].join("\n");
}

test("workflow list merges the global ~/.smithers pack, local taking precedence", () => {
    // Global pack lives at $SMITHERS_HOME (the canonical ~/.smithers).
    const globalHome = createTempRepo();
    const smithersHome = join(globalHome.dir, ".smithers");
    globalHome.write(".smithers/workflows/ping.tsx", stubWorkflow("Global Ping"));
    globalHome.write(".smithers/workflows/global-only.tsx", stubWorkflow("Global Only"));

    // A separate repo with no local `.smithers` — global workflows must still show.
    const repo = createTempRepo();
    const env = { SMITHERS_HOME: smithersHome };

    const before = runSmithers(["workflow", "list"], { cwd: repo.dir, format: "json", env });
    expect(before.exitCode).toBe(0);
    /** @type {Array<{ id: string; scope: string; entryFile: string }>} */
    const globalWorkflows = before.json.workflows;
    const ids = globalWorkflows.map((w) => w.id);
    expect(ids).toContain("ping");
    expect(ids).toContain("global-only");
    expect(globalWorkflows.find((w) => w.id === "ping")?.scope).toBe("global");
    expect(globalWorkflows.find((w) => w.id === "ping")?.entryFile).toBe(join(smithersHome, "workflows", "ping.tsx"));

    // A local workflow with the same id shadows the global one; global-only stays.
    repo.write(".smithers/workflows/ping.tsx", stubWorkflow("Local Ping"));
    const after = runSmithers(["workflow", "list"], { cwd: repo.dir, format: "json", env });
    expect(after.exitCode).toBe(0);
    /** @type {Array<{ id: string; scope: string; entryFile: string }>} */
    const merged = after.json.workflows;
    const ping = merged.find((w) => w.id === "ping");
    expect(ping?.scope).toBe("local");
    expect(ping?.entryFile).toBe(repo.path(".smithers/workflows/ping.tsx"));
    // The id appears exactly once (local shadows global, not duplicated).
    expect(merged.filter((w) => w.id === "ping")).toHaveLength(1);
    expect(merged.find((w) => w.id === "global-only")?.scope).toBe("global");
});

test("a global workflow runs against the current repo (db lands in cwd)", () => {
    // Put the global pack under a linked temp repo so the global workflow file can
    // resolve `smithers-orchestrator`/`zod` via the parent node_modules.
    const globalHome = createTempRepo();
    const smithersHome = join(globalHome.dir, ".smithers");
    writeTestWorkflow(globalHome, ".smithers/workflows/ping.tsx");

    // Run from a separate repo that has no local `.smithers` of its own.
    const repo = createTempRepo();
    const result = runSmithers(["workflow", "run", "ping"], {
        cwd: repo.dir,
        format: "json",
        env: { SMITHERS_HOME: smithersHome },
        timeoutMs: 120_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.status).toBe("finished");
    // The run db is created in the repo we ran from, not in ~/.smithers.
    expect(repo.exists("smithers.db")).toBe(true);
    expect(existsSync(join(smithersHome, "smithers.db"))).toBe(false);
});

test("smithers init --global scaffolds the canonical ~/.smithers pack (no nested .smithers)", () => {
    const globalHome = createTempRepo();
    const smithersHome = join(globalHome.dir, ".smithers");
    const repo = createTempRepo();

    // `init` requires at least one usable agent (it generates agents.ts from
    // detected agents); without one it exits 4 with NO_USABLE_AGENTS. Stub a
    // fake Codex CLI on PATH + key so the test is deterministic on any host,
    // including CI runners that have no agent CLIs installed (matches the
    // buildInitEnv pattern in init.e2e.test.js).
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);

    const result = runSmithers(["init", "--global", "--no-install"], {
        cwd: repo.dir,
        format: "json",
        env: {
            SMITHERS_HOME: smithersHome,
            HOME: globalHome.dir,
            PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
            OPENAI_API_KEY: "test-openai-key",
            ANTHROPIC_API_KEY: "",
            GEMINI_API_KEY: "",
            GOOGLE_API_KEY: "",
        },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json.rootDir).toBe(smithersHome);
    expect(result.json.install).toMatchObject({ reason: "skip-install" });

    // Pack files land directly under ~/.smithers, with no extra `.smithers` nesting.
    for (const rel of ["package.json", "agents.ts", "agents/claude-code.ts", "prompts/review.mdx"]) {
        expect(existsSync(join(smithersHome, rel))).toBe(true);
    }
    expect(existsSync(join(smithersHome, "workflows", "research.tsx"))).toBe(true);
    expect(existsSync(join(smithersHome, ".smithers"))).toBe(false);
    // It did NOT scaffold a local pack in the cwd repo.
    expect(repo.exists(".smithers")).toBe(false);
});
