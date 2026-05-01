// Soak case: gated on SMITHERS_E2E_SOAK=1 AND on jjhub/0002 (long-lived JJHub workspace runtime).
import { describe, test } from "bun:test";

const SOAK_ENABLED = process.env.SMITHERS_E2E_SOAK === "1";

describe("case 30: Long-lived JJHub workspace, repeated runs; stable behavior", () => {
  test.skip(
    `Long-lived JJHub workspace, repeated runs; stable behavior (soak; even with SMITHERS_E2E_SOAK=1 still skipped until jjhub/0002 — implement runtime on workspaces — lands) [SMITHERS_E2E_SOAK=${SOAK_ENABLED ? "1" : "0"}]`,
    () => {
      // Promote once @jjhub/smithers-runtime-workspace is available
      // and a long-lived workspace can be driven from this test.
    },
  );
});
