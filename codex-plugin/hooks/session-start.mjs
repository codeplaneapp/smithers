#!/usr/bin/env node
// Smithers Codex plugin: the SessionStart hook.
// Detects a Smithers 1.0 project and injects a short note so Codex reaches for
// Smithers instead of hand-rolling agents.
// Dependency-free: uses only Node built-ins. Never throws, because a hook that errors
// must not break the session, so all failures degrade to "no context injected".

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSmithersCli, resolveSmithersShellCommand } from "../lib/resolve-smithers-cli.mjs";

/** Cap the inline list; Codex can call list_workflows for the rest. */
export const MAX_LISTED = 12;

/** Statuses a run never leaves. `continued` is not one: rc.0 has no such status. */
export const TERMINAL_RUN_STATUSES = ["cancelled", "completed", "failed"];

/** The directory a 1.0 project keeps its flows in, relative to the project root. */
export const FLOWS_DIRECTORY = "flows";

/**
 * How long the hook waits on a CLI probe before giving up on it.
 *
 * The 0.x hook allowed two seconds, which is wrong for this CLI: a source
 * checkout strips types on every start, so `ls` and `ps` each take about five
 * seconds cold and a two-second cap silently reported every project as having
 * no flows. The two probes run concurrently under one budget wide enough for a
 * loaded machine, and `SMITHERS_HOOK_TIMEOUT_MS` overrides it.
 */
export const PROBE_TIMEOUT_MS = Number.parseInt(process.env.SMITHERS_HOOK_TIMEOUT_MS ?? "", 10) || 15000;

/** Reserved flow ids the CLI always projects; they say nothing about a project. */
const isProjectFlow = (flowId) => typeof flowId === "string" && !flowId.startsWith("system/");

/**
 * Runs one CLI subcommand and resolves its parsed JSON, or undefined when the
 * command is missing, slow, failing, or not printing JSON. The timeout is a
 * hard kill, so a wedged CLI cannot stall session start.
 *
 * @param {{ command: string, args: string[] }} cli
 * @param {string[]} argv
 * @param {string} cwd
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
export function probeJson(cli, argv, cwd, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cli.command, [...cli.args, ...argv, "--json"], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutMs,
      });
    } catch {
      resolve(undefined);
      return;
    }
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code !== 0 || out === "") return resolve(undefined);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(undefined);
      }
    });
  });
}

/**
 * The project flows `smithers ls` discovered, sorted, with the reserved
 * `system/*` entries dropped. Undefined means the probe could not answer.
 *
 * @param {{ command: string, args: string[] }} cli
 * @param {string} cwd
 * @returns {Promise<string[] | undefined>}
 */
export async function listProjectFlows(cli, cwd) {
  const parsed = await probeJson(cli, ["ls"], cwd);
  const items = Array.isArray(parsed?.items) ? parsed.items : undefined;
  if (items === undefined) return undefined;
  return items
    .map((item) => item?.flowId)
    .filter(isProjectFlow)
    .sort();
}

/**
 * Non-terminal runs in this project, as `smithers ps --json` reports them.
 * Undefined means the probe could not answer.
 *
 * @param {{ command: string, args: string[] }} cli
 * @param {string} cwd
 * @returns {Promise<number | undefined>}
 */
export async function countActiveRuns(cli, cwd) {
  const parsed = await probeJson(cli, ["ps"], cwd);
  const items = Array.isArray(parsed?.items) ? parsed.items : undefined;
  if (items === undefined) return undefined;
  const terminal = new Set(TERMINAL_RUN_STATUSES);
  return items.filter((run) => !terminal.has(String(run?.status ?? ""))).length;
}

/**
 * Reads the hook event JSON from stdin (Codex and Claude both pass it there).
 * Guarded so a manual run with no piped input never hangs. Resolves to `{}` on
 * anything unreadable.
 */
export function readStdinEvent() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let data = "";
    const done = (value) => {
      clearTimeout(timer);
      try {
        process.stdin.removeAllListeners();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => done({}), 250);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      try {
        done(data.trim() ? JSON.parse(data) : {});
      } catch {
        done({});
      }
    });
    process.stdin.on("error", () => done({}));
  });
}

/** Directory entries that mark a checkout root, so the walk stops there. */
export const BOUNDARY_MARKERS = [".git", ".jj"];

const isDirectory = (path) => {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Walks up from `start` looking for the project root: the nearest ancestor
 * holding a `flows/` directory.
 *
 * The walk is bounded, and the bound is the point. `flows` is an ordinary
 * directory name that plenty of unrelated trees use, so an unbounded walk
 * reports a Smithers project for any session started anywhere below one. The
 * walk therefore stops after the first ancestor that carries a checkout marker
 * (`.git`, `.jj`) and never leaves the user's home directory, which is where
 * the false positive that motivated this bound actually lived.
 *
 * @param {string} start
 * @param {string} [home]
 * @returns {string | undefined}
 */
export function findFlowsRoot(start, home = homedir()) {
  let directory = start;
  const { root } = parsePath(directory);
  for (let depth = 0; depth < 64; depth++) {
    if (isDirectory(join(directory, FLOWS_DIRECTORY))) return directory;
    const atBoundary = directory === root ||
      directory === home ||
      BOUNDARY_MARKERS.some((marker) => existsSync(join(directory, marker)));
    if (atBoundary) return undefined;
    directory = dirname(directory);
  }
  return undefined;
}

/**
 * The context block for a project. Pure apart from the values it is handed, so
 * the test suite drives it without a live engine.
 *
 * @param {{
 *   cli: { command: string, args: string[], source: string, root: string | null },
 *   cliCommand: string,
 *   flows: string[],
 *   activeRuns: number | undefined,
 * }} context
 * @returns {string}
 */
export function buildContext(context) {
  const { activeRuns, cli, cliCommand, flows } = context;
  const lines = [];
  lines.push("This project uses Smithers (a durable control plane for long-running coding agents).");
  lines.push(
    `You operate Smithers through the \`smithers\` MCP tools (list_workflows, run_workflow, watch_run, ` +
      `get_run, get_run_events, list_pending_approvals, resolve_approval, ...) and the \`smithers\` CLI ` +
      `(or \`${cliCommand} <cmd>\` if \`smithers\` is not on PATH). You are the orchestrator: run multi-step, ` +
      `long-running, or background work THROUGH Smithers, not through your own ad-hoc subagents.`,
  );
  lines.push(
    "AUTHORING MODEL: a flow is TypeScript or Markdown under `flows/<name>/`, built from `Flow.make`, " +
      "`Action.make`, and Effect. There is no JSX authoring API, no `<Task>`, and no React reconciler. " +
      `Run one with \`${cliCommand} up <flow> --data '{...}'\`, or plan it first with ` +
      `\`${cliCommand} plan <flow>\` and hand the printed approval payload to \`${cliCommand} approve\` and ` +
      `\`${cliCommand} run\`.`,
  );
  if (cli.source === "workspace") {
    lines.push(
      `SOURCE-CHECKOUT RULE: this project IS the Smithers source tree (${cli.root}). Every smithers command ` +
        `you run must execute the working tree, so invoke it as \`${cliCommand}\` (or plain \`smithers\`, ` +
        `which delegates to the same entry), never a package-runner invocation of the published CLI, which ` +
        `runs the released build instead of the code under edit. Running from source needs \`pnpm install\` ` +
        `and nothing else.`,
    );
  }
  if (typeof activeRuns === "number" && activeRuns > 0) {
    lines.push(
      `There ${activeRuns === 1 ? "is 1 non-terminal Smithers run" : `are ${activeRuns} non-terminal Smithers runs`}` +
        ` in this project; \`${cliCommand} ps\` lists them and \`${cliCommand} status <run-id>\` diagnoses one.`,
    );
  }
  if (flows.length) {
    const shown = flows.slice(0, MAX_LISTED).join(", ");
    const more = flows.length > MAX_LISTED
      ? `, +${flows.length - MAX_LISTED} more (call list_workflows for the full set)`
      : "";
    lines.push(`${flows.length} flow(s) in ${FLOWS_DIRECTORY}/: ${shown}${more}.`);
  } else {
    lines.push(`No flows in ${FLOWS_DIRECTORY}/ yet. Scaffold one with \`${cliCommand} init <name>\`.`);
  }
  lines.push(
    `AUTHORING REFERENCE: read https://smithers.sh/llms-full.txt before writing or editing flow code. ` +
      `Offline fallback: \`${cliCommand} docs --full\`.`,
  );
  return lines.join("\n");
}

function emit(additionalContext) {
  // Claude-compatible SessionStart hook output. Codex injects additionalContext
  // into the session preamble. Empty string => nothing injected.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }),
  );
}

/** True when this module was executed rather than imported by the test suite. */
const executed = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (executed) {
  try {
    const event = await readStdinEvent();
    const startDirectory = (typeof event.cwd === "string" && event.cwd) ||
      (typeof event.workspaceRoot === "string" && event.workspaceRoot) ||
      process.cwd();
    const root = findFlowsRoot(startDirectory);
    if (root === undefined) {
      emit("");
      process.exit(0);
    }
    const cli = resolveSmithersCli(root);
    // Concurrently, because each probe costs a CLI start and a session start
    // should pay for one of them, not two.
    const [flows, activeRuns] = await Promise.all([listProjectFlows(cli, root), countActiveRuns(cli, root)]);
    emit(
      buildContext({
        cli,
        cliCommand: resolveSmithersShellCommand(root),
        flows: flows ?? [],
        activeRuns,
      }),
    );
  } catch {
    emit("");
  }
}
