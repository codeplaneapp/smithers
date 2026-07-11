import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  materializeArtifact,
  packArtifact,
  validateArtifact,
} from "./sota-maintenance-artifact.mjs";

const REPOSITORY = "smithersai/smithers";
const RUN_ID = "12345";
const RUN_ATTEMPT = "1";
const WORKFLOW_PATH = resolve(import.meta.dir, "../.github/workflows/sota-research.yml");
const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "smithers-maintenance-artifact-"));
  roots.push(root);
  const base = resolve(root, "base");
  const source = resolve(root, "source");
  const publisher = resolve(root, "publisher");
  const artifact = resolve(root, "artifact");
  mkdirSync(resolve(base, "docs"), { recursive: true });
  mkdirSync(resolve(base, "scripts"), { recursive: true });
  writeFileSync(resolve(base, "docs/existing.mdx"), "before\n");
  writeFileSync(resolve(base, "scripts/remove.mjs"), "remove me\n");
  git(base, ["init", "-q"]);
  git(base, ["add", "."]);
  git(base, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base"]);
  const baseSha = git(base, ["rev-parse", "HEAD"]);
  cpSync(base, source, { recursive: true, filter: (path) => !path.endsWith("/.git") });
  git(root, ["clone", "-q", base, publisher]);
  return { root, base, source, publisher, artifact, baseSha };
}

function pack(paths: ReturnType<typeof fixture>) {
  return packArtifact({
    baseDir: paths.base,
    sourceDir: paths.source,
    outputDir: paths.artifact,
    repository: REPOSITORY,
    baseSha: paths.baseSha,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SOTA maintenance publication artifact", () => {
  test("keeps scheduled analysis credentialless and publishes only successful runs", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    expect(workflow).not.toContain("CODEX_AUTH_JSON");
    expect(workflow).not.toContain("auth.json");
    expect(workflow).not.toContain("--allow-network");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(
      "if: needs.analyze.result == 'success' && needs.analyze.outputs.has_changes == 'true'",
    );
    expect(workflow).not.toContain("if: always() && needs.analyze.outputs.has_changes");
  });

  test("packages, binds, hashes, and materializes only allowlisted changes", () => {
    const paths = fixture();
    writeFileSync(resolve(paths.source, "docs/existing.mdx"), "after\n");
    writeFileSync(resolve(paths.source, "scripts/new.mjs"), "export const changed = true;\n");
    chmodSync(resolve(paths.source, "scripts/new.mjs"), 0o755);
    rmSync(resolve(paths.source, "scripts/remove.mjs"));

    const manifest = pack(paths);
    expect(manifest.files.map((file) => [file.path, file.mode])).toEqual([
      ["docs/existing.mdx", "100644"],
      ["scripts/new.mjs", "100755"],
    ]);
    expect(manifest.deletions).toEqual(["scripts/remove.mjs"]);
    expect(manifest.baseSha).toBe(paths.baseSha);

    materializeArtifact({
      artifactDir: paths.artifact,
      checkoutDir: paths.publisher,
      repository: REPOSITORY,
      baseSha: paths.baseSha,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
    });
    expect(readFileSync(resolve(paths.publisher, "docs/existing.mdx"), "utf8")).toBe("after\n");
    expect(readFileSync(resolve(paths.publisher, "scripts/new.mjs"), "utf8")).toContain("changed = true");
    expect(git(paths.publisher, ["diff", "--cached", "--name-only"]).split("\n")).toEqual([
      "docs/existing.mdx",
      "scripts/new.mjs",
      "scripts/remove.mjs",
    ]);
  });

  test("rejects artifacts whose run or base binding does not match", () => {
    const paths = fixture();
    writeFileSync(resolve(paths.source, "docs/existing.mdx"), "after\n");
    pack(paths);
    expect(() =>
      validateArtifact({
        artifactDir: paths.artifact,
        repository: REPOSITORY,
        baseSha: "f".repeat(40),
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
      }),
    ).toThrow(/base SHA binding/);
    expect(() =>
      validateArtifact({
        artifactDir: paths.artifact,
        repository: REPOSITORY,
        baseSha: paths.baseSha,
        runId: RUN_ID,
        runAttempt: "2",
      }),
    ).toThrow(/run attempt binding/);
  });

  test("rejects undeclared files, symbolic links, and paths outside the allowlist", () => {
    const paths = fixture();
    writeFileSync(resolve(paths.source, "docs/existing.mdx"), "after\n");
    pack(paths);
    writeFileSync(resolve(paths.artifact, "extra"), "not declared\n");
    expect(() =>
      validateArtifact({
        artifactDir: paths.artifact,
        repository: REPOSITORY,
        baseSha: paths.baseSha,
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
      }),
    ).toThrow(/unexpected files/);

    rmSync(resolve(paths.artifact, "extra"));
    rmSync(resolve(paths.artifact, "files/docs/existing.mdx"));
    symlinkSync(resolve(paths.source, "docs/existing.mdx"), resolve(paths.artifact, "files/docs/existing.mdx"));
    expect(() =>
      validateArtifact({
        artifactDir: paths.artifact,
        repository: REPOSITORY,
        baseSha: paths.baseSha,
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
      }),
    ).toThrow(/symbolic links/);

    const manifestPath = resolve(paths.artifact, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files[0].path = ".github/workflows/injected.yml";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() =>
      validateArtifact({
        artifactDir: paths.artifact,
        repository: REPOSITORY,
        baseSha: paths.baseSha,
        runId: RUN_ID,
        runAttempt: RUN_ATTEMPT,
      }),
    ).toThrow(/outside the publication allowlist/);
  });
});
