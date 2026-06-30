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
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { Theme } from "./Theme.tsx";
import { Keybindings } from "./Keybindings.tsx";
import { RendererProvider } from "./RendererContext.tsx";
import { App } from "./App.tsx";

const GATEWAY_PORT = 7331;
const GATEWAY_BASE = `http://127.0.0.1:${GATEWAY_PORT}`;

if (!process.stdout.isTTY) {
  process.stderr.write("smithers-mon: stdout is not a TTY\n");
  process.exit(1);
}

const args = process.argv.slice(2);
const runId = args[0];
if (!runId) {
  process.stderr.write("Usage: smithers-mon <runId>\n");
  process.exit(1);
}

async function probeGateway(): Promise<boolean> {
  return fetch(`${GATEWAY_BASE}/health`).then((r) => r.ok, () => false);
}

async function autoStartGateway(): Promise<boolean> {
  try {
    // When launched from the CLI via SMITHERS_CLI env var, use that path so the
    // gateway command is routed through the real CLI entry point, not the TUI.
    const cliPath = process.env.SMITHERS_CLI ?? process.argv[1]!;
    const child = spawn(process.argv[0]!, [cliPath, "gateway", "--host", "127.0.0.1", "--port", String(GATEWAY_PORT)], {
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
  process.stderr.write(`[smithers-mon] No Gateway at ${GATEWAY_BASE}; starting one…\n`);
  reachable = await autoStartGateway();
}
if (!reachable) {
  process.stderr.write(`[smithers-mon] Could not reach or start Gateway at ${GATEWAY_BASE}\n`);
  process.exit(1);
}

const renderer = await createCliRenderer({ exitOnCtrlC: false });

const client = new SmithersGatewayClient({
  baseUrl: GATEWAY_BASE,
  WebSocket: globalThis.WebSocket,
});

const collections = createGatewayCollections({
  client: createSmithersGatewayTransport(client),
});

createRoot(renderer).render(
  <ErrorBoundary>
    <Theme>
      <RendererProvider value={renderer}>
        <Keybindings>
          <SmithersGatewayProvider client={client}>
            <SyncProvider client={collections}>
              <App runId={runId} />
            </SyncProvider>
          </SmithersGatewayProvider>
        </Keybindings>
      </RendererProvider>
    </Theme>
  </ErrorBoundary>,
);
