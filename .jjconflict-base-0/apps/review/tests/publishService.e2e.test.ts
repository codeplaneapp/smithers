import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { publishWalkthrough } from "../src/cli/publishWalkthrough";

// Live test against the deployed publish service (real network, real R2).
// Opt in with SMITHERS_REVIEW_E2E=1; needs publish credentials in the
// environment or ~/.smithers-review.json.
const enabled = process.env.SMITHERS_REVIEW_E2E === "1" &&
  (Boolean(process.env.SMITHERS_REVIEW_PUBLISH_TOKEN) || existsSync(join(homedir(), ".smithers-review.json")));

describe.skipIf(!enabled)("publish service (live)", () => {
  test(
    "publishes a walkthrough and serves it back verbatim",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "review-publish-"));
      const marker = `publish-e2e-${Date.now()}`;
      const html = `<!doctype html><html><body>${marker}</body></html>`;
      const path = join(dir, "walkthrough.html");
      writeFileSync(path, html);
      try {
        const url = await publishWalkthrough(path);
        expect(url).toMatch(/^https:\/\/.+\/w\/[a-z0-9]+$/);
        const served = await fetch(url);
        expect(served.status).toBe(200);
        expect(served.headers.get("content-type")).toContain("text/html");
        expect(await served.text()).toBe(html);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
