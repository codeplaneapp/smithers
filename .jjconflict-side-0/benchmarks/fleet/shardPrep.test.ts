import { describe, expect, it } from "bun:test";
import type { BenchmarkInstance } from "./BenchmarkInstance";
import { benchmarkRunId } from "./benchmarkRunId";
import { benchmarkTasksFromInstances } from "./benchmarkTasksFromInstances";
import { buildDelegationShardTasks } from "./buildDelegationShardTasks";

const instances: BenchmarkInstance[] = [
  { id: "django__django-12345", prompt: "Fix the ORM bug", cwd: "/work/a" },
  { id: "flipt-io/flipt#42", prompt: "Add flag", cwd: "/work/b", weight: 3, budgetMinutes: 90 },
];

describe("benchmarkRunId", () => {
  it("is deterministic and filesystem-safe", () => {
    expect(benchmarkRunId("swe-bench-pro", "flipt-io/flipt#42")).toBe("swe-bench-pro-flipt-io_flipt_42");
    expect(benchmarkRunId("swe-bench-pro", "flipt-io/flipt#42")).toBe(benchmarkRunId("swe-bench-pro", "flipt-io/flipt#42"));
  });
});

describe("buildDelegationShardTasks", () => {
  it("maps instances to delegation runs with prompt + cwd", () => {
    const tasks = buildDelegationShardTasks(instances, { benchmark: "swe-bench-pro" });
    expect(tasks).toHaveLength(2);
    expect(tasks[0].runId).toBe("swe-bench-pro-django__django-12345");
    expect(tasks[0].workflow).toContain("benchmark-delegation.tsx");
    expect(tasks[0].input).toEqual({ prompt: "Fix the ORM bug", cwd: "/work/a" });
  });

  it("passes a per-instance budget, else the option fallback", () => {
    const tasks = buildDelegationShardTasks(instances, { benchmark: "b", budgetMinutes: 60 });
    expect(tasks[0].input.budgetMinutes).toBe(60); // fallback
    expect(tasks[1].input.budgetMinutes).toBe(90); // per-instance wins
  });

  it("honors a custom workflow path", () => {
    const tasks = buildDelegationShardTasks(instances, { benchmark: "b", workflow: "custom.tsx" });
    expect(tasks[0].workflow).toBe("custom.tsx");
  });
});

describe("benchmarkTasksFromInstances", () => {
  it("produces planShards tasks whose ids match the run ids", () => {
    const tasks = benchmarkTasksFromInstances(instances, "swe-bench-pro");
    expect(tasks[0].id).toBe("swe-bench-pro-django__django-12345");
    expect(tasks[1].weight).toBe(3);
    // ids line up with buildDelegationShardTasks so a shard maps back to its runs
    const runs = buildDelegationShardTasks(instances, { benchmark: "swe-bench-pro" });
    expect(tasks.map((t) => t.id)).toEqual(runs.map((r) => r.runId));
  });
});
