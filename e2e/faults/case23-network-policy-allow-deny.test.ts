// Blocked on jjhub/0002: requires runtime network policy enforcement (denylist/allowlist) on the workspace egress path.
import { describe, test } from "bun:test";

describe("case 23: Network-denied task vs policy-allowed task behavior", () => {
  test.skip(
    "Network-denied task vs policy-allowed task behavior (blocked on jjhub/0002 — implement runtime on workspaces)",
    () => {
      // Promote once @jjhub/smithers-runtime-workspace enforces
      // the network capability from the jjhub/0001 contract.
    },
  );
});
