import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MONITOR_ANNOTATION_KEY,
  MONITOR_SUPPRESS_ENV,
  buildMonitorLaunchArgs,
  buildMonitorLaunchEnv,
  buildMonitorRunId,
  discoverMonitorWorkflow,
  isMonitorWorkflowFile,
  normalizeMonitorOption,
  resolveMonitorDirs,
  resolveMonitorLaunch,
} from "../src/monitor-workflows.js";

const dirs = [];
afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  dirs.length = 0;
});

/** A workspace with a `.smithers` pack, plus any monitor/workflow files given. */
function workspace({ monitors = [], workflows = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "smithers-monitor-"));
  dirs.push(root);
  mkdirSync(join(root, ".smithers", "workflows"), { recursive: true });
  if (monitors.length > 0) mkdirSync(join(root, ".smithers", "monitor"), { recursive: true });
  for (const name of monitors) {
    writeFileSync(join(root, ".smithers", "monitor", `${name}.tsx`), "export default {};");
  }
  for (const name of workflows) {
    writeFileSync(join(root, ".smithers", "workflows", `${name}.tsx`), "export default {};");
  }
  return root;
}

// An isolated global pack, so a real ~/.smithers on the developer's machine
// can never make (or break) one of these assertions.
const isolatedEnv = (root) => ({ SMITHERS_HOME: join(root, "no-global-pack") });

describe("monitor discovery", () => {
  test("resolves <packDir>/monitor as the monitor directory", () => {
    const root = workspace({ monitors: ["nightly"] });
    const [local] = resolveMonitorDirs(root, isolatedEnv(root));
    expect(local.scope).toBe("local");
    expect(local.dir).toBe(join(root, ".smithers", "monitor"));
  });

  test("finds the monitor whose file name matches the workflow id", () => {
    const root = workspace({ monitors: ["nightly"], workflows: ["nightly"] });
    const found = discoverMonitorWorkflow("nightly", root, isolatedEnv(root));
    expect(found?.entryFile).toBe(join(root, ".smithers", "monitor", "nightly.tsx"));
    expect(found?.scope).toBe("local");
  });

  test("returns null when no monitor file exists for the workflow", () => {
    const root = workspace({ monitors: ["nightly"], workflows: ["nightly", "unwatched"] });
    expect(discoverMonitorWorkflow("unwatched", root, isolatedEnv(root))).toBeNull();
  });

  test("returns null when the pack has no monitor directory at all", () => {
    const root = workspace({ workflows: ["nightly"] });
    expect(discoverMonitorWorkflow("nightly", root, isolatedEnv(root))).toBeNull();
  });
});

describe("resolveMonitorLaunch", () => {
  test("launches the discovered monitor for a watched workflow", () => {
    const root = workspace({ monitors: ["nightly"], workflows: ["nightly"] });
    const plan = resolveMonitorLaunch({
      workflowPath: join(root, ".smithers", "workflows", "nightly.tsx"),
      cwd: root,
      env: isolatedEnv(root),
    });
    expect(plan.action).toBe("launch");
    expect(plan.explicit).toBe(false);
    expect(plan.monitor.entryFile).toBe(join(root, ".smithers", "monitor", "nightly.tsx"));
  });

  // The whole feature has to be inert until someone opts in by writing a file.
  test("is a no-op when the workspace has zero monitor files", () => {
    const root = workspace({ workflows: ["nightly"] });
    const plan = resolveMonitorLaunch({
      workflowPath: join(root, ".smithers", "workflows", "nightly.tsx"),
      cwd: root,
      env: isolatedEnv(root),
    });
    expect(plan.action).toBe("none");
  });

  test("--no-monitor opts out even when a monitor file exists", () => {
    const root = workspace({ monitors: ["nightly"], workflows: ["nightly"] });
    const plan = resolveMonitorLaunch({
      workflowPath: join(root, ".smithers", "workflows", "nightly.tsx"),
      noMonitor: true,
      cwd: root,
      env: isolatedEnv(root),
    });
    expect(plan.action).toBe("opted-out");
  });

  test("--monitor <path> overrides discovery", () => {
    const root = workspace({ monitors: ["nightly"], workflows: ["nightly"] });
    mkdirSync(join(root, "custom"), { recursive: true });
    writeFileSync(join(root, "custom", "watcher.tsx"), "export default {};");
    const plan = resolveMonitorLaunch({
      workflowPath: join(root, ".smithers", "workflows", "nightly.tsx"),
      monitor: "custom/watcher.tsx",
      cwd: root,
      env: isolatedEnv(root),
    });
    expect(plan.action).toBe("launch");
    expect(plan.explicit).toBe(true);
    expect(plan.monitor.entryFile).toBe(join(root, "custom", "watcher.tsx"));
  });

  test("--monitor with a missing file fails loudly instead of silently discovering", () => {
    const root = workspace({ monitors: ["nightly"], workflows: ["nightly"] });
    expect(() =>
      resolveMonitorLaunch({
        workflowPath: join(root, ".smithers", "workflows", "nightly.tsx"),
        monitor: "custom/typo.tsx",
        cwd: root,
        env: isolatedEnv(root),
      }),
    ).toThrow(/Monitor workflow not found/);
  });
});

describe("recursion guards", () => {
  test("a file under monitor/ is recognised as a monitor", () => {
    expect(isMonitorWorkflowFile("/repo/.smithers/monitor/nightly.tsx")).toBe(true);
    expect(isMonitorWorkflowFile("/repo/.smithers/workflows/nightly.tsx")).toBe(false);
  });

  // Running a monitor is running a workflow, so without this a monitor would
  // discover a monitor for itself, forever.
  test("a monitor never gets a monitor of its own", () => {
    const root = workspace({ monitors: ["nightly"] });
    writeFileSync(join(root, ".smithers", "monitor", "monitor.tsx"), "export default {};");
    const plan = resolveMonitorLaunch({
      workflowPath: join(root, ".smithers", "monitor", "monitor.tsx"),
      cwd: root,
      env: isolatedEnv(root),
    });
    expect(plan.action).toBe("suppressed");
  });

  test("an explicit --monitor cannot defeat the recursion guard", () => {
    const root = workspace({ monitors: ["nightly"] });
    writeFileSync(join(root, ".smithers", "monitor", "other.tsx"), "export default {};");
    const plan = resolveMonitorLaunch({
      workflowPath: join(root, ".smithers", "monitor", "nightly.tsx"),
      monitor: join(root, ".smithers", "monitor", "other.tsx"),
      cwd: root,
      env: isolatedEnv(root),
    });
    expect(plan.action).toBe("suppressed");
  });

  test("the suppression env var stops anything a monitor launches from spawning one", () => {
    const root = workspace({ monitors: ["nightly"], workflows: ["nightly"] });
    const plan = resolveMonitorLaunch({
      workflowPath: join(root, ".smithers", "workflows", "nightly.tsx"),
      cwd: root,
      env: { ...isolatedEnv(root), [MONITOR_SUPPRESS_ENV]: "1" },
    });
    expect(plan.action).toBe("suppressed");
    expect(buildMonitorLaunchEnv({ PATH: "/bin" })[MONITOR_SUPPRESS_ENV]).toBe("1");
  });
});

describe("monitor launch argv", () => {
  const args = buildMonitorLaunchArgs({
    monitorEntryFile: "/repo/.smithers/monitor/nightly.tsx",
    watchRunId: "run-42",
    watchWorkflowId: "nightly",
    watchWorkflowPath: "/repo/.smithers/workflows/nightly.tsx",
  });

  test("starts one caller-detached child run linked to the watched run", () => {
    expect(args.slice(0, 2)).toEqual(["up", "/repo/.smithers/monitor/nightly.tsx"]);
    // The caller's spawn is already `detached: true`. Asking `up` to detach
    // again would create an untracked grandchild and make teardown race it.
    expect(args).not.toContain("--detach");
    // parent_run_id is what makes ps/inspect/the Gateway show the pairing, and
    // what makes `smithers cancel` cascade to the monitor.
    expect(args[args.indexOf("--parent-run-id") + 1]).toBe("run-42");
    expect(args[args.indexOf("--run-id") + 1]).toMatch(/^run-42-monitor-[a-f0-9]{16}$/);
  });

  test("mints a collision-resistant id for every launch", () => {
    const first = buildMonitorRunId("run-42");
    const second = buildMonitorRunId("run-42");
    expect(first).not.toBe(second);
    expect(first).toStartWith("run-42-monitor-");
    expect(buildMonitorRunId("x".repeat(64)).length).toBeLessThanOrEqual(64);
  });

  test("tells the monitor what it is watching", () => {
    expect(JSON.parse(args[args.indexOf("--input") + 1])).toEqual({
      watchRunId: "run-42",
      watchWorkflowId: "nightly",
      watchWorkflowPath: "/repo/.smithers/workflows/nightly.tsx",
    });
    expect(JSON.parse(args[args.indexOf("--annotations") + 1])).toEqual({ [MONITOR_ANNOTATION_KEY]: "run-42" });
  });

  test("launches the monitor with --no-monitor so it cannot recurse", () => {
    expect(args).toContain("--no-monitor");
  });

  test("forwards store/root selection so the monitor lands in the same workspace", () => {
    const scoped = buildMonitorLaunchArgs({
      monitorEntryFile: "/repo/.smithers/monitor/nightly.tsx",
      watchRunId: "run-42",
      watchWorkflowId: "nightly",
      watchWorkflowPath: "/repo/.smithers/workflows/nightly.tsx",
      root: "/repo",
      backend: "pglite",
      logDir: "/repo/logs",
    });
    expect(scoped[scoped.indexOf("--root") + 1]).toBe("/repo");
    expect(scoped[scoped.indexOf("--backend") + 1]).toBe("pglite");
    expect(scoped[scoped.indexOf("--log-dir") + 1]).toBe("/repo/logs");
  });
});

describe("normalizeMonitorOption", () => {
  test("defaults to auto-discovery", () => {
    expect(normalizeMonitorOption(true)).toEqual({ noMonitor: false, monitorPath: undefined });
    expect(normalizeMonitorOption(undefined)).toEqual({ noMonitor: false, monitorPath: undefined });
  });

  test("--no-monitor opts out", () => {
    expect(normalizeMonitorOption(false)).toEqual({ noMonitor: true, monitorPath: undefined });
  });

  test("a string selects a monitor file", () => {
    expect(normalizeMonitorOption("mon/watch.tsx")).toEqual({ noMonitor: false, monitorPath: "mon/watch.tsx" });
  });

  test("a bare --monitor followed by another flag still means auto-discover", () => {
    expect(normalizeMonitorOption("--detach")).toEqual({ noMonitor: false, monitorPath: undefined });
  });
});
