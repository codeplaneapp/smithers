import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";
import { loadInstances } from "./loadInstances.js";
import { runInstance } from "./runInstance.js";
import { summarizeResults } from "./summarizeResults.js";

/** Minimal Smithers Gateway RPC over HTTP: POST /v1/rpc/{method} → {ok,payload}. */
async function rpc(baseUrl, token, method, params) {
  const res = await fetch(`${baseUrl}/v1/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params ?? {}),
  });
  let frame;
  try {
    frame = await res.json();
  } catch {
    throw new Error(`gateway rpc ${method}: HTTP ${res.status}`);
  }
  if (frame && frame.ok === false) {
    throw new Error(`gateway rpc ${method} failed: ${JSON.stringify(frame.error ?? frame)}`);
  }
  return frame.payload ?? frame;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot the gateway server (scripts/gateway-server.js via bun) and wait until it
 * prints READY. Returns the base URL and a stop() handle.
 *
 * @param {object} opts
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {string} [opts.token]
 * @param {string} [opts.implementerModel]
 * @param {string} [opts.reviewerModel]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ baseUrl: string, token: string|undefined, key: string, stop: () => void }>}
 */
export function startGatewayServer(opts = {}) {
  const log = opts.log ?? (() => {});
  const port = opts.port ?? Number(process.env.SWEBP_GATEWAY_PORT ?? 7331);
  const host = opts.host ?? "127.0.0.1";
  const key = "swe-bench-pro";
  const runDir = join(config.workDir, "gateway");
  // Fresh gateway DB per benchmark invocation so fixed run ids do not collide.
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });

  const env = {
    ...process.env,
    SWEBP_GATEWAY_PORT: String(port),
    SWEBP_GATEWAY_HOST: host,
    SWEBP_GATEWAY_WORKFLOW_KEY: key,
    SWEBP_DB_PATH: join(runDir, "gateway.db"),
    SWEBP_IMPLEMENTER_MODEL: opts.implementerModel ?? process.env.SWEBP_IMPLEMENTER_MODEL ?? "gpt-5.5",
    SWEBP_REVIEWER_MODEL: opts.reviewerModel ?? process.env.SWEBP_REVIEWER_MODEL ?? "claude-fable-5",
    ...(opts.token ? { SWEBP_GATEWAY_TOKEN: opts.token } : {}),
  };

  log(`[gateway] starting server on http://${host}:${port}…`);
  const child = spawn("bun", [join(config.root, "scripts", "gateway-server.js")], { cwd: config.repoRoot, env });
  const out = [];
  child.stdout.on("data", (c) => out.push(c.toString()));
  child.stderr.on("data", (c) => out.push(c.toString()));

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 60_000;
    // Stop buffering gateway logs once startup resolves: the gateway is a
    // long-lived process serving the whole run, so leaving the data listeners
    // attached would grow `out` unbounded for hours.
    const stopBuffering = () => {
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      // Removing the sole "data" listener pauses the stream; libuv then keeps
      // reading the OS pipe into the stream's internal buffer, which is never
      // drained and grows unbounded for the life of the long-lived gateway.
      // resume() returns it to flowing mode with no consumer, so the bytes are
      // discarded instead of accumulated.
      child.stdout.resume();
      child.stderr.resume();
    };
    const check = setInterval(() => {
      const text = out.join("");
      if (text.includes("[gateway] READY")) {
        clearInterval(check);
        stopBuffering();
        log(`[gateway] ready`);
        resolve({
          baseUrl: `http://${host}:${port}`,
          token: opts.token,
          key,
          stop: () => child.kill("SIGKILL"),
        });
      } else if (Date.now() > deadline || child.exitCode != null) {
        clearInterval(check);
        stopBuffering();
        child.kill("SIGKILL");
        reject(new Error(`gateway failed to start:\n${out.join("")}`));
      }
    }, 250);
  });
}

/**
 * Build a `runWorkflow` strategy that launches the run through the gateway RPC
 * and polls `getRun` until the run reaches a terminal state. Drop-in for
 * `runInstance`'s `opts.runWorkflow` seam.
 *
 * @param {{ baseUrl: string, token?: string, key: string, pollMs?: number, log?: (m: string) => void }} cfg
 */
export function makeGatewayRunWorkflow(cfg) {
  const log = cfg.log ?? (() => {});
  const pollMs = cfg.pollMs ?? 4000;
  const terminal = new Set(["finished", "failed", "cancelled", "errored", "error"]);

  return async (instance, repoDir, o) => {
    const runId = `swebp-gw-${instance.instanceId}`.replace(/[^A-Za-z0-9_.-]/g, "-");
    const input = {
      instanceId: instance.instanceId,
      repoDir,
      repo: instance.repo,
      repoLanguage: instance.repoLanguage,
      problemStatement: instance.problemStatement,
      requirements: instance.requirements,
      interface: instance.interface,
    };
    log(`[gateway] ${instance.instanceId}: launchRun (${runId})…`);
    await rpc(cfg.baseUrl, cfg.token, "launchRun", { workflow: cfg.key, input, options: { runId } });

    const deadline = Date.now() + (o?.timeoutMs ?? 35 * 60 * 1000);
    while (Date.now() < deadline) {
      await sleep(pollMs);
      let run;
      try {
        run = await rpc(cfg.baseUrl, cfg.token, "getRun", { runId });
      } catch (err) {
        log(`[gateway] ${instance.instanceId}: getRun transient error: ${err.message}`);
        continue;
      }
      const status = run.status ?? run.state ?? run.run?.status;
      if (terminal.has(status)) {
        log(`[gateway] ${instance.instanceId}: run ${status}`);
        return { code: status === "finished" ? 0 : 1, runId, timedOut: false };
      }
    }
    return { code: 1, runId, timedOut: true };
  };
}

/**
 * Run the benchmark with patch generation launched through the gateway RPC.
 * Scoring and integrity controls are identical to the direct path.
 *
 * @param {object} opts  Same shape as runBenchmark, plus gateway options.
 * @returns {Promise<object>}
 */
export async function runGatewayBenchmark(opts) {
  const log = opts.log ?? ((m) => console.log(m));
  const instances = loadInstances({ ids: opts.ids, repos: opts.repos, languages: opts.languages, limit: opts.limit });
  if (!instances.length) throw new Error("no instances matched the selection");

  const server = await startGatewayServer({
    implementerModel: opts.implementerModel,
    reviewerModel: opts.reviewerModel,
    token: opts.token,
    log,
  });
  const runWorkflow = makeGatewayRunWorkflow({ ...server, log });

  const results = [];
  try {
    for (let i = 0; i < instances.length; i++) {
      const it = instances[i];
      log(`\n[bench:gateway] (${i + 1}/${instances.length}) ${it.instanceId}`);
      const r = await runInstance(it, {
        runWorkflow,
        skipIntegrity: opts.skipIntegrity,
        agentTimeoutMs: opts.agentTimeoutMs,
        scoreTimeoutMs: opts.scoreTimeoutMs,
        log,
      });
      results.push(r);
      log(`[bench:gateway] ${it.instanceId}: ${r.verdict}`);
    }
  } finally {
    server.stop();
  }

  const report = summarizeResults(results, {
    dataset: `${config.upstream.dataset}:${config.upstream.datasetSplit}`,
    transport: "gateway",
    models: {
      implementer: opts.implementerModel ?? process.env.SWEBP_IMPLEMENTER_MODEL ?? "gpt-5.5",
      reviewer: opts.reviewerModel ?? process.env.SWEBP_REVIEWER_MODEL ?? "claude-fable-5",
    },
    integrityChecked: !opts.skipIntegrity,
    finishedAtMs: opts.nowMs ?? null,
  });
  const reportPath = opts.reportPath ?? join(config.workDir, "reports", `gateway-report-${opts.nowMs ?? "latest"}.json`);
  mkdirSync(join(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log(`\n[bench:gateway] report → ${reportPath}`);
  log(`[bench:gateway] Pass@1 = ${report.totals.resolved}/${report.totals.counted} = ${(report.totals.passAt1 * 100).toFixed(1)}%`);
  return report;
}
