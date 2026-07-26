import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPostFailureAutopsy } from "../src/launchPostFailureAutopsy.js";

/**
 * The async spawn `error` event (bad execPath / ENOENT on the detached child)
 * used to be swallowed by an empty handler, so a consistently-broken autopsy
 * launch was invisible even though the user was told it "launched". It must now
 * surface a single stderr line while keeping the non-throwing contract.
 *
 * Real module, no mocks: a temp workflows dir makes the seeded `post-failure`
 * id resolve, and the spawn/write seams inject a child that emits `error` and a
 * capturing writer.
 */
let root;
let workflowsDir;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autopsy-err-"));
  workflowsDir = join(root, "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(
    join(workflowsDir, "post-failure.tsx"),
    "// smithers-source: seeded\n// smithers-metadata-version: 1\n// smithers-display-name: Post Failure\nexport default () => null;\n",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("surfaces an async spawn error on stderr without throwing", async () => {
  const lines = [];
  // A child stub whose `error` event fires on the next tick, like a real
  // detached spawn failure.
  const fakeChild = {
    unref() {},
    on(event, cb) {
      if (event === "error") setTimeout(() => cb(new Error("spawn ENOENT bad-exec")), 0);
      return fakeChild;
    },
  };

  const result = launchPostFailureAutopsy({
    failedRunId: "failed-run-1",
    workflowPath: null,
    cwd: root,
    env: { HOME: root, PATH: process.env.PATH ?? "", SMITHERS_WORKFLOW_PATHS: workflowsDir },
    spawnFn: () => fakeChild,
    write: (line) => lines.push(line),
  });

  expect(result.launched).toBe(true);
  // The synchronous "launched" line prints first (the error is async).
  expect(lines.some((line) => line.includes("Post-failure autopsy launched:"))).toBe(true);

  await new Promise((resolve) => setTimeout(resolve, 25));

  const failed = lines.find((line) => line.includes("Post-failure autopsy failed to start:"));
  expect(failed).toBeDefined();
  expect(failed).toContain("spawn ENOENT bad-exec");
});
