import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

const previousDisableAutoMain = process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN = "1";
const { __retryTaskCliInternals } = await import("../src/index.js");
if (previousDisableAutoMain === undefined) {
  delete process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
} else {
  process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN = previousDisableAutoMain;
}

describe("retry-task rollback ownership", () => {
  test("surfaces a lost rollback CAS as an aggregate failure", async () => {
    const adapter = {
      updateClaimedRun: () => Effect.succeed(false),
      withTransaction: async (_label, operation) => await Effect.runPromise(operation),
    };
    const snapshot = {
      rootRunId: "run-root",
      runs: [
        {
          run: { runId: "run-root" },
          nodes: [],
          attempts: [],
          outputs: [],
        },
      ],
    };

    let failure;
    try {
      await __retryTaskCliInternals.rollbackFailedRetryResume(
        adapter,
        snapshot,
        { claimOwnerId: "resume-owner", claimHeartbeatAtMs: 123 },
        new Error("resume failed"),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain("database rollback also failed");
    expect(failure.errors[1]).toMatchObject({
      code: "RETRY_TASK_ROLLBACK_OWNERSHIP_LOST",
      message: expect.stringContaining("no longer owned by the resume claim"),
    });
  });
});
