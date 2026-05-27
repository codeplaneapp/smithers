import { createServer } from "node:net";
import { exit } from "node:process";

type ManagedProcess = { name: string; process: Bun.Subprocess<"ignore", "pipe", "pipe"> };

const host = process.env.SMITHERS_STUDIO_2_HOST ?? "127.0.0.1";
const gatewayStartPort = numberFromEnv("SMITHERS_GATEWAY_PORT", 7331);
const ptyStartPort = numberFromEnv("SMITHERS_PTY_PORT", 7342);
const uiStartPort = numberFromEnv("SMITHERS_STUDIO_2_PORT", 5190);
const children: ManagedProcess[] = [];
let shuttingDown = false;

function numberFromEnv(key: string, fallback: number) {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${key} must be a TCP port number.`);
  return parsed;
}

async function isPortFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function findOpenPort(startPort: number) {
  for (let port = startPort; port <= startPort + 50; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No open port found from ${startPort} to ${startPort + 50}.`);
}

async function pipeStream(name: string, stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffered = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffered.trim()) console.log(`[${name}] ${buffered.trimEnd()}`);
      return;
    }
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) console.log(`[${name}] ${line}`);
  }
}

function spawnManaged(name: string, command: string[], env: Record<string, string> = {}, cwd = process.cwd()) {
  const child = {
    name,
    process: Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
  };
  children.push(child);
  void pipeStream(name, child.process.stdout);
  void pipeStream(name, child.process.stderr);
  void child.process.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`[dev] ${name} exited with code ${code}. Stopping dev stack.`);
      void shutdown(code || 1);
    }
  });
}

async function waitForHttpOk(url: string, timeoutMs = 20_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? ` (${lastError})` : ""}.`);
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.toReversed()) {
    if (child.process.exitCode === null) child.process.kill("SIGTERM");
  }
  await Promise.allSettled(children.map((child) => child.process.exited));
  exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`[dev] Received ${signal}. Stopping dev stack.`);
    void shutdown(0);
  });
}

async function main() {
  const gatewayPort = await findOpenPort(gatewayStartPort);
  const ptyPort = await findOpenPort(ptyStartPort);
  const uiPort = await findOpenPort(uiStartPort);
  const gatewayUrl = `http://${host}:${gatewayPort}`;
  const ptyUrl = `http://${host}:${ptyPort}`;
  const uiUrl = `http://${host}:${uiPort}`;

  console.log(`[dev] Starting Smithers Gateway on ${gatewayUrl}`);
  spawnManaged("gateway", ["bun", "apps/cli/src/index.js", "gateway", "serve", "--host", host, "--port", String(gatewayPort)]);
  await waitForHttpOk(`${gatewayUrl}/health`);

  console.log(`[dev] Starting PTY Server on ${ptyUrl}`);
  spawnManaged("pty", ["bun", "apps/smithers-studio-2/scripts/pty-server.ts"], {
    PTY_SERVER_HOST: host,
    PTY_SERVER_PORT: String(ptyPort),
  });
  await waitForHttpOk(`${ptyUrl}/health`);

  console.log(`[dev] Starting Smithers Studio 2 on ${uiUrl}`);
  spawnManaged("studio-2", ["node", "node_modules/vite/bin/vite.js", "--host", host, "--port", String(uiPort), "--strictPort"], {
    VITE_SMITHERS_GATEWAY_URL: gatewayUrl,
    VITE_SMITHERS_GATEWAY_RPC_PATH: "/v1/rpc",
    PTY_SERVER_URL: ptyUrl,
  }, "apps/smithers-studio-2");
  await waitForHttpOk(uiUrl);

  console.log("");
  console.log(`[dev] Studio 2: ${uiUrl}`);
  console.log(`[dev] Gateway:  ${gatewayUrl}`);
  console.log(`[dev] PTY:      ${ptyUrl}`);
  console.log("[dev] Press Ctrl+C to stop all processes.");
  await Promise.race(children.map((child) => child.process.exited));
}

main().catch((error) => {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  void shutdown(1);
});
