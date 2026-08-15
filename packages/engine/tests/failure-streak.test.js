import { describe, expect, test } from "bun:test";
import { computeIdenticalFailureStreak } from "../src/failure-streak.js";
import { buildRunRecoveryCommands } from "../src/run-failure-recovery.js";

function failedAttempt(errorJson, metaJson) {
  return {
    state: "failed",
    errorJson: JSON.stringify(errorJson),
    metaJson: metaJson ? JSON.stringify(metaJson) : null,
  };
}

const CONTRACT_ERROR = {
  code: "CONTRACT_VIOLATION",
  message: "Diagram login-flow changed its planned participant ordering.",
};

describe("computeIdenticalFailureStreak (#1500)", () => {
  test("counts the current failure plus consecutive identical priors", () => {
    const signature = "CONTRACT_VIOLATION:Diagram login-flow changed its planned participant ordering.";
    const priors = [failedAttempt(CONTRACT_ERROR), failedAttempt(CONTRACT_ERROR)];
    expect(computeIdenticalFailureStreak(priors, signature)).toBe(3);
  });

  test("a different prior signature ends the streak", () => {
    const signature = "CONTRACT_VIOLATION:Diagram login-flow changed its planned participant ordering.";
    const priors = [
      failedAttempt(CONTRACT_ERROR),
      failedAttempt({ code: "AGENT_CLI_ERROR", message: "stream interrupted" }),
      failedAttempt(CONTRACT_ERROR),
    ];
    expect(computeIdenticalFailureStreak(priors, signature)).toBe(2);
  });

  test("a non-failed attempt ends the streak", () => {
    const signature = "CONTRACT_VIOLATION:Diagram login-flow changed its planned participant ordering.";
    const priors = [failedAttempt(CONTRACT_ERROR), { state: "finished", errorJson: null, metaJson: null }];
    expect(computeIdenticalFailureStreak(priors, signature)).toBe(2);
  });

  test("a quota attempt ends the streak", () => {
    const signature = "CONTRACT_VIOLATION:Diagram login-flow changed its planned participant ordering.";
    const priors = [
      failedAttempt(CONTRACT_ERROR),
      failedAttempt({ code: "AGENT_QUOTA_EXCEEDED", message: "rate limited" }),
      failedAttempt(CONTRACT_ERROR),
    ];
    expect(computeIdenticalFailureStreak(priors, signature)).toBe(2);
  });

  test("paths and ids in priors normalize to the same signature", () => {
    const signature = "TASK_FAILED:ENOENT: no such file or directory, statx '<path>'";
    const priors = [
      failedAttempt({
        code: "TASK_FAILED",
        message: "ENOENT: no such file or directory, statx '/var/folders/x/run-1/snapshot.json'",
      }),
      failedAttempt({
        code: "TASK_FAILED",
        message: "ENOENT: no such file or directory, statx '/var/folders/y/run-2/snapshot.json'",
      }),
    ];
    expect(computeIdenticalFailureStreak(priors, signature)).toBe(3);
  });

  test("unparseable prior error rows end the streak instead of throwing", () => {
    const priors = [{ state: "failed", errorJson: "not json", metaJson: null }];
    expect(computeIdenticalFailureStreak(priors, "X:y")).toBe(1);
  });
});

describe("buildRunRecoveryCommands (#1500 §4)", () => {
  test("always offers resume; replay only with a frame", () => {
    const withFrame = buildRunRecoveryCommands({
      runId: "run-1",
      workflowPath: "wf.tsx",
      frameNo: 41,
      checkpointSeq: 9,
    });
    expect(withFrame.resume).toBe("smithers up wf.tsx --run-id run-1 --resume true");
    expect(withFrame.replay).toBe("smithers replay wf.tsx --run-id run-1 --frame 41");

    const noFrame = buildRunRecoveryCommands({ runId: "run-1", workflowPath: "wf.tsx" });
    expect(noFrame.resume).toContain("--resume true");
    expect(noFrame.replay).toBeUndefined();
  });

  test("falls back to a placeholder when the workflow path is unknown", () => {
    const commands = buildRunRecoveryCommands({ runId: "run-1", workflowPath: null, frameNo: 3 });
    expect(commands.resume).toBe("smithers up <workflow> --run-id run-1 --resume true");
  });

  test("shell-escapes paths with spaces", () => {
    const commands = buildRunRecoveryCommands({ runId: "run-1", workflowPath: "my workflows/wf.tsx" });
    expect(commands.resume).toContain("'my workflows/wf.tsx'");
  });
});
