import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

// Executes the plugin's ACTUAL generic mirror script
// (claude-plugin/workflows/smithers-run.mjs) end to end against a real
// detached run. The harness plays the Workflow runtime: it provides the
// sandbox globals and implements agent() by executing the script's own
// `RUN-EXACTLY:` command (through the local CLI entry instead of bunx) or
// returning its `RETURN-EXACTLY` block verbatim — the same deterministic
// contract the prompts give a real subagent. The only simulated component is
// the LLM, which CI cannot run; every command, store row, and state
// transition is real.

const SCRIPT_PATH = resolve(import.meta.dir, "../../../claude-plugin/workflows/smithers-run.mjs");
const CLI_ENTRY = resolve(import.meta.dir, "../src/index.js");

const FANOUT_WORKFLOW = `
/** @jsxImportSource smthrs */
import { createSmithers, Parallel, Task, Workflow, Sequence } from "smthrs";
import { z } from "zod";

const { smithers, outputs } = createSmithers({
  items: z.object({ items: z.array(z.string()) }),
  result: z.object({ value: z.string() }),
});

export default smithers((ctx) => {
  const seed = ctx.outputMaybe("items", { nodeId: "seed" });
  return (
    <Workflow name="mirror-harness-e2e">
      <Sequence label="Plan">
        <Task id="seed" output={outputs.items}>
          {{ items: ["alpha", "beta"] }}
        </Task>
        {seed ? (
          <Parallel label="Audit">
            {seed.items.map((it) => (
              <Task id={\`audit-\${it}\`} output={outputs.result}>
                {{ value: it }}
              </Task>
            ))}
          </Parallel>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
`;

/**
 * Build the Workflow-runtime shape of the script: `export const meta` becomes
 * a local, and the body runs inside an async function with the runtime
 * globals as parameters (top-level await/return work exactly like the real
 * sandbox).
 */
function loadScriptBody() {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  expect(source.startsWith("export const meta = {")).toBe(true);
  return source.replace(/^export const meta = /m, "const meta = ");
}

/** @param {string} command @param {string} cwd */
function execMirrorCommand(command, cwd) {
  // The script targets `bunx smthrs`; tests run the same CLI
  // from the workspace so they exercise the code under review, not npm.
  const localized = command.replaceAll("bunx smthrs", `bun ${CLI_ENTRY}`);
  const result = spawnSync("bash", ["-c", localized], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
    env: { ...process.env, SMITHERS_BACKEND: "sqlite" },
  });
  return { stdout: result.stdout ?? "", status: result.status ?? 1 };
}

/**
 * The harness agent: deterministic execution of the prompt's declared
 * contract. Mirrors what the prompts instruct a low-effort subagent to do.
 * @param {{ cwd: string; calls: any[] }} state
 */
function harnessAgent(state) {
  return async (prompt, opts = {}) => {
    state.calls.push({ label: opts.label, phase: opts.phase, schema: Boolean(opts.schema) });
    const echo = prompt.match(/RETURN-EXACTLY-BEGIN\n([\s\S]*?)\nRETURN-EXACTLY-END/);
    if (echo) {
      return echo[1];
    }
    const run = prompt.match(/^RUN-EXACTLY: (.+)$/m);
    expect(run, `agent prompt without RUN-EXACTLY/RETURN-EXACTLY:\n${prompt}`).toBeTruthy();
    // node-wait watchers are told to re-run while timedOut is true.
    const isNodeWait = run[1].includes("claude node-wait");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { stdout, status } = execMirrorCommand(run[1], state.cwd);
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        parsed = undefined;
      }
      if (opts.schema) {
        if (!parsed || status !== 0) {
          // The tick prompt's declared failure shape.
          return {
            contract: -1,
            runId: "",
            status: "error",
            seq: 0,
            phases: [],
            nodes: [],
            error: stdout.slice(0, 200),
          };
        }
        return parsed;
      }
      if (isNodeWait && parsed) {
        if (parsed.timedOut === true) {
          continue;
        }
        if (parsed.vanished === true) {
          return "[skipped]";
        }
        if (parsed.state === "failed") {
          return `[failed] ${parsed.output ?? ""}`;
        }
        if (parsed.state === "cancelled") {
          return "[cancelled]";
        }
        return parsed.output && parsed.output.length > 0 ? parsed.output : "[no output]";
      }
      return stdout;
    }
    return "[no output]";
  };
}

/**
 * @param {{ dir: string }} repo
 * @param {any} args
 * @param {(base: Function) => Function} [decorateAgent] wrap the harness agent,
 *   e.g. to simulate an agent() call dying on a terminal API error (null).
 */
async function runMirrorScript(repo, args, decorateAgent) {
  const state = { cwd: repo.dir, calls: [], phases: [], logs: [] };
  const AsyncFunction = (async () => {}).constructor;
  const body = new AsyncFunction(
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "args",
    "budget",
    "workflow",
    loadScriptBody(),
  );
  const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk().catch(() => null)));
  const pipeline = async (items, ...stages) => {
    const results = [];
    for (const item of items) {
      let value = item;
      for (const stage of stages) {
        value = await stage(value, item, results.length);
      }
      results.push(value);
    }
    return results;
  };
  const baseAgent = harnessAgent(state);
  const result = await body(
    decorateAgent ? decorateAgent(baseAgent) : baseAgent,
    parallel,
    pipeline,
    (title) => state.phases.push(title),
    (message) => state.logs.push(message),
    args,
    { total: null, spent: () => 0, remaining: () => Infinity },
    () => {
      throw new Error("workflow() is not available to the mirror");
    },
  );
  return { result, state };
}

const TERMINAL = new Set(["finished", "failed", "cancelled", "continued"]);

describe("smithers-run.mjs mirror script (harness, real run)", () => {
  test("attach mode mirrors a finished fan-out run: phases, rows, outputs, summary", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write("workflow.tsx", FANOUT_WORKFLOW);

    const runId = "mirror-harness-attach";
    const up = runSmithers(["up", "workflow.tsx", "--detach", "--run-id", runId], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(up.exitCode, `${up.stdout}\n${up.stderr}`).toBe(0);
    for (let index = 0; index < 100; index += 1) {
      const probe = runSmithers(["claude", "tick", runId], { cwd: repo.dir, format: "json" });
      if (probe.exitCode === 0 && probe.json && TERMINAL.has(probe.json.status)) {
        break;
      }
      Bun.sleepSync(150);
    }

    // args arrive as a JSON string sometimes; the script must normalize.
    const { result, state } = await runMirrorScript(
      repo,
      JSON.stringify({
        runId,
        cwd: repo.dir,
        mirrorAllNodes: true,
      }),
    );

    expect(result.runId).toBe(runId);
    expect(result.status).toBe("finished");
    expect(result.mirrored).toBeGreaterThanOrEqual(3);
    expect(state.phases).toContain("Plan");
    expect(state.phases).toContain("Audit");
    const labels = state.calls.map((call) => call.label);
    // The run-level tick row (labeled `sync` before mirror 0.2.2, now
    // `tick #N · <status>`) plus one mirrored row per workflow node.
    expect(labels.some((label) => /^tick #\d+ · /.test(String(label)))).toBe(true);
    expect(labels).toContain("seed");
    expect(labels).toContain("audit-alpha");
    expect(labels).toContain("audit-beta");
    const auditCall = state.calls.find((call) => call.label === "audit-alpha");
    expect(auditCall.phase).toBe("Audit");
    expect(state.logs.some((line) => line.includes("Mirror complete"))).toBe(true);
  }, 90_000);

  test("a transient null tick (agent died on an API error) retries instead of stopping the mirror", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write("workflow.tsx", FANOUT_WORKFLOW);

    const runId = "mirror-harness-nulltick";
    const up = runSmithers(["up", "workflow.tsx", "--detach", "--run-id", runId], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: 120_000,
    });
    expect(up.exitCode, `${up.stdout}\n${up.stderr}`).toBe(0);
    for (let index = 0; index < 100; index += 1) {
      const probe = runSmithers(["claude", "tick", runId], { cwd: repo.dir, format: "json" });
      if (probe.exitCode === 0 && probe.json && TERMINAL.has(probe.json.status)) {
        break;
      }
      Bun.sleepSync(150);
    }

    // The first tick agent dies the way the Workflow runtime reports a
    // terminal API error: agent() resolves to null. The mirror must retry
    // (the run did not change state), not stop.
    let nulledTicks = 0;
    const { result, state } = await runMirrorScript(
      repo,
      { runId, cwd: repo.dir, mirrorAllNodes: true },
      (base) => async (prompt, opts = {}) => {
        if (nulledTicks === 0 && /^tick #\d+/.test(String(opts.label))) {
          nulledTicks += 1;
          return null;
        }
        return base(prompt, opts);
      },
    );

    expect(nulledTicks).toBe(1);
    expect(result.runId).toBe(runId);
    expect(result.status).toBe("finished");
    expect(result.mirrored).toBeGreaterThanOrEqual(3);
    expect(state.logs.some((line) => line.includes("failed (transient API error); retrying"))).toBe(true);
    expect(state.logs.some((line) => line.includes("Mirror complete"))).toBe(true);
  }, 90_000);

  test("launch mode starts the detached run itself and follows it to terminal", async () => {
    const repo = createTempRepo();
    pinSqliteBackend(repo.dir);
    repo.write(".smithers/workflows/mirror-harness-launch.tsx", FANOUT_WORKFLOW);

    const { result, state } = await runMirrorScript(repo, {
      workflow: "mirror-harness-launch",
      cwd: repo.dir,
      mirrorAllNodes: true,
    });

    expect(typeof result.runId).toBe("string");
    expect(result.runId.length).toBeGreaterThan(0);
    expect(result.status).toBe("finished");
    expect(state.logs.some((line) => line.includes(`Detached Smithers run ${result.runId} started`))).toBe(true);
    expect(state.phases).toContain("Audit");
    expect(result.mirrored).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
