import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createTempRepo, runSmithers, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

const children = new Set();

afterEach(async () => {
  await Promise.all([...children].map((entry) => stopProcess(entry.child, entry.closePromise)));
  children.clear();
});

async function findOpenPort() {
  const server = createNetServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate an open port");
  }
  return address.port;
}

async function startFakeGateway() {
  const requests = [];
  const server = createHttpServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake Gateway did not bind to a TCP port");
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

async function stopProcess(child, closePromise) {
  if (child.exitCode !== null || child.signalCode) {
    await closePromise;
    return;
  }
  child.kill("SIGTERM");
  const closed = await Promise.race([
    closePromise.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
  ]);
  if (!closed) {
    child.kill("SIGKILL");
    await closePromise;
  }
}

async function stopGatewayOnPort(port) {
  const result = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
  const pids = (result.stdout ?? "")
    .split(/\s+/)
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (pids.length === 0) return;
  await waitFor(
    () =>
      pids.every((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }),
    2_000,
  ).catch(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
}

function spawnSmithers(args, options) {
  const child = spawn(process.execPath, ["run", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closePromise = new Promise((resolvePromise) => child.once("close", resolvePromise));
  children.add({ child, closePromise });
  return { child, closePromise };
}

// The fake gateway lives in this test process, so fake-gateway tests must
// spawn the CLI asynchronously — spawnSync (runSmithers) would block the
// event loop and the fake server could never answer the CLI's /health probe.
async function runSmithersAsync(args, options) {
  const { child, closePromise } = spawnSmithers([...args, "--format", options.format ?? "json"], options);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await closePromise;
  return { exitCode, stdout, stderr, json: parseEnvelope(stdout) };
}

function parseEnvelope(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Expected a JSON envelope on stdout but got nothing. stdout=${JSON.stringify(stdout)}`);
  }
  const candidates = [trimmed];
  const lastObjectStart = trimmed.lastIndexOf("\n{");
  if (lastObjectStart >= 0) candidates.push(trimmed.slice(lastObjectStart + 1));
  const firstObjectStart = trimmed.indexOf("{");
  if (firstObjectStart > 0) candidates.push(trimmed.slice(firstObjectStart));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  throw new Error(`Could not parse a JSON envelope from stdout. stdout=${JSON.stringify(stdout)}`);
}

async function waitFor(predicate, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for condition");
}

describe("smithers monitor", () => {
  test("prints the gateway's /monitor URL without any RPC beyond the health probe", async () => {
    const repo = createTempRepo();
    const gateway = await startFakeGateway();
    try {
      const result = await runSmithersAsync(["monitor", "--gateway", gateway.base, "--no-open"], {
        cwd: repo.dir,
        format: "json",
      });
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        opened: false,
        url: `${gateway.base}/monitor`,
        gateway: gateway.base,
        runId: null,
      });
      // A monitor open is pure observation: one health probe, zero RPCs.
      expect(gateway.requests).toEqual(["/health"]);
    } finally {
      await gateway.close();
    }
  }, 30_000);

  test("deep-links a run id as ?runId=", async () => {
    const repo = createTempRepo();
    const gateway = await startFakeGateway();
    try {
      const result = await runSmithersAsync(["monitor", "run-focus/1", "--gateway", gateway.base, "--no-open"], {
        cwd: repo.dir,
        format: "json",
      });
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        opened: false,
        url: `${gateway.base}/monitor?runId=run-focus%2F1`,
        runId: "run-focus/1",
      });
    } finally {
      await gateway.close();
    }
  }, 30_000);

  test("emits a JSON error envelope when no Gateway is reachable and autostart is disabled", async () => {
    const repo = createTempRepo();
    const port = await findOpenPort();
    const result = runSmithers(["monitor", "--port", String(port), "--no-autostart"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(4);
    const envelope = result.json;
    expect(envelope).toMatchObject({ code: "GATEWAY_UNREACHABLE" });
    expect(envelope.message).toContain("No Smithers Gateway reachable for this workspace");
    expect(envelope.message).toContain("smithers gateway");
  }, 30_000);

  test("respects SMITHERS_NO_DAEMON: refuses to autostart and says why", async () => {
    const repo = createTempRepo();
    const port = await findOpenPort();
    const result = runSmithers(["monitor", "--port", String(port)], {
      cwd: repo.dir,
      format: "json",
      env: { SMITHERS_NO_DAEMON: "1" },
      timeoutMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.json?.code).toBe("GATEWAY_UNREACHABLE");
    expect(result.json?.message).toContain("Gateway autostart is disabled");
  }, 30_000);

  test("autostarts the workspace gateway and the served /monitor page really renders", async () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
    const port = await findOpenPort();
    try {
      const { child, closePromise } = spawnSmithers(
        ["monitor", "--port", String(port), "--no-open", "--format", "json"],
        { cwd: repo.dir },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const exitCode = await Promise.race([closePromise, waitFor(() => stdout.includes("/monitor")).then(() => 0)]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("starting one (smithers gateway)");
      const envelope = parseEnvelope(stdout);
      expect(envelope).toMatchObject({
        opened: false,
        url: `http://127.0.0.1:${port}/monitor`,
        runId: null,
      });
      // The mount is real: the gateway serves the monitor's HTML shell
      // (boot config + module script) and Bun-bundles the client entry.
      const page = await fetch(envelope.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type") ?? "").toContain("text/html");
      const html = await page.text();
      expect(html).toContain("__SMITHERS_GATEWAY_UI__");
      const assetMatch = html.match(/src="([^"]+client\.js)"/);
      expect(assetMatch).not.toBeNull();
      const asset = await fetch(`http://127.0.0.1:${port}${assetMatch[1]}`, {});
      expect(asset.status).toBe(200);
      const bundle = await asset.text();
      expect(bundle).toContain("Smithers Monitor");
    } finally {
      await stopGatewayOnPort(port);
    }
  }, 90_000);
});
