import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { danglingWorkspaceLinkHint } from "../src/bin/danglingWorkspaceLinkHint.js";

/** @type {string[]} */
const tempRoots = [];
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizes with '...and N more' when more than five links are dangling", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-dangling-many-"));
  tempRoots.push(root);
  const scopeDir = join(root, "node_modules", "@smthrs");
  mkdirSync(scopeDir, { recursive: true });
  // Seven dangling links so the shown list (5) is exceeded and the summary
  // "...and N more" line fires.
  for (let i = 0; i < 7; i++) {
    symlinkSync(join(root, "gone", `pkg-${i}`), join(scopeDir, `pkg-${i}`));
  }
  const hint = danglingWorkspaceLinkHint(root);
  expect(hint).not.toBeNull();
  expect(hint).toContain("...and 2 more");
  expect(hint).toContain("7 dangling workspace links");
});
