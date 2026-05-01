// Blocked on jjhub/0002: requires a JJHub workspace runtime that can suspend/resume with auth-persistent home volume.
import { describe, test } from "bun:test";

describe("case 19: Auth persistence across workspace suspend/resume", () => {
  test.skip(
    "Auth persistence across workspace suspend/resume (blocked on jjhub/0002 — implement runtime on workspaces)",
    () => {
      // Promote once @jjhub/smithers-runtime-workspace lands and exposes
      // suspend/resume + auth-persistent home volume per jjhub/0001 contract.
    },
  );
});
