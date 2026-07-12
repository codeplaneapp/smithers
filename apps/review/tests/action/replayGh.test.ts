import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeProtectedReviewInput } from "../../src/reviewManifest";

const REPLAY = fileURLToPath(new URL("../../action/src/replayGh.ts", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  return {
    repository: "octo/widgets",
    prNumber: 7,
    prView: {
      number: 7,
      url: "https://github.com/octo/widgets/pull/7",
      baseRefName: "main",
      headRefName: "topic",
      headRefOid: "a".repeat(40),
      title: "Change",
      body: "Description",
      state: "OPEN",
      isDraft: false,
      changed_files: 1,
      base: { ref: "main", sha: "b".repeat(40) },
      head: { sha: "a".repeat(40) },
    },
  };
}

function run(root: string, args: string[], input?: string) {
  return spawnSync("bun", [REPLAY, ...args], {
    env: {
      ...process.env,
      SMITHERS_REVIEW_GH_FIXTURE: join(root, "fixture.json"),
      SMITHERS_REVIEW_CAPTURE_PATH: join(root, "capture.json"),
    },
    input,
    encoding: "utf8",
  });
}

describe("offline gh replay boundary", () => {
  test("replays immutable metadata and captures exactly one bounded payload", () => {
    const root = mkdtempSync(join(tmpdir(), "review-replay-"));
    roots.push(root);
    writeProtectedReviewInput(join(root, "fixture.json"), JSON.stringify(fixture()), 1_000_000);
    const viewed = run(root, ["pr", "view", "7"]);
    expect(viewed.status).toBe(0);
    expect(JSON.parse(viewed.stdout)).toMatchObject({ number: 7, headRefOid: "a".repeat(40) });

    const payload = JSON.stringify({ commit_id: "a".repeat(40), event: "COMMENT", body: "review", comments: [] });
    const posted = run(root, ["api", "--method", "POST", "repos/octo/widgets/pulls/7/reviews", "--input", "-"], payload);
    expect(posted.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "capture.json"), "utf8"))).toEqual(JSON.parse(payload));
    const duplicate = run(root, ["api", "--method", "POST", "repos/octo/widgets/pulls/7/reviews", "--input", "-"], JSON.stringify({ replace: true }));
    expect(duplicate.status).toBe(64);
    expect(JSON.parse(readFileSync(join(root, "capture.json"), "utf8"))).toEqual(JSON.parse(payload));
  });

  test("rejects writable or invalid-UTF-8 fixtures", () => {
    const root = mkdtempSync(join(tmpdir(), "review-replay-"));
    roots.push(root);
    const path = join(root, "fixture.json");
    writeFileSync(path, JSON.stringify(fixture()));
    chmodSync(path, 0o644);
    expect(run(root, ["pr", "view", "7"]).status).toBe(64);
    rmSync(path);
    writeFileSync(path, Uint8Array.from([0xff]), { mode: 0o444 });
    expect(run(root, ["pr", "view", "7"]).status).toBe(64);
  });

  test("rejects oversized stdin before creating a capture", () => {
    const root = mkdtempSync(join(tmpdir(), "review-replay-"));
    roots.push(root);
    writeProtectedReviewInput(join(root, "fixture.json"), JSON.stringify(fixture()), 1_000_000);
    const result = run(
      root,
      ["api", "--method", "POST", "repos/octo/widgets/pulls/7/reviews", "--input", "-"],
      `{"body":"${"x".repeat(1_000_001)}"}`,
    );
    expect(result.status).toBe(64);
    expect(existsSync(join(root, "capture.json"))).toBe(false);
  });
});
