// Soak case: gated on SMITHERS_E2E_SOAK=1 AND on an in-test driver for the cron loop in apps/cli/src/scheduler.js.
import { describe, test } from "bun:test";

const SOAK_ENABLED = process.env.SMITHERS_E2E_SOAK === "1";

describe("case 29: Repeated cron runs over 2 hours; no stuck scheduler", () => {
  test.skip(
    `Repeated cron runs over 2 hours; no stuck scheduler (soak; even with SMITHERS_E2E_SOAK=1 still skipped until apps/cli/src/scheduler.js exposes an in-test cron driver) [SMITHERS_E2E_SOAK=${SOAK_ENABLED ? "1" : "0"}]`,
    () => {
      // Implementable once apps/cli/src/scheduler.js gains a hook to
      // advance virtual time / pump scheduled triggers from a test.
    },
  );
});
