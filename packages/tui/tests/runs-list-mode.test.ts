import { describe, expect, it } from "bun:test";
import type { RunSummary, RunStatusFilter } from "@smthrs/ui-core";
import { flattenRunGroups, nextStatusFilter } from "../src/modes/RunsListMode.tsx";

function run(runId: string): RunSummary {
  return {
    id: runId,
    runId,
    workflowName: runId,
    model: "",
    status: "running",
    totalNodes: 0,
    doneNodes: 0,
    failedNodes: 0,
    progress: 0,
    elapsedLabel: "—",
    ageBucket: "today",
  };
}

describe("RunsListMode helpers", () => {
  it("cycles every status filter and wraps to all", () => {
    const cycle: RunStatusFilter[] = ["all"];
    for (let i = 0; i < 6; i++) cycle.push(nextStatusFilter(cycle.at(-1)!));
    expect(cycle).toEqual(["all", "running", "waiting", "finished", "failed", "cancelled", "all"]);
  });

  it("maps focus indices across group headings without counting the headings", () => {
    const active = [run("active-1"), run("active-2")];
    const completed = [run("done-1")];
    const failed = [run("failed-1"), run("failed-2")];
    const rows = flattenRunGroups([{ runs: active }, { runs: completed }, { runs: failed }]);
    expect(rows.map((row) => row.runId)).toEqual(["active-1", "active-2", "done-1", "failed-1", "failed-2"]);
    expect(rows[2]?.runId).toBe("done-1");
    expect(rows[3]?.runId).toBe("failed-1");
  });
});
