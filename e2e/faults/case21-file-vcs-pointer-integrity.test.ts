// Blocked on jjhub/0002: requires runtime fs.persist/restore + vcs.pointer backed by jj-native workspace snapshots.
import { describe, test } from "bun:test";

describe("case 21: File + VCS pointer integrity across repeated runs", () => {
  test.skip(
    "File + VCS pointer integrity across repeated runs (blocked on jjhub/0002 — implement runtime on workspaces)",
    () => {
      // Promote once @jjhub/smithers-runtime-workspace exposes
      // fs.persist/restore + vcs.pointer per the jjhub/0001 contract.
    },
  );
});
