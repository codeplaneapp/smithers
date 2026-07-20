import { describe, expect, test } from "bun:test";
import { createProgressReporter } from "../../src/cli/createProgressReporter";

const preparedRow = {
  files: JSON.stringify([
    { id: "review-file-1-src-foo-ts", path: "src/foo.ts" },
    { id: "review-file-2-src-bar-ts", path: "src/bar.ts" },
  ]),
};

function reporterWith(rows: Record<string, Array<Record<string, unknown>>>) {
  const lines: string[] = [];
  const reporter = createProgressReporter({
    loadRows: async () => rows,
    write: (line) => lines.push(line),
  });
  return { reporter, lines };
}

describe("createProgressReporter", () => {
  test("prints per-file lines with counter, path, findings count, and elapsed time", async () => {
    const { reporter, lines } = reporterWith({
      reviewPrompt: [preparedRow],
      agentReview: [
        { nodeId: "review-file-1-src-foo-ts", comments: JSON.stringify([{ path: "src/foo.ts" }, { path: "src/foo.ts" }]) },
        { nodeId: "review-file-2-src-bar-ts", comments: JSON.stringify([{ path: "src/bar.ts" }]) },
      ],
    });

    reporter.onEvent({ type: "NodeStarted", nodeId: "review-file-1-src-foo-ts", timestampMs: 1_000 });
    reporter.onEvent({ type: "NodeStarted", nodeId: "review-file-2-src-bar-ts", timestampMs: 1_000 });
    reporter.onEvent({ type: "NodeFinished", nodeId: "review-file-1-src-foo-ts", timestampMs: 49_000 });
    reporter.onEvent({ type: "NodeFinished", nodeId: "review-file-2-src-bar-ts", timestampMs: 61_000 });
    await reporter.flush();

    expect(lines).toEqual([
      "[1/2] src/foo.ts … 2 findings (48s)",
      "[2/2] src/bar.ts … 1 finding (60s)",
    ]);
  });

  test("reads the real engine shape where files/comments are already-parsed arrays", async () => {
    // loadOutputs returns json-mode columns parsed, not as JSON strings — the
    // reporter must handle that shape or every per-file line degrades to the
    // node id, "[index]", and "done".
    const { reporter, lines } = reporterWith({
      reviewPrompt: [
        {
          files: [
            { id: "review-file-1-src-foo-ts", path: "src/foo.ts" },
            { id: "review-file-2-src-bar-ts", path: "src/bar.ts" },
          ],
        },
      ],
      agentReview: [
        { nodeId: "review-file-1-src-foo-ts", comments: [{ path: "src/foo.ts" }, { path: "src/foo.ts" }] },
        { nodeId: "review-file-2-src-bar-ts", comments: [] },
      ],
    });

    reporter.onEvent({ type: "NodeStarted", nodeId: "review-file-1-src-foo-ts", timestampMs: 1_000 });
    reporter.onEvent({ type: "NodeStarted", nodeId: "review-file-2-src-bar-ts", timestampMs: 1_000 });
    reporter.onEvent({ type: "NodeFinished", nodeId: "review-file-1-src-foo-ts", timestampMs: 49_000 });
    reporter.onEvent({ type: "NodeFinished", nodeId: "review-file-2-src-bar-ts", timestampMs: 61_000 });
    await reporter.flush();

    expect(lines).toEqual([
      "[1/2] src/foo.ts … 2 findings (48s)",
      "[2/2] src/bar.ts … 0 findings (60s)",
    ]);
  });

  test("prints phase lines for verify, narrate, quiz, and walkthrough", async () => {
    const { reporter, lines } = reporterWith({});
    for (const nodeId of ["verify-findings", "narrate", "quiz", "walkthrough"]) {
      reporter.onEvent({ type: "NodeStarted", nodeId, timestampMs: 0 });
      reporter.onEvent({ type: "NodeFinished", nodeId, timestampMs: 5_000 });
    }
    await reporter.flush();

    expect(lines).toEqual([
      "verify: adversarially checking findings…",
      "verify: done (5s)",
      "narrate: drafting the walkthrough story…",
      "narrate: done (5s)",
      "quiz: writing reviewer comprehension questions…",
      "quiz: done (5s)",
      "walkthrough: rendering HTML…",
      "walkthrough: done (5s)",
    ]);
  });

  test("reports failures with the first line of the error message", async () => {
    const { reporter, lines } = reporterWith({ reviewPrompt: [preparedRow] });
    reporter.onEvent({ type: "NodeStarted", nodeId: "review-file-1-src-foo-ts", timestampMs: 0 });
    reporter.onEvent({
      type: "NodeFailed",
      nodeId: "review-file-1-src-foo-ts",
      timestampMs: 12_000,
      error: new Error("agent timed out\nstack line"),
    });
    reporter.onEvent({ type: "NodeFailed", nodeId: "narrate", timestampMs: 20_000, error: "narrator crashed" });
    await reporter.flush();

    expect(lines[0]).toBe("[1/2] src/foo.ts … failed (12s): agent timed out");
    expect(lines[1]).toBe("narrate failed: narrator crashed");
  });

  test("falls back to the node id and omits totals when the prompt row is missing", async () => {
    const { reporter, lines } = reporterWith({});
    reporter.onEvent({ type: "NodeFinished", nodeId: "review-file-1-mystery", timestampMs: 3_000 });
    await reporter.flush();
    expect(lines).toEqual(["[1] review-file-1-mystery … done"]);
  });

  test("ignores unrelated events and events without a node id", async () => {
    const { reporter, lines } = reporterWith({});
    reporter.onEvent({ type: "RunStarted", timestampMs: 0 });
    reporter.onEvent({ type: "TaskHeartbeat", nodeId: "review-file-1-x", timestampMs: 0 });
    reporter.onEvent({ type: "NodeStarted", nodeId: "collect-changes", timestampMs: 0 });
    await reporter.flush();
    expect(lines).toEqual(["collecting changed files…"]);
  });
});
