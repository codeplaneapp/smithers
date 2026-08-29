import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The review runs under Node, so every module it reaches must resolve there.
 *
 * `bin/smithers-review.mjs` is a Node entry point and the workspace ships
 * TypeScript sources, so Node strips the types and then applies its own ESM
 * resolution: a relative specifier without a file extension throws
 * `ERR_MODULE_NOT_FOUND`. Bun resolves the same specifier, so the rest of this
 * suite, which runs under Bun, cannot see the difference. That is the whole
 * reason this file spawns Node.
 *
 * The modules below are the ones that leave `apps/review` for a workspace
 * package: both import `@smthrs/ui-styleguide`, whose own relative imports have
 * to carry `.ts` for Node to find them. A dependency that drops an extension
 * fails here instead of at the first real review.
 */
const entryPoints = [
  "../src/walkthrough/walkthroughCss.ts",
  "../src/server/landingPage.ts",
  "../src/cli/runReview.ts",
] as const;

describe("the Node runtime resolves every module the review loads", () => {
  for (const entry of entryPoints) {
    test(`node imports ${entry.replace("../src/", "src/")}`, () => {
      const target = fileURLToPath(new URL(entry, import.meta.url));
      const result = spawnSync(
        "node",
        ["--input-type=module", "-e", `await import(${JSON.stringify(target)});`],
        { encoding: "utf8", env: process.env },
      );
      // The message matters as much as the status: ERR_MODULE_NOT_FOUND names
      // the specifier that failed, which is the fix.
      expect(`${result.stderr}`).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(result.status).toBe(0);
    }, 60_000);
  }
});
