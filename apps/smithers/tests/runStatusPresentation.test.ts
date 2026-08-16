import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusPill } from "../src/cards/StatusPill";
import {
  normalizeRunStatus,
  runActionAvailability,
  runStatusCategory,
  runStatusLabel,
  runStatusToNode,
  runStatusTone,
} from "../src/runs/runsList";
import { toRunSummary } from "../src/runs/RunsListBridge";

describe("run status presentation", () => {
  test.each([
    ["running", "running", "running", "running", "Running"],
    ["resumed", "resumed", "running", "running", "Resumed"],
    ["queued", "queued", "running", "idle", "Queued"],
    ["pending", "pending", "running", "idle", "Pending"],
    ["succeeded", "succeeded", "finished", "ok", "Complete"],
    ["finished", "finished", "finished", "ok", "Finished"],
    ["completed", "completed", "finished", "ok", "Complete"],
    ["ok", "ok", "finished", "ok", "Complete"],
    ["continued", "continued", "finished", "ok", "Continued"],
    ["failed", "failed", "failed", "failed", "Failed"],
    ["errored", "errored", "failed", "failed", "Errored"],
    ["stale", "stale", "failed", "failed", "Stale"],
    ["orphaned", "orphaned", "failed", "failed", "Orphaned"],
    ["cancelled", "cancelled", "cancelled", "idle", "Cancelled"],
    ["canceled", "cancelled", "cancelled", "idle", "Cancelled"],
    [" Waiting_Approval ", "waiting-approval", "waiting", "waiting", "Waiting for approval"],
    ["waiting-event", "waiting-event", "waiting", "waiting", "Waiting for event"],
    ["waiting-timer", "waiting-timer", "waiting", "waiting", "Waiting on timer"],
    ["waiting-quota", "waiting-quota", "waiting", "waiting", "Waiting on quota"],
    ["waiting", "waiting", "waiting", "waiting", "Waiting"],
    ["blocked", "blocked", "waiting", "failed", "Blocked"],
    ["paused", "paused", "waiting", "waiting", "Paused"],
    ["recovering", "recovering", "running", "waiting", "Recovering"],
  ] as const)("normalizes and tones %s", (input, normalized, category, tone, label) => {
    expect(normalizeRunStatus(input)).toBe(normalized);
    expect(runStatusCategory(input)).toBe(category);
    expect(runStatusTone(input)).toBe(tone);
    expect(runStatusLabel(input)).toBe(label);
  });

  test("preserves an unknown gateway state as a visible neutral label", () => {
    const run = toRunSummary({
      runId: "run-unknown",
      workflowKey: "workflow",
      status: "Future_State",
    });

    expect(run).toMatchObject({
      status: "running",
      lifecycleStatus: "future-state",
    });
    expect(runStatusTone(run.lifecycleStatus)).toBe("idle");
    expect(runStatusLabel(run.lifecycleStatus)).toBe("Future State");

    const markup = renderToStaticMarkup(
      createElement(StatusPill, {
        status: runStatusToNode(run.lifecycleStatus),
        label: runStatusLabel(run.lifecycleStatus),
      }),
    );
    expect(markup).toContain("tone-idle");
    expect(markup).toContain("status-dot");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("Future State");
  });

  test("uses an explicit unknown label for a missing gateway state", () => {
    const run = toRunSummary({ runId: "run-missing" });
    expect(run.lifecycleStatus).toBe("unknown");
    expect(runStatusLabel(run.lifecycleStatus)).toBe("Unknown");
    expect(runStatusTone(run.lifecycleStatus)).toBe("idle");
  });

  test.each([
    ["running", { pause: true, resume: false, cancel: true, retry: false }],
    ["paused", { pause: false, resume: true, cancel: true, retry: false }],
    ["stale", { pause: false, resume: true, cancel: true, retry: false }],
    ["orphaned", { pause: false, resume: true, cancel: true, retry: false }],
    ["failed", { pause: false, resume: false, cancel: false, retry: true }],
    ["cancelled", { pause: false, resume: false, cancel: false, retry: false }],
    ["finished", { pause: false, resume: false, cancel: false, retry: false }],
  ] as const)("admits lifecycle actions for %s", (status, expected) => {
    const run = toRunSummary({ runId: `run-${status}`, status });
    expect(runActionAvailability(run)).toEqual(expected);
  });
});
