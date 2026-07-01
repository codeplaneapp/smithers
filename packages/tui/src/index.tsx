#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { SmithersGatewayClient, createSmithersGatewayTransport } from "@smithers-orchestrator/gateway-client";
import {
  SmithersGatewayProvider,
  SyncProvider,
  createGatewayCollections,
} from "@smithers-orchestrator/gateway-react";
import { spawn } from "node:child_process";
import { resolveGatewayConfig } from "./gatewayConfig.ts";
import { resolveCliEntry } from "./cliEntry.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { Keybindings } from "./Keybindings.tsx";
import { RendererProvider } from "./RendererContext.tsx";
import { App } from "./App.tsx";

const USAGE = "Usage: smithers-mon <runId> [--gateway <url>] [--port <n>]\n";

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
if (portArg !== undefined && (!Number.isInteger(portArg) || portArg < 1 || portArg > 65535)) {
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
const { base: GATEWAY_BASE, port: GATEWAY_PORT, autoStartAllowed: AUTOSTART_ALLOWED } = resolveGatewayConfig({
  gatewayUrlArg,
  portArg,
  env: process.env,
});

async function probeGateway(): Promise<boolean> {
  return fetch(`${GATEWAY_BASE}/health`).then((r) => r.ok, () => false);
}

// Resolve the REAL CLI entry to autostart the gateway through. Never fall back
// to process.argv[1] — that is this TUI entry, so spawning it would recursively
// launch another monitor instead of a gateway.
const cliEntry = resolveCliEntry();

async function autoStartGateway(): Promise<boolean> {
  if (!cliEntry) return false;
  try {
    const child = spawn(process.argv[0]!, [cliEntry, "gateway", "--host", "127.0.0.1", "--port", String(GATEWAY_PORT)], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    child.on("error", () => {});
  } catch {
    return false;
  }
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(500);
    if (await probeGateway()) return true;
  }
  return false;
}

let reachable = await probeGateway();
if (!reachable) {
  if (!AUTOSTART_ALLOWED) {
    // The user pinned an explicit gateway (--gateway / SMITHERS_GATEWAY_URL).
    // Never autostart a detached LOCAL gateway they didn't ask for and that the
    // monitor wouldn't even connect to — just report the pinned one is down.
    process.stderr.write(
      `[smithers-mon] Gateway at ${GATEWAY_BASE} is unreachable.\n` +
        `  Start it (or fix the address), then retry.\n`,
    );
  } else if (cliEntry) {
    process.stderr.write(`[smithers-mon] No Gateway at ${GATEWAY_BASE}; starting one…\n`);
    reachable = await autoStartGateway();
  } else {
    process.stderr.write(
      `[smithers-mon] No Gateway at ${GATEWAY_BASE} and no smithers CLI entry to autostart one.\n` +
        `  Start it with \`smithers gateway\` (or pass --gateway <url>), then retry.\n`,
    );
  }
}
if (!reachable) {
  process.stderr.write(`[smithers-mon] Could not reach or start Gateway at ${GATEWAY_BASE}\n`);
  process.exit(1);
}

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
});

const collections = createGatewayCollections({
  client: createSmithersGatewayTransport(client),
});

root.render(
  <ErrorBoundary onExit={onExit}>
    <RendererProvider value={renderer}>
      <Keybindings>
        <SmithersGatewayProvider client={client}>
          <SyncProvider client={collections}>
            <App runId={runId} onExit={onExit} />
          </SyncProvider>
        </SmithersGatewayProvider>
      </Keybindings>
    </RendererProvider>
  </ErrorBoundary>,
);
