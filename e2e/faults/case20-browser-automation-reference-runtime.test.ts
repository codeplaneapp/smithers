// Blocked on jjhub/0002: requires the reference runtime to provision a per-workspace headless browser (Chromium/Playwright).
import { describe, test } from "bun:test";

describe("case 20: Browser automation task in reference runtime", () => {
  test.skip(
    "Browser automation task in reference runtime (blocked on jjhub/0002 — implement runtime on workspaces)",
    () => {
      // Promote once @jjhub/smithers-runtime-workspace ships the
      // optional `browser` capability from the jjhub/0001 contract.
    },
  );
});
