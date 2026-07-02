#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { SmithersGatewayClient } from "@smithers-orchestrator/gateway-client";
import { SmithersGatewayProvider } from "@smithers-orchestrator/gateway-react";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolveGatewayConfig, isValidGatewayPort, GatewayConfigError } from "./gatewayConfig.ts";
import { resolveGatewayForRun, type GatewayCandidate, type ServesRun } from "./startupGateway.ts";
import { readWorkspaceGatewayState } from "./gatewayRuntimeState.ts";
import { resolveCliEntry } from "./cliEntry.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { Keybindings } from "./Keybindings.tsx";
import { RendererProvider } from "./RendererContext.tsx";
import { App } from "./App.tsx";

const USAGE = "Usage: smithers-mon <runId> [--gateway <url>] [--port <n>] [--token <token>]\n";

// The TUI drives the terminal in raw mode and reads keystrokes via useKeyboard,
// so it needs BOTH an interactive stdout (to render frames) and an interactive
// stdin (to receive keys). Without a TTY stdin the monitor would render but
// never respond to q/Ctrl-C/navigation, leaving the user wedged — refuse up
// front instead.
if (!process.stdout.isTTY) {
  process.stderr.write("smithers-mon: stdout is not a TTY\n");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  process.stderr.write("smithers-mon: stdin is not a TTY (interactive input required)\n");
  process.exit(1);
}

// CLI: smithers-mon <runId> [--gateway <url>] [--port <n>]
const args = process.argv.slice(2);
let gatewayUrlArg: string | undefined;
let portArg: number | undefined;
let tokenArg: string | undefined;
const positionals: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--gateway") {
    gatewayUrlArg = args[++i];
    if (gatewayUrlArg === undefined) {
      process.stderr.write("smithers-mon: --gateway requires a value\n" + USAGE);
      process.exit(1);
    }
  } else if (a.startsWith("--gateway=")) {
    gatewayUrlArg = a.slice("--gateway=".length);
  } else if (a === "--token") {
    tokenArg = args[++i];
    if (tokenArg === undefined) {
      process.stderr.write("smithers-mon: --token requires a value\n" + USAGE);
      process.exit(1);
    }
  } else if (a.startsWith("--token=")) {
    tokenArg = a.slice("--token=".length);
  } else if (a === "--port") {
    const raw = args[++i];
    if (raw === undefined) {
      process.stderr.write("smithers-mon: --port requires a value\n" + USAGE);
      process.exit(1);
    }
    portArg = Number(raw);
  } else if (a.startsWith("--port=")) {
    portArg = Number(a.slice("--port=".length));
  } else {
    positionals.push(a);
  }
}

// A NaN/out-of-range port would silently fall back or build a bad URL; reject it
// before any probe/spawn so the user gets a clear usage error, not a mystery
// "gateway unreachable".
if (portArg !== undefined && !isValidGatewayPort(portArg)) {
  process.stderr.write(`smithers-mon: invalid --port (expected 1-65535)\n${USAGE}`);
  process.exit(1);
}

const runId = positionals[0];
if (!runId) {
  process.stderr.write(USAGE);
  process.exit(1);
}

// apps/cli forwards SMITHERS_GATEWAY_URL when it knows the real address. An
// explicit --port is applied to a pinned --gateway/SMITHERS_GATEWAY_URL so the
// probe/client hit the requested port (see resolveGatewayConfig).
let resolvedConfig;
try {
  resolvedConfig = resolveGatewayConfig({
    gatewayUrlArg,
    portArg,
    tokenArg,
    env: process.env,
  });
} catch (err) {
  // A set-but-invalid SMITHERS_GATEWAY_PORT would otherwise build an unreachable
  // base URL; surface the config error as a clear usage failure up front.
  if (err instanceof GatewayConfigError) {
    process.stderr.write(`smithers-mon: ${err.message}\n${USAGE}`);
    process.exit(1);
  }
  throw err;
}
// Per-request timeout for the /health probe. A process bound to the port but not
// answering would otherwise hang a single fetch (and the whole startup budget)
// indefinitely; the AbortSignal caps each attempt well under the autostart
// budget so a stuck socket reports "not reachable" quickly and the retry/autostart
// loop keeps polling instead of blocking forever.
const PROBE_REQUEST_TIMEOUT_MS = 3000;
const AUTOSTART_TIMEOUT_MS = 90_000;
const AUTOSTART_PROBE_TIMEOUT_MS = 1000;

// When a token is configured, send it on the /health probe too so the probe
// authenticates the same way the RPC/WS client will — a gateway that gates
// /health behind auth then answers consistently instead of the probe passing
// while every later call is rejected.
function probeHeaders(candidate: GatewayCandidate): Record<string, string> | undefined {
  return candidate.token ? { authorization: `Bearer ${candidate.token}` } : undefined;
}

async function probeGateway(candidate: GatewayCandidate, timeoutMs = PROBE_REQUEST_TIMEOUT_MS): Promise<boolean> {
  return fetch(`${candidate.base}/health`, {
    headers: probeHeaders(candidate),
    signal: AbortSignal.timeout(timeoutMs),
  }).then((r) => r.ok, () => false);
}

// Resolve the REAL CLI entry to autostart the gateway through. Never fall back
// to process.argv[1] — that is this TUI entry, so spawning it would recursively
// launch another monitor instead of a gateway.
const cliEntry = resolveCliEntry();

async function autoStartGateway(candidate: GatewayCandidate): Promise<boolean> {
  if (!cliEntry) return false;
  // `smithers gateway` enforces a per-workspace singleton: when one is already
  // running it prints GATEWAY_ALREADY_RUNNING and exits immediately. Watch the
  // child so that exit fails THIS autostart right away instead of silently
  // burning the full 90s probe budget against a port nothing will ever bind.
  let childExited = false;
  // Node reports a spawn failure (e.g. ENOENT on `bun`) ASYNCHRONOUSLY via the
  // child's `error` event, not the synchronous try/catch. Capture it either way
  // so the autostart-failure report names the real reason instead of the generic
  // "timed out or the child failed".
  let childError: Error | null = null;
  try {
    // Pass the resolved token through as --auth-token so the autostarted
    // gateway requires the SAME token the client sends. The env (SMITHERS_API_KEY)
    // is inherited too, but a token from --token/SMITHERS_TOKEN would otherwise
    // leave the spawned gateway open while the client sends a bearer it rejects.
    const gatewayArgs = [cliEntry, "gateway", "--host", "127.0.0.1", "--port", String(candidate.port)];
    if (candidate.token) gatewayArgs.push("--auth-token", candidate.token);
    const child = spawn(process.argv[0]!, gatewayArgs, {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    child.on("error", (err) => {
      childError = err instanceof Error ? err : new Error(String(err));
      childExited = true;
    });
    child.on("exit", () => {
      childExited = true;
    });
  } catch (err) {
    process.stderr.write(
      `[smithers-mon] gateway autostart spawn failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
  const deadline = Date.now() + AUTOSTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(500);
    const remainingMs = Math.max(250, deadline - Date.now());
    if (await probeGateway(candidate, Math.min(AUTOSTART_PROBE_TIMEOUT_MS, remainingMs))) return true;
    if (childExited) {
      // A childError means the spawn itself failed (bad CLI entry / missing bun);
      // a clean exit with no error is the singleton guard (GATEWAY_ALREADY_RUNNING)
      // and is handled by the raced workspace-gateway re-check, so stay quiet there.
      if (childError) {
        process.stderr.write(`[smithers-mon] gateway autostart child failed: ${(childError as Error).message}\n`);
      }
      return false;
    }
  }
  return false;
}

/**
 * Does this gateway actually serve THIS run? A healthy `/health` only means "a
 * gateway is listening" — a stray gateway from another workspace would answer
 * /health but not have this run, giving an empty monitor. A 401/403 is reported
 * as its own state: a rejected token must stop the startup with a token error,
 * not masquerade as "different workspace" and trigger an autostart.
 */
// gatewayServesRun is polled up to 10× in autoStartAndValidate's retry loop, so
// dedupe identical thrown reasons per gateway base rather than emitting the same
// stderr line ten times.
const loggedServesRunErrors = new Set<string>();

async function gatewayServesRun(candidate: GatewayCandidate, id: string): Promise<ServesRun> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (candidate.token) headers.authorization = `Bearer ${candidate.token}`;
    const res = await fetch(`${candidate.base}/v1/rpc/getRun`, {
      method: "POST",
      headers,
      body: JSON.stringify({ runId: id }),
      signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return "unauthorized";
    if (!res.ok) return "no";
    const frame = (await res.json().catch(() => null)) as { type?: string; ok?: boolean; payload?: unknown } | null;
    return frame && frame.type === "res" && frame.ok && frame.payload ? "yes" : "no";
  } catch (err) {
    // A thrown fetch error (DNS/TLS/abort/connection-refused) is NOT proof the
    // gateway serves another workspace — it is a network-level miss. Log the real
    // reason (deduped) before folding it into "no" so a misclassified network
    // failure is diagnosable from the terminal instead of steering the user
    // toward workspace-mismatch guidance.
    const reason = err instanceof Error ? err.message : String(err);
    const key = `${candidate.base}\n${reason}`;
    if (!loggedServesRunErrors.has(key)) {
      loggedServesRunErrors.add(key);
      process.stderr.write(`[smithers-mon] gateway ${candidate.base} getRun probe failed (${reason}); treating as not-serving.\n`);
    }
    return "no";
  }
}

/** An OS-assigned free port (bind :0, read the port, release it). */
async function findFreePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  if (typeof port !== "number") throw new Error("could not allocate a free gateway port");
  return port;
}

/** True when something ACCEPTS connections on the loopback port. */
async function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (busy: boolean) => {
      socket.destroy();
      resolvePromise(busy);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(750, () => done(false));
  });
}

const startup = await resolveGatewayForRun({
  runId,
  base: resolvedConfig.base,
  port: resolvedConfig.port,
  token: resolvedConfig.token,
  autoStartAllowed: resolvedConfig.autoStartAllowed,
  hasCliEntry: cliEntry !== null,
  probe: probeGateway,
  servesRun: (candidate) => gatewayServesRun(candidate, runId),
  autoStart: autoStartGateway,
  findFreePort,
  isPortBusy,
  // The workspace singleton gateway (`smithers gateway`) records its url +
  // token in a per-workspace runtime state file. Reusing it means the monitor
  // attaches to the SAME gateway other tooling talks to — instead of trying an
  // autostart the singleton guard would refuse anyway (GATEWAY_ALREADY_RUNNING).
  // An explicit --port / SMITHERS_GATEWAY_PORT still wins when a gateway
  // actually answers there; when it doesn't, using the live singleton beats a
  // guaranteed-failing autostart — we just say so.
  discoverWorkspaceGateway: async () => {
    const state = readWorkspaceGatewayState(process.cwd());
    if (!state) return null;
    let port: number;
    try {
      port = Number(new URL(state.url).port) || 80;
    } catch {
      return null;
    }
    if (resolvedConfig.portExplicit && port !== resolvedConfig.port) {
      // Branch-neutral wording: this closure runs from several branches of
      // resolveGatewayForRun (configured port unreachable, reachable-but-wrong-
      // workspace, and the autostart race), so it must not claim "no gateway
      // answered on the configured port" — a gateway DID answer in the
      // wrong-workspace branch. State only what is always true here: the
      // workspace gateway sits on a different port than the configured one.
      process.stderr.write(
        `[smithers-mon] Note: the workspace gateway is on port ${port}, not the configured ${resolvedConfig.port}; ` +
          `checking it at ${state.url}…\n`,
      );
    }
    return { base: state.url, port, token: state.token ?? resolvedConfig.token };
  },
  log: (message) => process.stderr.write(`[smithers-mon] ${message}\n`),
});

if (startup.kind === "error") {
  process.stderr.write(`[smithers-mon] ${startup.message}\n`);
  process.exit(1);
}

const GATEWAY_BASE = startup.base;
const GATEWAY_TOKEN = startup.token;

const renderer = await createCliRenderer({ exitOnCtrlC: false });

const root = createRoot(renderer);

/**
 * Centralized teardown for every post-render quit path. OpenTUI puts the
 * terminal into raw mode and registers native/stdin listeners; a bare
 * `process.exit()` from inside React would skip that cleanup and leave the
 * terminal wedged. So unmount the React tree (runs effect cleanups), destroy the
 * renderer (restores cooked mode + native state), THEN exit. The quit key and
 * Ctrl-C both route through here via `App`'s `onExit` prop.
 *
 * `tearingDown` guards against double-invocation: a SIGTERM that lands while
 * React is mid-unmount (or a second signal) must not unmount/destroy twice — it
 * just exits.
 */
let tearingDown = false;

// External SIGINT/SIGTERM/SIGHUP after raw mode is enabled would otherwise kill
// the process WITHOUT running OpenTUI's cleanup, leaving the terminal wedged
// (no echo, raw mode stuck). Route them through the SAME teardown as `q`/Ctrl-C.
// 128 + signal number is the conventional exit code (SIGHUP 1, SIGINT 2, SIGTERM 15).
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
type TeardownSignal = keyof typeof SIGNAL_EXIT_CODES;
const TEARDOWN_SIGNALS = Object.keys(SIGNAL_EXIT_CODES) as TeardownSignal[];

function onSignal(signal: TeardownSignal): void {
  onExit(SIGNAL_EXIT_CODES[signal]);
}

function onExit(code: number): never {
  if (tearingDown) {
    // Already torn down once (or re-entered from a second signal); just leave.
    process.exit(code);
  }
  tearingDown = true;
  // Remove our signal handlers first so a stray second signal during teardown
  // can't re-enter this path or leak listeners.
  for (const signal of TEARDOWN_SIGNALS) process.removeListener(signal, onSignal);
  try {
    root.unmount();
  } catch {
    /* tree already gone */
  }
  try {
    renderer.destroy();
  } catch {
    /* renderer already torn down */
  }
  process.exit(code);
}

for (const signal of TEARDOWN_SIGNALS) process.on(signal, onSignal);

const client = new SmithersGatewayClient({
  baseUrl: GATEWAY_BASE,
  WebSocket: globalThis.WebSocket,
  // Authenticate RPC + WS when a token is configured; the gateway rejects
  // unauthenticated calls whenever SMITHERS_API_KEY (or --token) is set.
  token: GATEWAY_TOKEN,
});

root.render(
  <ErrorBoundary onExit={onExit}>
    <RendererProvider value={renderer}>
      <Keybindings>
        <SmithersGatewayProvider client={client}>
          <App runId={runId} onExit={onExit} />
        </SmithersGatewayProvider>
      </Keybindings>
    </RendererProvider>
  </ErrorBoundary>,
);
