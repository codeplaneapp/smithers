import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRelease } from "../lib/release-content/git";
import { normalizeReleaseContentInput } from "../lib/release-content/schemas";

// probeRelease reads package.json and git state from process.cwd(), so build a
// real throwaway git repo whose package.json version (0.26.1) is already
// tagged v0.26.1 — the "tag exists" state that is ambiguous between
// "pnpm version already bumped" and "this version already shipped".
let repoDir: string;
let previousCwd: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
}

beforeAll(() => {
  previousCwd = process.cwd();
  repoDir = mkdtempSync(join(tmpdir(), "release-content-probe-"));
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "probe-fixture", version: "0.26.1" }));
  git("init", "--initial-branch=main");
  git("config", "user.email", "probe@test.local");
  git("config", "user.name", "Probe Fixture");
  git("add", "package.json");
  git("commit", "-m", "v0.26.1");
  git("tag", "v0.26.0");
  git("tag", "v0.26.1");
  process.chdir(repoDir);
});

afterAll(() => {
  process.chdir(previousCwd);
  rmSync(repoDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("probeRelease version resolution", () => {
  test("no version/bump input: an existing v<pkg.version> tag means already bumped — keep it", () => {
    const probe = probeRelease(normalizeReleaseContentInput({}));
    expect(probe.version).toBe("0.26.1");
    expect(probe.bump).toBeNull();
  });

  test("explicit bump wins over the already-bumped tag inference", () => {
    const probe = probeRelease(normalizeReleaseContentInput({ bump: "minor" }));
    expect(probe.version).toBe("0.27.0");
    expect(probe.bump).toBe("minor");
  });

  test("explicit bump=major increments from pkg.version", () => {
    const probe = probeRelease(normalizeReleaseContentInput({ bump: "major" }));
    expect(probe.version).toBe("1.0.0");
  });

  test("explicit version input wins over everything", () => {
    const probe = probeRelease(normalizeReleaseContentInput({ version: "0.30.0", bump: "minor" }));
    expect(probe.version).toBe("0.30.0");
  });

  test("previous release tag is the highest tag strictly below the target", () => {
    const probe = probeRelease(normalizeReleaseContentInput({ bump: "minor" }));
    expect(probe.previousTag).toBe("v0.26.1");
    expect(probe.range).toBe("v0.26.1..HEAD");
  });
});
