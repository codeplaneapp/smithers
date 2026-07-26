/**
 * Startup orchestration for `smithers-mon`: decide WHICH gateway to monitor a
 * run through — reuse the configured one, reuse the workspace's singleton
 * gateway (via its runtime state file), or autostart a dedicated one — with
 * every decision validated against "does it actually serve this run?".
 *
 * Extracted as a pure function over injected effects so the whole probe /
 * validate / discover / autostart state machine is unit-testable. Invariants
 * the tests pin down:
 *
 *  - `autoStart` is invoked AT MOST ONCE per startup. (The old inline flow
 *    could fall from a failed workspace-mismatch autostart straight into the
 *    generic unreachable branch and spawn a second gateway child, burning a
 *    second 90s probe budget before failing.)
 *  - EVERY gateway we settle on — reused, discovered, or autostarted — must
 *    pass `servesRun`. (A /health 200 only proves a gateway is listening; a
 *    stray gateway from another workspace renders an empty monitor.)
 *  - An auth rejection (401/403) is reported as a TOKEN problem and stops the
 *    startup; it must not be misread as "different workspace" and trigger an
 *    autostart storm.
 */

/** Tri-state result of asking a gateway whether it serves the run. */
export type ServesRun = "yes" | "no" | "unauthorized";

export interface GatewayCandidate {
  base: string;
  port: number;
  /** Bearer token to authenticate with (overrides the configured one). */
  token?: string | undefined;
}

export type GatewayStartupResult = (GatewayCandidate & { kind: "ready" }) | { kind: "error"; message: string };

export interface GatewayStartupDeps {
  runId: string;
  /** Configured base/port/token from args + env (see resolveGatewayConfig). */
  base: string;
  port: number;
  token?: string | undefined;
  /** False when the user pinned --gateway / SMITHERS_GATEWAY_URL. */
  autoStartAllowed: boolean;
  /** False when no smithers CLI entry could be resolved to spawn a gateway. */
  hasCliEntry: boolean;
  probe: (candidate: GatewayCandidate) => Promise<boolean>;
  servesRun: (candidate: GatewayCandidate) => Promise<ServesRun>;
  /** Spawn `smithers gateway` on the candidate's port and poll until healthy. */
  autoStart: (candidate: GatewayCandidate) => Promise<boolean>;
  findFreePort: () => Promise<number>;
  /** True when something is LISTENING on the port (but /health failed). */
  isPortBusy: (port: number) => Promise<boolean>;
  /** The workspace's singleton gateway from its runtime state file, if alive. */
  discoverWorkspaceGateway: () => Promise<GatewayCandidate | null>;
  log: (message: string) => void;
}

const AUTH_ERROR = "gateway rejected the token (401/403). Check --token / SMITHERS_TOKEN / SMITHERS_API_KEY.";

/**
 * Try the workspace singleton gateway recorded in the runtime state file.
 * Returns a ready result when it is healthy AND serves the run; null when it
 * is absent/stale/foreign (callers fall through to autostart); an error result
 * only for an auth rejection (a wrong token is the user's to fix — silently
 * spawning another gateway would mask it).
 */
async function tryWorkspaceGateway(deps: GatewayStartupDeps): Promise<GatewayStartupResult | null> {
  const discovered = await deps.discoverWorkspaceGateway();
  if (!discovered) return null;
  if (!(await deps.probe(discovered))) return null;
  const serves = await deps.servesRun(discovered);
  if (serves === "unauthorized") {
    return { kind: "error", message: `Workspace gateway at ${discovered.base}: ${AUTH_ERROR}` };
  }
  if (serves !== "yes") return null;
  deps.log(`Reusing the workspace gateway at ${discovered.base}.`);
  return { kind: "ready", ...discovered };
}

/**
 * Autostart a gateway on `candidate` and validate it serves the run. This is
 * the ONLY place `autoStart` is called, and it is terminal: every outcome is a
 * ready or error result — never a fall-through to another autostart. One
 * exception path: `smithers gateway` enforces a per-workspace SINGLETON, so a
 * refused autostart re-checks the workspace gateway (another process may have
 * won the race — including our own child losing to it) before erroring.
 */
async function autoStartAndValidate(
  deps: GatewayStartupDeps,
  candidate: GatewayCandidate,
): Promise<GatewayStartupResult> {
  if (!(await deps.autoStart(candidate))) {
    const raced = await tryWorkspaceGateway(deps);
    if (raced) return raced;
    return {
      kind: "error",
      message:
        `Could not start a Gateway at ${candidate.base} (autostart timed out or the child failed).\n` +
        `  If a workspace gateway is already running (\`smithers gateway status\`), it does not serve run ${deps.runId}.`,
    };
  }
  // A freshly-started gateway answers /health before its workflow/store
  // registration fully settles; give getRun a short retry window.
  let serves: ServesRun = "no";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    serves = await deps.servesRun(candidate);
    if (serves !== "no") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (serves === "unauthorized") {
    return { kind: "error", message: `Autostarted gateway at ${candidate.base}: ${AUTH_ERROR}` };
  }
  if (serves !== "yes") {
    return {
      kind: "error",
      message:
        `Started a Gateway at ${candidate.base}, but it does not serve run ${deps.runId}. ` +
        `The run may not exist in this workspace's store — check the run id (\`smithers ps\`).`,
    };
  }
  return { kind: "ready", ...candidate };
}

export async function resolveGatewayForRun(deps: GatewayStartupDeps): Promise<GatewayStartupResult> {
  const configured: GatewayCandidate = { base: deps.base, port: deps.port, token: deps.token };
  const reachable = await deps.probe(configured);

  if (reachable) {
    const serves = await deps.servesRun(configured);
    if (serves === "yes") return { kind: "ready", ...configured };
    if (serves === "unauthorized") {
      return { kind: "error", message: `Gateway at ${configured.base}: ${AUTH_ERROR}` };
    }
    // Reachable but serving a different workspace/store.
    if (!deps.autoStartAllowed) {
      return {
        kind: "error",
        message:
          `Gateway at ${configured.base} does not serve run ${deps.runId}.\n` +
          `  It may be a different workspace/store. Check --gateway/--port or the run id.`,
      };
    }
    deps.log(
      `Gateway at ${configured.base} does not serve run ${deps.runId} ` +
        `(it serves a different workspace/store); looking for the workspace gateway…`,
    );
    const workspace = await tryWorkspaceGateway(deps);
    if (workspace) return workspace;
    if (!deps.hasCliEntry) {
      return {
        kind: "error",
        message:
          `No gateway serves run ${deps.runId} and no smithers CLI entry to autostart one.\n` +
          `  Start one with \`smithers gateway\`, then retry.`,
      };
    }
    const port = await deps.findFreePort();
    const dedicated: GatewayCandidate = { base: `http://127.0.0.1:${port}`, port, token: deps.token };
    deps.log(`Starting a dedicated workspace gateway at ${dedicated.base}…`);
    return autoStartAndValidate(deps, dedicated);
  }

  // Nothing reachable at the configured address.
  if (!deps.autoStartAllowed) {
    return {
      kind: "error",
      message: `Gateway at ${configured.base} is unreachable.\n` + `  Start it (or fix the address), then retry.`,
    };
  }
  const workspace = await tryWorkspaceGateway(deps);
  if (workspace) return workspace;
  if (!deps.hasCliEntry) {
    return {
      kind: "error",
      message:
        `No Gateway at ${configured.base} and no smithers CLI entry to autostart one.\n` +
        `  Start it with \`smithers gateway\` (or pass --gateway <url>), then retry.`,
    };
  }
  // The default port failed /health, but something else may still be BOUND to
  // it (a non-gateway process, a half-dead gateway). Spawning there would die
  // EADDRINUSE and burn the whole 90s probe budget — rebind to a free port.
  let target = configured;
  if (await deps.isPortBusy(configured.port)) {
    const port = await deps.findFreePort();
    target = { base: `http://127.0.0.1:${port}`, port, token: deps.token };
    deps.log(
      `Port ${configured.port} is occupied by something that is not a healthy gateway; ` +
        `starting one at ${target.base} instead…`,
    );
  } else {
    deps.log(`No Gateway at ${configured.base}; starting one…`);
  }
  return autoStartAndValidate(deps, target);
}
