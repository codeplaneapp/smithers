/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { delimiter, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fakeAgent, renderPrompt, renderWorkflow, runTask } from "smithers-orchestrator/testing";
import type { RenderedWorkflow } from "smithers-orchestrator/testing";
import type { TaskDescriptor } from "smithers-orchestrator/graph";
import { attempt, investigate, smithersBug } from "./curated-system-workflows.contracts";

type Row = Record<string, unknown> & { nodeId: string };
type PackResult = { written: number; skipped: number; changed: string[] };
type Frame = RenderedWorkflow;
const workflows = join(import.meta.dir, "..", "workflows");
const cliSrc = pathToFileURL(resolve(import.meta.dir, "../../apps/cli/src")).href;
const envNames = [
  "HOME",
  "PATH",
  "SMITHERS_BUNX",
  "SMITHERS_CLI_SRC_DIR",
  "SMITHERS_HOME",
  "SMITHERS_NO_SKILL_REFRESH",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
] as const;
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const savedCwd = process.cwd();
const savedBunPath = Bun.env.PATH;
const savedBunHome = Bun.env.HOME;

const load = async (name: string) => (await import(join(workflows, name))).default;
const task = (frame: Frame, nodeId: string): TaskDescriptor => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === nodeId);
  expect(found, `missing mounted task ${nodeId}`).toBeDefined();
  return found!;
};
const row = (nodeId: string, value: Record<string, unknown>): Row => ({ nodeId, ...value });

async function render(name: string, input: unknown, staged: Row[] = [], cliDir = cliSrc): Promise<Frame> {
  process.env.SMITHERS_CLI_SRC_DIR = cliDir;
  const workflow = await load(name);
  const parsed = workflow.inputSchema.parse(input);
  const outputs: Record<string, Row[]> = {};
  for (const value of staged) {
    const mounted = task(
      await renderWorkflow(workflow, { workflowPath: join(workflows, name), input: parsed, outputs }),
      value.nodeId,
    );
    expect(mounted.outputTableName, `${value.nodeId} output table`).toBeDefined();
    expect(mounted.outputSchema?.safeParse(value).success, `${value.nodeId} schema`).toBe(true);
    outputs[mounted.outputTableName!] = [...(outputs[mounted.outputTableName!] ?? []), value];
  }
  return renderWorkflow(workflow, { workflowPath: join(workflows, name), input: parsed, outputs }) as Promise<Frame>;
}

async function isolated<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), `curated-system-${prefix}-`));
  try {
    process.chdir(root);
    process.env.HOME = root;
    process.env.SMITHERS_HOME = join(root, "smithers-home");
    process.env.CODEX_HOME = join(root, "codex-home");
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude-home");
    process.env.PATH = [join(root, "bin"), join(root, "missing-bin")].join(delimiter);
    Bun.env.PATH = process.env.PATH;
    Bun.env.HOME = root;
    delete process.env.SMITHERS_BUNX;
    delete process.env.SMITHERS_NO_SKILL_REFRESH;
    return await fn(root);
  } finally {
    process.chdir(savedCwd);
    for (const name of envNames) {
      const value = savedEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (savedBunPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = savedBunPath;
    if (savedBunHome === undefined) delete Bun.env.HOME;
    else Bun.env.HOME = savedBunHome;
    const deadline = Date.now() + 2_000;
    let removed = false;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
        removed = true;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!removed) throw lastError ?? new Error(`could not remove ${root}`);
  }
}

async function fakeExecutable(bin: string, name: string, source: string): Promise<void> {
  await mkdir(bin, { recursive: true });
  const script = join(bin, `${name}.mjs`);
  await writeFile(script, source);
  const unix = join(bin, name);
  await writeFile(unix, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(script).href)};\n`);
  await chmod(unix, 0o755);
  await writeFile(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
}

describe.serial("curated system workflow causal contracts", () => {
  test(
    "init has exact defaults and runs the isolated pack, skills, and docs lifecycle",
    async () => {
      const workflow = await load("init.tsx");
      expect(workflow.inputSchema.parse({})).toEqual({ force: false, refreshSkills: true, skipInstall: false });
      expect(workflow.inputSchema.parse({ force: true, refreshSkills: false, skipInstall: true })).toEqual({
        force: true,
        refreshSkills: false,
        skipInstall: true,
      });
      expect(() => workflow.inputSchema.parse({ force: "true" })).toThrow();
      await isolated("init", async (root) => {
        await mkdir(join(root, ".claude"), { recursive: true });
        await mkdir(join(root, ".codex"), { recursive: true });
        await mkdir(join(root, ".smithers/agents"), { recursive: true });
        await writeFile(join(root, "CLAUDE.md"), "# existing\n");
        await writeFile(join(root, ".smithers/agents/claude-code.ts"), "preserve this config\n");
        const seeded = await import("../../apps/cli/src/seeded-workflow-pack.generated.js");
        const bundled = seeded.GENERATED_SEEDED_FILES.find(
          (file) => file.path === ".smithers/workflows/init.tsx",
        )!.contents;
        const first = (await runTask(
          task(await render("init.tsx", { force: false, refreshSkills: false, skipInstall: true }), "install-pack"),
        )) as PackResult;
        expect(first).toMatchObject({ skipped: 1, changed: [] });
        const seededFileCount = first.written + first.skipped;
        expect(seededFileCount).toBeGreaterThan(1);
        expect(await readFile(join(root, ".smithers/workflows/init.tsx"), "utf8")).toBe(bundled);
        expect(await readFile(join(root, ".smithers/agents/claude-code.ts"), "utf8")).toBe("preserve this config\n");
        const skipped = await runTask(
          task(await render("init.tsx", { force: false, refreshSkills: false, skipInstall: true }), "install-pack"),
        );
        expect(skipped).toEqual({ written: 0, skipped: seededFileCount, changed: [] });
        await writeFile(join(root, ".smithers/workflows/init.tsx"), "local modification\n");
        const drift = await runTask(
          task(await render("init.tsx", { force: false, refreshSkills: false, skipInstall: true }), "install-pack"),
        );
        expect(drift).toEqual({
          written: 0,
          skipped: seededFileCount,
          changed: [".smithers/workflows/init.tsx"],
        });
        const forced = await runTask(
          task(await render("init.tsx", { force: true, refreshSkills: false, skipInstall: true }), "install-pack"),
        );
        expect(forced).toEqual({ written: seededFileCount - 7, skipped: 7, changed: [] });
        expect(await readFile(join(root, ".smithers/workflows/init.tsx"), "utf8")).toBe(bundled);
        expect(await readFile(join(root, ".smithers/agents/claude-code.ts"), "utf8")).toBe("preserve this config\n");

        const noRefresh = await runTask(
          task(
            await render("init.tsx", { force: false, refreshSkills: false, skipInstall: true }, [
              row("install-pack", forced as Row),
            ]),
            "refresh-skills",
          ),
        );
        expect(noRefresh).toEqual({ refreshed: false, detail: "skipped (refreshSkills=false)" });
        const refreshed = (await runTask(
          task(
            await render("init.tsx", { force: false, refreshSkills: true, skipInstall: true }, [
              row("install-pack", forced as Row),
            ]),
            "refresh-skills",
          ),
        )) as { refreshed: boolean; detail: string };
        // The fixture guarantees Claude Code and Codex; OpenCode rides along only
        // where the host environment leaks a detection signal (never on the
        // Windows runner), so the agent list tail is platform-dependent.
        expect(refreshed.refreshed).toBe(true);
        expect(refreshed.detail).toMatch(
          /^\u21bb Smithers refreshed the `smithers` agent skill \(Claude Code, Codex(, OpenCode)?\)\.$/,
        );
        const skillMd = await readFile(resolve(import.meta.dir, "../../skills/smithers/SKILL.md"), "utf8");
        const llms = await readFile(resolve(import.meta.dir, "../../docs/llms-full.txt"), "utf8");
        for (const home of [".claude", ".codex"]) {
          expect(await readFile(join(root, home, "skills/smithers/SKILL.md"), "utf8")).toBe(skillMd);
          expect(await readFile(join(root, home, "skills/smithers/llms-full.txt"), "utf8")).toBe(llms);
        }
        process.env.SMITHERS_NO_SKILL_REFRESH = "1";
        expect(
          await runTask(
            task(
              await render("init.tsx", { force: false, refreshSkills: true, skipInstall: true }, [
                row("install-pack", forced as Row),
              ]),
              "refresh-skills",
            ),
          ),
        ).toEqual({ refreshed: false, detail: "skipped (SMITHERS_NO_SKILL_REFRESH=1)" });
        delete process.env.SMITHERS_NO_SKILL_REFRESH;
        await writeFile(
          join(root, ".smithers/pack-selections.json"),
          JSON.stringify({ deselectedAgentDocs: ["AGENTS.md"] }),
        );
        const docs = await runTask(
          task(
            await render("init.tsx", { force: false, refreshSkills: true, skipInstall: true }, [
              row("install-pack", forced as Row),
              row("refresh-skills", refreshed as unknown as Row),
            ]),
            "note-agent-docs",
          ),
        );
        expect(docs).toEqual({ noted: true, detail: "appended guidance to 1 agent doc(s)" });
        const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
        expect(claude).toContain("smithers.sh");
        expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
        expect(
          await runTask(
            task(
              await render("init.tsx", { force: false, refreshSkills: true, skipInstall: true }, [
                row("install-pack", forced as Row),
                row("refresh-skills", refreshed as unknown as Row),
              ]),
              "note-agent-docs",
            ),
          ),
        ).toEqual({ noted: false, detail: "no agent docs to update" });
        expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(claude);
        expect(relative(root, resolve(root, ".claude/skills/smithers/SKILL.md"))).toBe(
          join(".claude", "skills", "smithers", "SKILL.md"),
        );
      });
    },
    { timeout: 60_000 },
  );

  test(
    "post-failure gathers exact bounded evidence and causally closes denial and approval",
    async () => {
      await isolated("failure", async (root) => {
        const log = join(root, "argv.jsonl");
        await fakeExecutable(
          join(root, "bin"),
          "bunx",
          `import { appendFileSync } from "node:fs"; const a=process.argv.slice(2); appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+"\\n"); if(a.includes("inspect"))process.stdout.write(JSON.stringify({run:{status:"failed",failure:{error:"nested boom"}}})); else if(a.includes("events"))process.stdout.write(Array.from({length:85},(_,i)=>"event-"+i).join("\\n")); else if(a.includes("--version"))process.stdout.write("9.8.7\\n"); else if(a.includes("bug"))process.stdout.write(JSON.stringify({id:"BUG-9",url:"https://bug.invalid/BUG-9"}));`,
        );
        process.env.PATH = [join(root, "bin"), join(root, "missing-bin")].join(delimiter);
        Bun.env.PATH = process.env.PATH;
        process.env.SMITHERS_BUNX = join(root, "bin", "bunx");
        const source = join(root, "workflow.tsx");
        await writeFile(source, "x".repeat(25_000));
        const gather = await runTask(
          task(await render("post-failure.tsx", { targetRunId: "  target-9  ", workflowPath: source }), "gather"),
        );
        const expectedEvents = Array.from({ length: 80 }, (_, i) => `event-${i + 5}`);
        expect(gather).toEqual({
          ok: true,
          state: "failed",
          runError: "nested boom",
          workflowSource: "x".repeat(20_000),
          lastEvents: expectedEvents,
          smithersVersion: "9.8.7",
          summary: 'Run target-9 is "failed" with error: nested boom; 80 event line(s) gathered.',
        });
        expect(
          (await readFile(log, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual([
          ["smithers-orchestrator", "inspect", "target-9", "--format", "json"],
          ["smithers-orchestrator", "events", "target-9"],
          ["smithers-orchestrator", "--version"],
        ]);
        const postFailureWorkflow = await load("post-failure.tsx");
        expect(() => postFailureWorkflow.inputSchema.parse({ targetRunId: "   " })).toThrow();
        const graphFrame = await renderWorkflow(postFailureWorkflow, {
          workflowPath: join(workflows, "post-failure.tsx"),
          input: {},
          outputs: {},
        });
        expect(graphFrame.tasks.map((candidate) => candidate.nodeId)).toEqual(["gather"]);
        const normal = await render("post-failure.tsx", { targetRunId: "target-9", workflowPath: source }, [
          row("gather", gather as Row),
          row("investigate", investigate),
        ]);
        expect(await runTask(task(normal, "output"))).toEqual({
          targetRunId: "target-9",
          failureClass: "workflow-bug",
          confidence: "high",
          rootCause: investigate.rootCause,
          suggestion: investigate.suggestion,
          suggestionDetail: investigate.suggestionDetail,
          commands: investigate.commands,
          bugFiled: false,
          bugUrl: "",
          summary: `workflow-bug (high): edit-workflow-and-reset — ${(gather as { summary: string }).summary}`,
        });
        const pending = await render("post-failure.tsx", { targetRunId: "target-9", workflowPath: source }, [
          row("gather", gather as Row),
          row("investigate", smithersBug),
        ]);
        expect(task(pending, "approve-bug-report").approvalOnDeny).toBe("continue");
        const denied = await render("post-failure.tsx", { targetRunId: "target-9", workflowPath: source }, [
          row("gather", gather as Row),
          row("investigate", smithersBug),
          row("approve-bug-report", { approved: false }),
        ]);
        expect(denied.tasks.some((candidate) => candidate.nodeId === "report-bug")).toBe(false);
        expect(await runTask(task(denied, "output"))).toEqual({
          targetRunId: "target-9",
          failureClass: "smithers-bug",
          confidence: "high",
          rootCause: smithersBug.rootCause,
          suggestion: "escalate",
          suggestionDetail: smithersBug.suggestionDetail,
          commands: smithersBug.commands,
          bugFiled: false,
          bugUrl: "",
          summary: `smithers-bug (high): escalate — ${(gather as { summary: string }).summary}`,
        });
        expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(3);
        const approved = await render("post-failure.tsx", { targetRunId: "target-9", workflowPath: source }, [
          row("gather", gather as Row),
          row("investigate", smithersBug),
          row("approve-bug-report", { approved: true }),
        ]);
        const report = await runTask(task(approved, "report-bug"));
        expect(report).toEqual({
          filed: true,
          bugId: "BUG-9",
          bugUrl: "https://bug.invalid/BUG-9",
          detail: '{"id":"BUG-9","url":"https://bug.invalid/BUG-9"}',
        });
        const argv = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(argv[3]).toEqual([
          "smithers-orchestrator",
          "bug",
          "--run",
          "target-9",
          "--title",
          "deterministic engine failure",
          "--body",
          "minimal reproduction and evidence",
          "--json",
        ]);
        const final = await render("post-failure.tsx", { targetRunId: "target-9", workflowPath: source }, [
          row("gather", gather as Row),
          row("investigate", smithersBug),
          row("approve-bug-report", { approved: true }),
          row("report-bug", report as Row),
        ]);
        expect(await runTask(task(final, "output"))).toEqual({
          targetRunId: "target-9",
          failureClass: "smithers-bug",
          confidence: "high",
          rootCause: smithersBug.rootCause,
          suggestion: "escalate",
          suggestionDetail: smithersBug.suggestionDetail,
          commands: smithersBug.commands,
          bugFiled: true,
          bugUrl: "https://bug.invalid/BUG-9",
          summary: `smithers-bug (high): escalate — ${(gather as { summary: string }).summary}`,
        });
      });
    },
    { timeout: 30_000 },
  );

  test(
    "upgrade verifies update-check arguments and executes cheap/smart boundaries with exact policies",
    async () => {
      await isolated("upgrade", async (root) => {
        const state = join(root, "update-state.json");
        const calls = join(root, "update-calls.jsonl");
        await writeFile(state, JSON.stringify({ latest: "1.0.0", runnable: true }));
        const moduleDir = join(root, "update");
        await mkdir(moduleDir, { recursive: true });
        await writeFile(
          join(moduleDir, "update-check.js"),
          `import { readFileSync, appendFileSync } from "node:fs"; const s=${JSON.stringify(state)}, c=${JSON.stringify(calls)}; const read=()=>JSON.parse(readFileSync(s,"utf8")); const log=(name,args)=>appendFileSync(c,JSON.stringify({name,args})+"\\n"); export const SMITHERS_PACKAGE="smithers-orchestrator"; export function readCurrentPackageVersion(){log("current",{});return "1.0.0"} export async function fetchLatestVersion(args){log("latest",args);return read().latest} export function detectInstallMethod(){log("detect",{});return {kind:"global",manager:"bun"}} export function buildUpdatePlan(install,pkg){log("plan",{install,pkg});return {command:"bun add -g smithers-orchestrator@latest",runnable:read().runnable,explanation:"global bun"}} export function isUpdateAvailable(latest,current){log("available",{latest,current});return latest !== current} export async function fetchChangelogsSince(args){log("changelog",args);return {versions:read().latest===currentVersion?[ ]:[read().latest],truncated:false,entries:read().latest===currentVersion?[]:[{version:read().latest,url:"file:///change",ok:true,content:"change"}]}} const currentVersion="1.0.0";`,
        );
        process.env.SMITHERS_CLI_SRC_DIR = pathToFileURL(moduleDir).href;
        const noUpdateGather = await runTask(
          task(await render("upgrade.tsx", { dryRun: "false" }, [], pathToFileURL(moduleDir).href), "gather"),
        );
        expect(noUpdateGather).toEqual({
          current: "1.0.0",
          latest: "1.0.0",
          updateAvailable: false,
          installKind: "global",
          installManager: "bun",
          command: "bun add -g smithers-orchestrator@latest",
          runnable: true,
          explanation: "global bun",
          dryRun: false,
          changelogVersions: [],
          changelogFetchTruncated: false,
          changelogs: [],
          summary: "Smithers is up to date or the latest version could not be confirmed (installed 1.0.0).",
        });
        const noUpdate = await render(
          "upgrade.tsx",
          { dryRun: false },
          [row("gather", noUpdateGather as Row)],
          pathToFileURL(moduleDir).href,
        );
        const noUpdateAgent = fakeAgent(task(noUpdate, "cheap-upgrade").outputSchema!, {
          output: { ...attempt, summary: "already current", commands: [] },
        });
        expect(task(noUpdate, "cheap-upgrade").timeoutMs).toBe(1_200_000);
        expect(task(noUpdate, "cheap-upgrade").retries).toBe(Infinity);
        expect(
          await runTask({
            ...task(noUpdate, "cheap-upgrade"),
            agent: noUpdateAgent as unknown as TaskDescriptor["agent"],
          }),
        ).toEqual({ ...attempt, summary: "already current", commands: [] });
        const noUpdateDone = await render(
          "upgrade.tsx",
          { dryRun: false },
          [
            row("gather", noUpdateGather as Row),
            row("cheap-upgrade", { ...attempt, summary: "already current", commands: [] }),
          ],
          pathToFileURL(moduleDir).href,
        );
        expect(await runTask(task(noUpdateDone, "output"))).toEqual({
          success: true,
          needsHelp: "",
          current: "1.0.0",
          latest: "1.0.0",
          updateAvailable: false,
          command: "bun add -g smithers-orchestrator@latest",
          changelogVersions: [],
          summary: "already current",
          commands: [],
          details: attempt.details,
        });
        await writeFile(state, JSON.stringify({ latest: "2.0.0", runnable: true }));
        const gather = await runTask(
          task(await render("upgrade.tsx", { dryRun: "1" }, [], pathToFileURL(moduleDir).href), "gather"),
        );
        expect(gather).toEqual({
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          installKind: "global",
          installManager: "bun",
          command: "bun add -g smithers-orchestrator@latest",
          runnable: true,
          explanation: "global bun",
          dryRun: true,
          changelogVersions: ["2.0.0"],
          changelogFetchTruncated: false,
          changelogs: [{ version: "2.0.0", url: "file:///change", ok: true, content: "change" }],
          summary: "Smithers 2.0.0 is available (installed 1.0.0); fetched 1 changelog(s).",
        });
        const base: Record<string, unknown> = { ...(gather as Record<string, unknown>), dryRun: true };
        const dry = await render(
          "upgrade.tsx",
          { dryRun: "true" },
          [row("gather", base)],
          pathToFileURL(moduleDir).href,
        );
        const dryAgent = fakeAgent(task(dry, "cheap-upgrade").outputSchema!, {
          output: { ...attempt, summary: "would upgrade", commands: ["bun add -g smithers-orchestrator@latest"] },
        });
        expect(task(dry, "cheap-upgrade").timeoutMs).toBe(1_200_000);
        expect(dry.tasks.some((candidate) => candidate.nodeId === "smart-upgrade")).toBe(false);
        expect(
          await runTask({ ...task(dry, "cheap-upgrade"), agent: dryAgent as unknown as TaskDescriptor["agent"] }),
        ).toEqual({ ...attempt, summary: "would upgrade", commands: ["bun add -g smithers-orchestrator@latest"] });
        const dryDone = await render(
          "upgrade.tsx",
          { dryRun: "true" },
          [
            row("gather", base),
            row("cheap-upgrade", {
              ...attempt,
              summary: "would upgrade",
              commands: ["bun add -g smithers-orchestrator@latest"],
            }),
          ],
          pathToFileURL(moduleDir).href,
        );
        expect(await runTask(task(dryDone, "output"))).toEqual({
          success: true,
          needsHelp: "",
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          command: "bun add -g smithers-orchestrator@latest",
          changelogVersions: ["2.0.0"],
          summary: "would upgrade",
          commands: ["bun add -g smithers-orchestrator@latest"],
          details: attempt.details,
        });
        const help = await render("upgrade.tsx", { dryRun: false }, [
          row("gather", { ...base, dryRun: false }),
          row("cheap-upgrade", { ...attempt, success: false, needsHelp: "command failed", summary: "blocked" }),
        ]);
        expect(task(help, "smart-upgrade").timeoutMs).toBe(2_700_000);
        expect(task(help, "smart-upgrade").retries).toBe(Infinity);
        const smartAgent = fakeAgent(task(help, "smart-upgrade").outputSchema!, {
          output: { ...attempt, summary: "upgraded" },
        });
        expect(
          await runTask({ ...task(help, "smart-upgrade"), agent: smartAgent as unknown as TaskDescriptor["agent"] }),
        ).toEqual({ ...attempt, summary: "upgraded" });
        expect(renderPrompt(task(help, "smart-upgrade").prompt)).toContain("command failed");
        const smartDone = await render("upgrade.tsx", { dryRun: false }, [
          row("gather", { ...base, dryRun: false }),
          row("cheap-upgrade", { ...attempt, success: false, needsHelp: "command failed", summary: "blocked" }),
          row("smart-upgrade", attempt),
        ]);
        expect(await runTask(task(smartDone, "output"))).toEqual({
          success: true,
          needsHelp: "",
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          command: "bun add -g smithers-orchestrator@latest",
          changelogVersions: ["2.0.0"],
          summary: "verified",
          commands: ["bun add -g smithers-orchestrator@latest"],
          details: "version verified",
        });
        const blocked = await render("upgrade.tsx", { dryRun: false }, [
          row("gather", { ...base, dryRun: false }),
          row("cheap-upgrade", { ...attempt, success: false, needsHelp: "command failed", summary: "blocked" }),
          row("smart-upgrade", { ...attempt, success: false, needsHelp: "still blocked", summary: "blocked" }),
        ]);
        expect(await runTask(task(blocked, "output"))).toEqual({
          success: false,
          needsHelp: "still blocked",
          current: "1.0.0",
          latest: "2.0.0",
          updateAvailable: true,
          command: "bun add -g smithers-orchestrator@latest",
          changelogVersions: ["2.0.0"],
          summary: "blocked",
          commands: ["bun add -g smithers-orchestrator@latest"],
          details: "version verified",
        });
        const options = (await readFile(calls, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(options.filter((entry) => entry.name === "latest")).toEqual([
          { name: "latest", args: { timeoutMs: 8000 } },
          { name: "latest", args: { timeoutMs: 8000 } },
        ]);
        expect(options.find((entry) => entry.name === "plan")).toEqual({
          name: "plan",
          args: { install: { kind: "global", manager: "bun" }, pkg: "smithers-orchestrator" },
        });
        expect(options.filter((entry) => entry.name === "changelog").map((entry) => entry.args)).toEqual([
          { currentVersion: "1.0.0", latestVersion: "1.0.0", timeoutMs: 8000, maxEntries: 20, maxCharsPerEntry: 12000 },
          { currentVersion: "1.0.0", latestVersion: "2.0.0", timeoutMs: 8000, maxEntries: 20, maxCharsPerEntry: 12000 },
        ]);
      });
    },
    { timeout: 30_000 },
  );
});
