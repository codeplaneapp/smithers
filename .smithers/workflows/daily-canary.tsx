// smithers-display-name: Daily canary (system)
// smithers-description: Daily workflow-backed canaries for fresh init and persistent workspace memory, with smart-model bug hunting over the past week of git history.
// smithers-tags: system, canary, memory
// smithers-system: true
/** @jsxImportSource smithers-orchestrator */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CodexAgent, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  mode: z.enum(["fresh", "persistent"]).default("fresh"),
  workspaceDir: z.string().default(""),
  runLabel: z.string().default(new Date().toISOString().slice(0, 10)),
  lruLimit: z.number().int().positive().default(30),
  runHello: z.boolean().default(true),
  summaryPath: z.string().default(""),
});

const commandSchema = z.object({
  command: z.string(),
  cwd: z.string(),
  ok: z.boolean(),
  status: z.number().nullable(),
  durationMs: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});

const prepareSchema = z.object({
  mode: z.string(),
  repoRoot: z.string(),
  workspaceDir: z.string(),
  cliPath: z.string(),
  runLabel: z.string(),
});

const canarySchema = z.object({
  ok: z.boolean(),
  workspaceDir: z.string(),
  commands: z.array(commandSchema),
  summary: z.string(),
});

const memorySchema = z.looseObject({
  namespace: z.string(),
  key: z.string(),
  entries: z.array(z.unknown()).default([]),
  readOk: z.boolean().default(false),
  parseError: z.string().default(""),
});

const gitHistorySchema = z.object({
  since: z.string(),
  log: z.string(),
  diffStat: z.string(),
});

const bugHuntSchema = z.looseObject({
  summary: z.string().default(""),
  bugs: z.array(z.unknown()).default([]),
  recommendations: z.array(z.string()).default([]),
  confidence: z.enum(["low", "medium", "high"]).default("medium"),
  shouldOpenIssue: z.boolean().default(false),
});

const memoryUpdateSchema = z.object({
  ok: z.boolean(),
  command: commandSchema.nullable(),
  entries: z.array(z.unknown()),
});

const outputSchema = z.object({
  ok: z.boolean(),
  mode: z.string(),
  workspaceDir: z.string(),
  summaryPath: z.string(),
  summary: z.string(),
  bugs: z.array(z.unknown()),
  commands: z.array(commandSchema),
  memoryEntries: z.number(),
});

const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  prepare: prepareSchema,
  canary: canarySchema,
  memory: memorySchema,
  gitHistory: gitHistorySchema,
  bugHunt: bugHuntSchema,
  memoryUpdate: memoryUpdateSchema,
  output: outputSchema,
});

const ROOT = resolve(import.meta.dir, "../..");
const MAX_OUTPUT = 18_000;
const MEMORY_NAMESPACE = "workflow:daily-canary";
const MEMORY_KEY = "test-lru";

const smartBugHunter = new CodexAgent({
  model: "gpt-5.5",
  cwd: ROOT,
  sandbox: "read-only",
  skipGitRepoCheck: true,
  extraArgs: ["-c", "tools.web_search=true"],
  timeoutMs: 35 * 60_000,
});

function truncate(text: string, max = MAX_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  timeoutMs = 12 * 60_000,
): z.infer<typeof commandSchema> {
  const started = Date.now();
  const res = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "1",
      SMITHERS_NO_UPDATE_CHECK: "1",
      SMITHERS_NO_SKILL_REFRESH: "1",
      ...env,
    },
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    command: [command, ...args].join(" "),
    cwd,
    ok: !res.error && res.status === 0,
    status: res.status ?? null,
    durationMs: Date.now() - started,
    stdout: truncate(res.stdout ?? ""),
    stderr: truncate(res.error ? res.error.message : res.stderr ?? ""),
  };
}

function parseTrailingJsonObject(text: string): unknown {
  const trimmed = text.trim();
  let end = trimmed.lastIndexOf("}");
  while (end >= 0) {
    let start = trimmed.lastIndexOf("{", end);
    while (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        if (start === 0) break;
        start = trimmed.lastIndexOf("{", start - 1);
      }
    }
    end = trimmed.lastIndexOf("}", end - 1);
  }
  return null;
}

function factEntriesFromMemoryCommand(command: z.infer<typeof commandSchema>): {
  entries: unknown[];
  parseError: string;
} {
  if (!command.ok) return { entries: [], parseError: command.stderr || command.stdout };
  const parsed = parseTrailingJsonObject(command.stdout);
  if (!parsed || typeof parsed !== "object") {
    return { entries: [], parseError: "memory get returned no JSON envelope" };
  }
  const fact = (parsed as { fact?: { valueJson?: string } | null }).fact;
  if (!fact?.valueJson) return { entries: [], parseError: "" };
  try {
    const value = JSON.parse(fact.valueJson);
    return { entries: Array.isArray(value) ? value : [], parseError: "" };
  } catch (err) {
    return { entries: [], parseError: err instanceof Error ? err.message : String(err) };
  }
}

function workspaceDir(input: z.infer<typeof inputSchema>): string {
  const requestedWorkspaceDir = input.workspaceDir ?? "";
  if (requestedWorkspaceDir.trim()) return resolve(requestedWorkspaceDir);
  return resolve(ROOT, ".smithers-canary-state", input.mode ?? "fresh");
}

function prepareWorkspace(mode: string, dir: string): void {
  if (mode === "fresh") rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) run("git", ["init"], dir);
  run("git", ["config", "user.email", "canary@smithers.sh"], dir);
  run("git", ["config", "user.name", "smithers-canary"], dir);
  if (!existsSync(join(dir, "README.md"))) {
    writeFileSync(join(dir, "README.md"), `# Smithers ${mode} canary\n`);
  }
}

function readMaybe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export default smithers((ctx) => {
  const prepare = ctx.outputMaybe(outputs.prepare, { nodeId: "prepare" });
  const canary = ctx.outputMaybe(outputs.canary, { nodeId: "run-canary" });
  const memory = ctx.outputMaybe(outputs.memory, { nodeId: "read-test-memory" });
  const history = ctx.outputMaybe(outputs.gitHistory, { nodeId: "git-history" });
  const bugHunt = ctx.outputMaybe(outputs.bugHunt, { nodeId: "smart-bug-hunt" });
  const memoryUpdate = ctx.outputMaybe(outputs.memoryUpdate, { nodeId: "write-test-memory" });

  return (
    <Workflow name="daily-canary">
      <Sequence>
        <Task id="prepare" output={outputs.prepare} retries={0}>
          {() => {
            const mode = ctx.input.mode ?? "fresh";
            const runLabel = ctx.input.runLabel ?? new Date().toISOString().slice(0, 10);
            const dir = workspaceDir(ctx.input);
            prepareWorkspace(mode, dir);
            return {
              mode,
              repoRoot: ROOT,
              workspaceDir: dir,
              cliPath: join(ROOT, "apps/cli/src/index.js"),
              runLabel,
            };
          }}
        </Task>

        {prepare ? (
          <Task id="run-canary" output={outputs.canary} retries={0}>
            {() => {
              const commands: z.infer<typeof commandSchema>[] = [];
              commands.push(run("git", ["status", "--short"], prepare.workspaceDir));
              commands.push(
                run("bun", [prepare.cliPath, "init", "--yes", "--no-skill", "--format", "json"], prepare.workspaceDir, {}, 20 * 60_000),
              );
              const initOk = commands[commands.length - 1]?.ok === true;
              if (initOk) {
                commands.push(run("bun", [prepare.cliPath, "workflow", "list", "--system", "--format", "json"], prepare.workspaceDir));
                commands.push(run("bun", [prepare.cliPath, "graph", ".smithers/workflows/hello.tsx"], prepare.workspaceDir));
                commands.push(
                  run(
                    "bun",
                    [
                      prepare.cliPath,
                      "memory",
                      "set",
                      MEMORY_NAMESPACE,
                      "canary-probe",
                      JSON.stringify({ at: new Date().toISOString(), runLabel: prepare.runLabel, mode: prepare.mode }),
                      "--format",
                      "json",
                    ],
                    prepare.workspaceDir,
                  ),
                );
                commands.push(
                  run("bun", [prepare.cliPath, "memory", "get", MEMORY_NAMESPACE, "canary-probe", "--format", "json"], prepare.workspaceDir),
                );
                if (ctx.input.runHello ?? true) {
                  commands.push(
                    run(
                      "bun",
                      [
                        prepare.cliPath,
                        "workflow",
                        "run",
                        "hello",
                        "--input",
                        JSON.stringify({ name: `${prepare.mode} canary` }),
                        "--format",
                        "json",
                        "--no-report",
                        "--max-output-bytes",
                        "20000",
                      ],
                      prepare.workspaceDir,
                      {},
                      25 * 60_000,
                    ),
                  );
                }
              }
              const failed = commands.filter((cmd) => !cmd.ok);
              return {
                ok: initOk && failed.length === 0,
                workspaceDir: prepare.workspaceDir,
                commands,
                summary:
                  failed.length === 0
                    ? `${prepare.mode} canary passed ${commands.length} command(s).`
                    : `${prepare.mode} canary has ${failed.length}/${commands.length} failed command(s).`,
              };
            }}
          </Task>
        ) : null}

        {prepare && canary ? (
          <Task id="read-test-memory" output={outputs.memory} retries={0}>
            {() => {
              const cmd = run("bun", [prepare.cliPath, "memory", "get", MEMORY_NAMESPACE, MEMORY_KEY, "--format", "json"], prepare.workspaceDir);
              const parsed = factEntriesFromMemoryCommand(cmd);
              return {
                namespace: MEMORY_NAMESPACE,
                key: MEMORY_KEY,
                entries: parsed.entries,
                readOk: cmd.ok,
                parseError: parsed.parseError,
              };
            }}
          </Task>
        ) : null}

        <Task id="git-history" output={outputs.gitHistory} retries={0}>
          {() => {
            const since = "7 days ago";
            const log = run("git", ["log", "--since", since, "--stat", "--oneline", "--decorate", "--max-count", "80"], ROOT);
            const diffStat = run("git", ["diff", "--stat", "HEAD~50..HEAD"], ROOT);
            return {
              since,
              log: log.stdout || log.stderr,
              diffStat: diffStat.stdout || diffStat.stderr,
            };
          }}
        </Task>

        {prepare && canary && memory && history ? (
          <Task id="smart-bug-hunt" output={outputs.bugHunt} agent={smartBugHunter}>
            {`You are the smart daily Smithers canary reviewer.

Inputs:
- Canary mode: ${prepare.mode}
- Canary workspace: ${prepare.workspaceDir}
- Prior test-memory LRU from Smithers memory (${MEMORY_NAMESPACE}/${MEMORY_KEY}):
${JSON.stringify(memory.entries, null, 2)}
- Current canary run:
${JSON.stringify(canary, null, 2)}
- Git history from the last week:
${history.log}

Recent diff stat:
${history.diffStat}

Task:
Look for likely Smithers bugs or regressions. Use read-only shell inspection if needed. Focus on failures in this canary, repeated/flaky failures visible in the LRU, and changes from the past week that could plausibly explain them.

Rules:
- Do not edit files. Do not run destructive commands.
- Be concrete: file paths, commands, observed failure text, and suspected owner area.
- If the canary failed because a dependency is unpublished or unavailable, call that out as a release/init canary finding.
- If there is no credible bug, say so and mention residual risks.

Return JSON:
{
  "summary": "short operator-facing result",
  "bugs": [
    {
      "severity": "blocker|major|minor",
      "area": "init|memory|workflow|benchmark|docs|unknown",
      "evidence": "what failed or what code path looks wrong",
      "recommendation": "next concrete action"
    }
  ],
  "recommendations": ["..."],
  "confidence": "low|medium|high",
  "shouldOpenIssue": true|false
}`}
          </Task>
        ) : null}

        {prepare && canary && memory && bugHunt ? (
          <Task id="write-test-memory" output={outputs.memoryUpdate} retries={0}>
            {() => {
              const entry = {
                at: new Date().toISOString(),
                runLabel: prepare.runLabel,
                mode: prepare.mode,
                ok: canary.ok,
                summary: canary.summary,
                bugs: bugHunt.bugs ?? [],
                commands: canary.commands.map((cmd) => ({
                  command: cmd.command,
                  ok: cmd.ok,
                  status: cmd.status,
                  durationMs: cmd.durationMs,
                })),
              };
              const prior = Array.isArray(memory.entries) ? memory.entries : [];
              const entries = [
                entry,
                ...prior.filter((item) => {
                  if (!item || typeof item !== "object") return true;
                  const row = item as { runLabel?: unknown; mode?: unknown };
                  return row.runLabel !== entry.runLabel || row.mode !== entry.mode;
                }),
              ].slice(0, (ctx.input.lruLimit ?? 30));
              const cmd = run(
                "bun",
                [prepare.cliPath, "memory", "set", MEMORY_NAMESPACE, MEMORY_KEY, JSON.stringify(entries), "--format", "json"],
                prepare.workspaceDir,
              );
              return { ok: cmd.ok, command: cmd, entries };
            }}
          </Task>
        ) : null}

        {prepare && canary && memory && memoryUpdate && bugHunt ? (
          <Task id="output" output={outputs.output} retries={0}>
            {() => {
              const summaryPath =
                (ctx.input.summaryPath ?? "").trim() ||
                join("/tmp", `smithers-canary-${prepare.mode}-${prepare.runLabel}.md`);
              mkdirSync(dirname(summaryPath), { recursive: true });
              const summary = [
                `# Smithers ${prepare.mode} canary: ${prepare.runLabel}`,
                "",
                `Workspace: ${prepare.workspaceDir}`,
                `Canary: ${canary.ok ? "PASS" : "ATTENTION"}`,
                `Memory entries: ${memoryUpdate.entries.length}`,
                "",
                "## Smart bug hunt",
                bugHunt.summary || "(no summary)",
                "",
                "## Commands",
                ...canary.commands.map((cmd) => `- ${cmd.ok ? "PASS" : "FAIL"} \`${cmd.command}\` (${cmd.durationMs}ms)`),
                "",
                "## Bugs",
                JSON.stringify(bugHunt.bugs ?? [], null, 2),
                "",
                "## Prior LRU parse",
                memory.parseError ? `Parse/read note: ${memory.parseError}` : "ok",
              ].join("\n");
              writeFileSync(summaryPath, `${summary.trim()}\n`);
              const ok = canary.ok && memoryUpdate.ok;
              if (!ok) {
                throw new Error(`Smithers ${prepare.mode} canary failed; see ${summaryPath}`);
              }
              return {
                ok,
                mode: prepare.mode,
                workspaceDir: prepare.workspaceDir,
                summaryPath,
                summary,
                bugs: bugHunt.bugs ?? [],
                commands: canary.commands,
                memoryEntries: memoryUpdate.entries.length,
              };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
