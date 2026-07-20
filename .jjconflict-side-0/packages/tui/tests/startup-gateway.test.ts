import { describe, expect, test } from "bun:test";
import {
  resolveGatewayForRun,
  type GatewayCandidate,
  type GatewayStartupDeps,
  type ServesRun,
} from "../src/startupGateway.ts";

/**
 * Deterministic dependency harness for the startup state machine. Each knob is
 * a plain value or a per-base map; every effect invocation is recorded so tests
 * can assert HOW the machine got to its answer (e.g. autoStart called at most
 * once), not just the answer.
 */
function makeDeps(overrides: {
  probe?: Record<string, boolean>;
  servesRun?: Record<string, ServesRun>;
  autoStartResult?: boolean;
  autoStartServes?: ServesRun;
  autoStartAllowed?: boolean;
  hasCliEntry?: boolean;
  portBusy?: boolean;
  workspaceGateway?: GatewayCandidate | null;
  workspaceServes?: ServesRun;
}) {
  const calls = {
    autoStart: [] as GatewayCandidate[],
    probes: [] as string[],
    servesRun: [] as string[],
    logs: [] as string[],
  };
  const servesRunMap = overrides.servesRun ?? {};
  const deps: GatewayStartupDeps = {
    runId: "run-1",
    base: "http://127.0.0.1:7331",
    port: 7331,
    token: undefined,
    autoStartAllowed: overrides.autoStartAllowed ?? true,
    hasCliEntry: overrides.hasCliEntry ?? true,
    probe: async (candidate) => {
      calls.probes.push(candidate.base);
      return overrides.probe?.[candidate.base] ?? false;
    },
    servesRun: async (candidate) => {
      calls.servesRun.push(candidate.base);
      if (calls.autoStart.some((started) => started.base === candidate.base)) {
        return overrides.autoStartServes ?? "yes";
      }
      if (overrides.workspaceGateway && candidate.base === overrides.workspaceGateway.base) {
        return overrides.workspaceServes ?? "yes";
      }
      return servesRunMap[candidate.base] ?? "no";
    },
    autoStart: async (candidate) => {
      calls.autoStart.push(candidate);
      return overrides.autoStartResult ?? true;
    },
    findFreePort: async () => 45000 + calls.autoStart.length,
    isPortBusy: async () => overrides.portBusy ?? false,
    discoverWorkspaceGateway: async () => overrides.workspaceGateway ?? null,
    log: (message) => calls.logs.push(message),
  };
  return { deps, calls };
}

describe("resolveGatewayForRun", () => {
  test("reuses a reachable gateway that serves the run", async () => {
    const { deps, calls } = makeDeps({
      probe: { "http://127.0.0.1:7331": true },
      servesRun: { "http://127.0.0.1:7331": "yes" },
    });
    const result = await resolveGatewayForRun(deps);
    expect(result).toMatchObject({ kind: "ready", base: "http://127.0.0.1:7331", port: 7331 });
    expect(calls.autoStart).toHaveLength(0);
  });

  test("workspace-mismatch with a failed autostart is TERMINAL: autoStart runs at most once", async () => {
    // Regression: the old inline flow fell from a failed mismatch autostart
    // into the generic unreachable branch and spawned a SECOND gateway child,
    // burning a second 90s budget before failing.
    const { deps, calls } = makeDeps({
      probe: { "http://127.0.0.1:7331": true },
      servesRun: { "http://127.0.0.1:7331": "no" },
      autoStartResult: false,
    });
    const result = await resolveGatewayForRun(deps);
    expect(result.kind).toBe("error");
    expect(calls.autoStart).toHaveLength(1);
  });

  test("an autostarted gateway must still prove it serves the run", async () => {
    // /health alone is not enough: a typo'd run id autostarts a healthy
    // gateway that will never have the run — that must be an error, not an
    // empty monitor.
    const { deps, calls } = makeDeps({
      probe: {},
      autoStartResult: true,
      autoStartServes: "no",
    });
    const result = await resolveGatewayForRun(deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("does not serve run run-1");
    expect(calls.autoStart).toHaveLength(1);
  }, 15_000);

  test("401/403 from the configured gateway reports a token error, not a workspace mismatch", async () => {
    const { deps, calls } = makeDeps({
      probe: { "http://127.0.0.1:7331": true },
      servesRun: { "http://127.0.0.1:7331": "unauthorized" },
    });
    const result = await resolveGatewayForRun(deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("401/403");
    expect(calls.autoStart).toHaveLength(0);
  });

  test("pinned gateway (autostart disallowed) never autostarts", async () => {
    const mismatch = makeDeps({
      probe: { "http://127.0.0.1:7331": true },
      servesRun: { "http://127.0.0.1:7331": "no" },
      autoStartAllowed: false,
    });
    expect((await resolveGatewayForRun(mismatch.deps)).kind).toBe("error");
    expect(mismatch.calls.autoStart).toHaveLength(0);

    const unreachable = makeDeps({ probe: {}, autoStartAllowed: false });
    const result = await resolveGatewayForRun(unreachable.deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("unreachable");
    expect(unreachable.calls.autoStart).toHaveLength(0);
  });

  test("reuses the workspace singleton gateway from the runtime state file", async () => {
    const workspaceGateway = { base: "http://127.0.0.1:9100", port: 9100, token: "tok" };
    const { deps, calls } = makeDeps({
      probe: { "http://127.0.0.1:9100": true },
      workspaceGateway,
      workspaceServes: "yes",
    });
    const result = await resolveGatewayForRun(deps);
    expect(result).toMatchObject({ kind: "ready", base: "http://127.0.0.1:9100", token: "tok" });
    expect(calls.autoStart).toHaveLength(0);
  });

  test("workspace gateway rejecting the token is a token error, not a fall-through autostart", async () => {
    const workspaceGateway = { base: "http://127.0.0.1:9100", port: 9100, token: "bad" };
    const { deps, calls } = makeDeps({
      probe: { "http://127.0.0.1:9100": true },
      workspaceGateway,
      workspaceServes: "unauthorized",
    });
    const result = await resolveGatewayForRun(deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("401/403");
    expect(calls.autoStart).toHaveLength(0);
  });

  test("a refused autostart re-checks the workspace singleton (race with `smithers gateway`)", async () => {
    // The gateway command enforces a per-workspace singleton: our autostart
    // child can lose the race (GATEWAY_ALREADY_RUNNING) to a singleton that
    // appeared after the first discovery pass. That singleton — if it serves
    // the run — is the right answer, not an error.
    const workspaceGateway = { base: "http://127.0.0.1:9100", port: 9100, token: undefined };
    let discoveries = 0;
    const { deps, calls } = makeDeps({
      probe: { "http://127.0.0.1:9100": true },
      autoStartResult: false,
      workspaceGateway,
      workspaceServes: "yes",
    });
    const discover = deps.discoverWorkspaceGateway;
    deps.discoverWorkspaceGateway = async () => {
      discoveries += 1;
      // First pass: nothing yet. Second pass (post-refusal): the singleton.
      return discoveries === 1 ? null : discover();
    };
    const result = await resolveGatewayForRun(deps);
    expect(result).toMatchObject({ kind: "ready", base: "http://127.0.0.1:9100" });
    expect(calls.autoStart).toHaveLength(1);
    expect(discoveries).toBe(2);
  });

  test("a stale workspace gateway that does not serve the run falls through to autostart", async () => {
    const workspaceGateway = { base: "http://127.0.0.1:9100", port: 9100, token: undefined };
    const { deps, calls } = makeDeps({
      probe: { "http://127.0.0.1:9100": true },
      workspaceGateway,
      workspaceServes: "no",
      autoStartResult: true,
      autoStartServes: "yes",
    });
    const result = await resolveGatewayForRun(deps);
    expect(result.kind).toBe("ready");
    expect(calls.autoStart).toHaveLength(1);
  });

  test("occupied default port rebinds to a free port before autostarting", async () => {
    // Something non-gateway is bound to 7331 (probe fails, port busy):
    // spawning there would die EADDRINUSE and burn the whole probe budget.
    const { deps, calls } = makeDeps({
      probe: {},
      portBusy: true,
      autoStartResult: true,
      autoStartServes: "yes",
    });
    const result = await resolveGatewayForRun(deps);
    expect(result.kind).toBe("ready");
    expect(calls.autoStart).toHaveLength(1);
    expect(calls.autoStart[0]!.port).not.toBe(7331);
  });

  test("free default port autostarts in place", async () => {
    const { deps, calls } = makeDeps({
      probe: {},
      portBusy: false,
      autoStartResult: true,
      autoStartServes: "yes",
    });
    const result = await resolveGatewayForRun(deps);
    expect(result).toMatchObject({ kind: "ready", port: 7331 });
    expect(calls.autoStart).toHaveLength(1);
  });

  test("no CLI entry: clear error instead of a silent empty monitor", async () => {
    const unreachable = makeDeps({ probe: {}, hasCliEntry: false });
    const result = await resolveGatewayForRun(unreachable.deps);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("smithers gateway");
    expect(unreachable.calls.autoStart).toHaveLength(0);
  });
});
