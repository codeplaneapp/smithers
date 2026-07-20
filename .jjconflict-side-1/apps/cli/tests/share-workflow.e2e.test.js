import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createTempRepo, runSmithers, writeFakeCodexBinary, createExecutableDir } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_SRC_DIR = resolve(import.meta.dir, "../src");

function shareEnv(homeDir, binDir, readmeFixture) {
    return {
        HOME: homeDir,
        CI: "1",
        SMITHERS_NO_SKILL_REFRESH: "1",
        SMITHERS_BACKEND: "sqlite",
        SMITHERS_CLI_SRC_DIR: CLI_SRC_DIR,
        SMITHERS_SHARE_REGISTRY_README: readmeFixture,
        PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
    };
}

// The public CLI dry-run must diff the pack's registry row against an
// EXISTING Packs section (fixture-injected — no network, no gh, no pushes).
test("smithers share --dry-run diffs against an existing Packs section through the real CLI", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    mkdirSync(join(repo.dir, ".smithers", "workflows"), { recursive: true });
    writeFileSync(join(repo.dir, ".smithers", "smithers.toon"), "name: cli-share-pack\ndescription: A pack for CLI dry-run coverage\nrepository: owner/cli-share-pack\n");
    writeFileSync(join(repo.dir, ".smithers", "workflows", "hello.tsx"), "// smithers-description: Says hello\nexport default null;\n");
    const fixture = join(repo.dir, "registry-readme.md");
    writeFileSync(fixture, [
        "# Awesome Smithers",
        "",
        "## Packs",
        "",
        "| Pack | Description | Install | Workflows |",
        "| --- | --- | --- | --- |",
        "| [existing](https://github.com/owner/existing) | Keep me | `smithers add owner/existing` | `w`: W |",
        "",
        "## Other",
        "",
        "Keep this section.",
    ].join("\n"));
    const result = runSmithers(["share", "--dry-run"], { cwd: repo.dir, format: "json", env: shareEnv(repo.dir, binDir, fixture), timeoutMs: 60_000 });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("cli-share-pack");
    // The diff is against the fixture: the existing row survives, ours is added.
    expect(result.stdout).toContain("owner/existing");
    expect(result.stdout).toContain("smithers add owner/cli-share-pack");
    expect(result.stdout).toContain("`hello`: Says hello");
});

// The durable share-pack workflow must EXECUTE (not merely graph) from a
// freshly initialized pack: init → complete the manifest → workflow run
// share-pack dryRun → validate/prepare/share rows all land, staging cleaned.
test("share-pack workflow executes end to end in dry-run from a fresh init", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    const env = shareEnv(repo.dir, binDir, join(repo.dir, "registry-readme.md"));
    writeFileSync(join(repo.dir, "registry-readme.md"), "# Awesome Smithers\n");
    const init = runSmithers(["init"], { cwd: repo.dir, format: "json", env: { ...env, OPENAI_API_KEY: "sk-test" }, timeoutMs: 240_000 });
    expect(init.exitCode, `${init.stdout}\n${init.stderr}`).toBe(0);
    // Complete the scaffolded manifest so the deterministic validate passes
    // and no agent task is needed (CI has no real agents).
    const manifestPath = join(repo.dir, ".smithers", "smithers.toon");
    const manifest = readFileSync(manifestPath, "utf8")
        .replace(/^description: .*$/m, "description: Fresh init share coverage")
        .replace(/^repository: .*$/m, "repository: owner/fresh-share");
    writeFileSync(manifestPath, manifest);
    const run = runSmithers(["workflow", "run", "share-pack", "--input", '{"dryRun":true}', "--run-id", "share-dry"], { cwd: repo.dir, format: "json", env, timeoutMs: 240_000 });
    const debugValidate = runSmithers(["output", "share-dry", "validate-manifest"], { cwd: repo.dir, format: "json", env, timeoutMs: 60_000 });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}\nvalidate: ${debugValidate.stdout}`).toBe(0);
    const output = runSmithers(["output", "share-dry", "output"], { cwd: repo.dir, format: "json", env, timeoutMs: 60_000 });
    expect(output.exitCode, `${output.stdout}\n${output.stderr}`).toBe(0);
    expect(output.stdout.replace(/\s/g, "")).toContain('"validated":true');
    expect(output.stdout.replace(/\s/g, "")).toContain('"prepared":true');
    expect(output.stdout.replace(/\s/g, "")).toContain('"shared":true');
    rmSync(repo.dir, { recursive: true, force: true });
}, 300_000);
