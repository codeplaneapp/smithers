// smithers-source: authored
// smithers-display-name: VCS
// smithers-description: Inspect and act on a git or jj working tree. Status and log are deterministic; commit messages and rebase plans are written by an agent.
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers, Task, Sequence } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { z } from "zod/v4";
import { agents } from "../agents";
import { resolveJjBinary } from "@smithers-orchestrator/vcs/resolveJjBinary";

const NL = String.fromCharCode(10);

const changeSchema = z.object({
  path: z.string(),
  code: z.string(),
  staged: z.boolean(),
});

const statusSchema = z.looseObject({
  tool: z.string(),
  isRepo: z.boolean(),
  branch: z.string().nullable().default(null),
  head: z.string().nullable().default(null),
  clean: z.boolean(),
  changeCount: z.number().default(0),
  changes: z.array(changeSchema).default([]),
  summary: z.string(),
});

const commitSchema = z.object({ id: z.string(), subject: z.string() });

const logSchema = z.looseObject({
  tool: z.string(),
  isRepo: z.boolean(),
  commits: z.array(commitSchema).default([]),
  summary: z.string(),
});

const diffSchema = z.looseObject({
  tool: z.string(),
  isRepo: z.boolean(),
  files: z.array(z.string()).default([]),
  patch: z.string(),
  truncated: z.boolean().default(false),
});

const messageSchema = z.looseObject({
  message: z.string(),
  command: z.string(),
});

const rebasePlanSchema = z.looseObject({
  summary: z.string(),
  steps: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  action: z.enum(["status", "log", "commit", "rebase-plan"]).default("status"),
  vcs: z.enum(["git", "jj"]).default("git"),
});

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  status: statusSchema,
  log: logSchema,
  diff: diffSchema,
  message: messageSchema,
  rebasePlan: rebasePlanSchema,
});

// --- Deterministic git/jj readers: resolved executables, no agent involved. ---
function run(tool: string, args: string[]): { ok: boolean; out: string } {
  try {
    const executable = tool === "jj" ? resolveJjBinary().path : tool;
    const out = execFileSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { ok: true, out };
  } catch (err: unknown) {
    const stdout = (err as { stdout?: unknown })?.stdout;
    return { ok: false, out: typeof stdout === "string" ? stdout : "" };
  }
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(NL)
    .map((line) => line)
    .filter((line) => line.trim().length > 0);
}

function readStatus(tool: string) {
  if (tool === "jj") {
    if (!run("jj", ["root"]).ok) {
      return {
        tool,
        isRepo: false,
        branch: null,
        head: null,
        clean: true,
        changeCount: 0,
        changes: [],
        summary: "Not a jj repository",
      };
    }
    const st = run("jj", ["status"]);
    const head = run("jj", ["log", "-r", "@", "-n", "1", "--no-graph", "-T", "change_id.short()"]);
    const changes = nonEmptyLines(st.out)
      .map((line) => line.trim())
      .filter(
        (line) =>
          !line.startsWith("Working copy") && !line.startsWith("Parent commit") && !line.startsWith("The working copy"),
      )
      .map((line) => ({ path: line.slice(1).trim(), code: line.slice(0, 1), staged: true }));
    return {
      tool,
      isRepo: true,
      branch: "@",
      head: head.ok ? head.out.trim() : null,
      clean: changes.length === 0,
      changeCount: changes.length,
      changes,
      summary: changes.length === 0 ? "Working copy clean" : changes.length + " change(s) in the working copy",
    };
  }
  if (!run("git", ["rev-parse", "--is-inside-work-tree"]).ok) {
    return {
      tool,
      isRepo: false,
      branch: null,
      head: null,
      clean: true,
      changeCount: 0,
      changes: [],
      summary: "Not a git repository",
    };
  }
  const st = run("git", ["status", "--porcelain=v1"]);
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = run("git", ["rev-parse", "--short", "HEAD"]);
  const changes = st.out
    .split(NL)
    .filter((line) => line.length >= 3)
    .map((line) => {
      const x = line.slice(0, 1);
      let path = line.slice(3).trim();
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) path = path.slice(arrow + 4);
      return { path, code: line.slice(0, 2).trim() || "?", staged: x !== " " && x !== "?" };
    });
  return {
    tool,
    isRepo: true,
    branch: branch.ok ? branch.out.trim() : null,
    head: head.ok ? head.out.trim() : null,
    clean: changes.length === 0,
    changeCount: changes.length,
    changes,
    summary: changes.length === 0 ? "Working tree clean" : changes.length + " changed file(s)",
  };
}

function readLog(tool: string) {
  const repoArgs = tool === "jj" ? ["root"] : ["rev-parse", "--is-inside-work-tree"];
  if (!run(tool, repoArgs).ok) {
    return { tool, isRepo: false, commits: [], summary: "Not a " + tool + " repository" };
  }
  const out =
    tool === "jj" ? run("jj", ["log", "-n", "15", "--no-graph"]).out : run("git", ["log", "--oneline", "-n", "15"]).out;
  const commits = nonEmptyLines(out).map((line) => {
    const sp = line.indexOf(" ");
    return sp > 0 ? { id: line.slice(0, sp), subject: line.slice(sp + 1).trim() } : { id: line, subject: "" };
  });
  return {
    tool,
    isRepo: true,
    commits,
    summary: commits.length + " recent " + (tool === "jj" ? "change(s)" : "commit(s)"),
  };
}

function readDiff(tool: string) {
  if (tool === "jj") {
    if (!run("jj", ["root"]).ok) return { tool, isRepo: false, files: [], patch: "", truncated: false };
    const d = run("jj", ["diff", "--git"]);
    return { tool, isRepo: true, files: [], patch: d.out.slice(0, 8000), truncated: d.out.length > 8000 };
  }
  if (!run("git", ["rev-parse", "--is-inside-work-tree"]).ok)
    return { tool, isRepo: false, files: [], patch: "", truncated: false };
  let d = run("git", ["diff", "--staged"]);
  if (d.out.trim().length === 0) d = run("git", ["diff"]);
  const files = nonEmptyLines(run("git", ["diff", "--name-only"]).out);
  return { tool, isRepo: true, files, patch: d.out.slice(0, 8000), truncated: d.out.length > 8000 };
}

/**
 * One dispatcher workflow. The UI launches it with `action`, and the matching
 * sub-flow runs: status/log are pure reads; commit reads the diff then has an
 * agent draft the message; rebase-plan reads the log then has an agent plan it.
 */
export default smithers((ctx) => {
  // The launcher can pass null for omitted fields, which skips the zod defaults,
  // so coalesce here rather than trusting `.default()` to have run.
  const tool = ctx.input.vcs ?? "git";
  const action = ctx.input.action ?? "status";

  if (action === "log") {
    return (
      <Workflow name="vcs">
        <UI entry="../ui/vcs.tsx" title={"VCS"} />
        <Task id="vcs:log" output={logSchema}>
          {() => readLog(tool)}
        </Task>
      </Workflow>
    );
  }

  if (action === "commit") {
    const diff = ctx.outputMaybe("diff", { nodeId: "vcs:diff" }) as { patch?: string } | undefined;
    const patch =
      diff && typeof diff.patch === "string" && diff.patch.trim().length > 0
        ? diff.patch
        : "(no diff captured; write a representative message for the staged work)";
    return (
      <Workflow name="vcs">
        <UI entry="../ui/vcs.tsx" title={"VCS"} />
        <Sequence>
          <Task id="vcs:diff" output={diffSchema}>
            {() => readDiff(tool)}
          </Task>
          <Task id="vcs:message" output={messageSchema} agent={agents.smart}>
            {"Write ONE " +
              tool +
              " commit message for the staged diff below. Use the repo emoji + conventional-commit style (an emoji, then type(scope): summary). Return JSON with message (the full commit message) and command (the exact " +
              tool +
              " commit -m command). Plan only; do not run anything." +
              NL +
              NL +
              "DIFF:" +
              NL +
              patch}
          </Task>
        </Sequence>
      </Workflow>
    );
  }

  if (action === "rebase-plan") {
    const log = ctx.outputMaybe("log", { nodeId: "vcs:log" }) as
      | { commits?: Array<{ id: string; subject: string }> }
      | undefined;
    const history =
      log && Array.isArray(log.commits) && log.commits.length > 0
        ? log.commits.map((c) => c.id + " " + c.subject).join(NL)
        : "(history unavailable)";
    return (
      <Workflow name="vcs">
        <UI entry="../ui/vcs.tsx" title={"VCS"} />
        <Sequence>
          <Task id="vcs:log" output={logSchema}>
            {() => readLog(tool)}
          </Task>
          <Task id="vcs:rebasePlan" output={rebasePlanSchema} agent={agents.smart}>
            {"Plan how to rebase this " +
              tool +
              " branch onto its trunk (main), keeping the gate green. Return JSON with summary and ordered steps, each step a concrete " +
              tool +
              " command. Plan only; do not execute." +
              NL +
              NL +
              "RECENT HISTORY:" +
              NL +
              history}
          </Task>
        </Sequence>
      </Workflow>
    );
  }

  return (
    <Workflow name="vcs">
      <UI entry="../ui/vcs.tsx" title={"VCS"} />
      <Task id="vcs:status" output={statusSchema}>
        {() => readStatus(tool)}
      </Task>
    </Workflow>
  );
});
