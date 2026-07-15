/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, parse, resolve } from "node:path";
import { fakeAgent, renderWorkflow, runTask, simulate } from "smithers-orchestrator/testing";

const workflows = join(import.meta.dir, "..", "workflows");
type TaskLike = {
  nodeId: string;
  computeFn?: unknown;
  agent?: unknown;
  retries?: number;
  outputSchema?: { safeParse(value: unknown): { success: boolean } };
  needsApproval?: boolean;
  approvalOnDeny?: string;
  approvalRequest?: { title?: string; summary?: string };
  meta?: { maxAttempts?: number };
  parallelMaxConcurrency?: number;
};
type Frame = { tasks: readonly TaskLike[] };
const load = async (name: string) => (await import(join(workflows, name))).default;
const render = async (name: string, input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  (await renderWorkflow(await load(name), { workflowPath: join(workflows, name), input, outputs })) as unknown as Frame;
const task = (frame: Frame, id: string) => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(found, `missing ${id}`).toBeDefined();
  return found!;
};
const row = (nodeId: string, value: Record<string, unknown>) => [{ nodeId, ...value }];
const command = (name: string, ok = true) => ({ command: name, ok, status: ok ? 0 : 1, durationMs: 0, stdout: "", stderr: ok ? "" : "failed" });

async function fakeBunPath(logPath: string, fail = false) {
  const dir = join(tmpdir(), `zz-bun-${process.pid}-${Math.random().toString(36).slice(2)}`); await mkdir(dir, { recursive: true });
  const script = `const fs=require("node:fs"); const args=process.argv.slice(2); if (process.env.LOCAL_A_BUN_LOG) fs.appendFileSync(process.env.LOCAL_A_BUN_LOG, JSON.stringify(args)+"\\n"); if (process.env.LOCAL_A_BUN_FAIL === "1") process.exit(7); if (args.includes("memory") && args.includes("get")) process.stdout.write("prefix {\\"fact\\":{\\"valueJson\\":\\"[{\\\\\\"runLabel\\\\\\":\\\\\\"old\\\\\\",\\\\\\"mode\\\\\\":\\\\\\"persistent\\\\\\"},{\\\\\\"nested\\\\\\":{\\\\\\"ok\\\\\\":true}}]\\"}} suffix\\n");`;
  await writeFile(join(dir, "fake-bun.cjs"), script);
  const name = process.platform === "win32" ? "bun.cmd" : "bun";
  const path = join(dir, name);
  if (process.platform === "win32") await writeFile(path, `@echo off\r\n"${process.execPath}" "%~dp0fake-bun.cjs" %*\r\n`);
  else { await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-bun.cjs" "$@"\n`); await chmod(path, 0o755); }
  return { dir, path, logPath, fail };
}

describe.serial("Local-A maintenance and probe workflows", () => {
  test("benchmark toggles execute to exact terminal output, cover smoke/research gates, and propagate failures", async () => {
    const inventory = row("inventory", { benchmarks: ["fleet"], benchmarkResults: "results", seededEvalSuites: [".smithers/evals/a.jsonl"], fluencyEvalSuites: ["tiny"] });
    const research = row("research-benchmark-updates", { summary: "researched", newBenchmarks: [], benchmarkUpdates: [], filesChanged: [], shouldOpenPr: false, details: "controlled" });
    const root = await mkdtemp(join(tmpdir(), "local-a-benchmark-"));
    const oldPath = process.env.PATH;
    const log = join(root, "commands.log");
    const fake = await fakeBunPath(log);
    try {
      process.env.PATH = `${fake.dir}${delimiter}${oldPath ?? ""}`;
      const defaults = (await load("daily-benchmark-maintenance.tsx")).inputSchema.safeParse({});
      if (!defaults.success) throw defaults.error;
      expect(defaults.data).toMatchObject({
        summaryPath: join(tmpdir(), "smithers-daily-research-summary.md"),
        sotaSummaryPath: join(tmpdir(), "sota-research-summary.md"),
      });
      for (const runSotaResearch of [false, true]) for (const runBenchmarkSmoke of [false, true]) for (const runEvalSmoke of [false, true]) {
        const summaryPath = join(root, `${String(runSotaResearch)}-${String(runBenchmarkSmoke)}-${String(runEvalSmoke)}.md`);
        const sotaPath = join(root, `${String(runSotaResearch)}.sota.md`);
        const input = { runLabel: "local", runSotaResearch, runBenchmarkSmoke, runEvalSmoke, summaryPath, sotaSummaryPath: sotaPath };
        const smokeCommands = [
          ...(runBenchmarkSmoke ? [command("bun test benchmarks/fleet"), command("bun benchmarks/site/make-site.ts")] : []),
          ...(runEvalSmoke ? [command("bun evals/harness/run-all.ts --only-model codex --max-cases 1 -j 2")] : []),
        ];
        const outputs = {
          inventory,
          sota: runSotaResearch ? row("sota-research", { ok: true, commands: [command("bun scripts/sota-research.ts")], summary: "SOTA registry research completed." }) : [],
          smoke: row("run-existing-benchmarks-and-evals", { ok: true, commands: smokeCommands, summary: smokeCommands.length ? `Ran ${smokeCommands.length} benchmark/eval smoke command(s).` : "Benchmark/eval smoke skipped." }),
          benchmarkResearch: research,
        };
        const frame = await render("daily-benchmark-maintenance.tsx", input, outputs);
        expect(task(frame, "inventory")).toBeDefined();
        expect(task(frame, "run-existing-benchmarks-and-evals")).toBeDefined();
        expect(task(frame, "research-benchmark-updates")).toBeDefined();
        const result = await runTask(task(frame, "output") as never);
        expect(result).toMatchObject({ ok: true, summaryPath, commands: [...(runSotaResearch ? [{ command: "bun scripts/sota-research.ts", ok: true, status: 0, durationMs: 0, stdout: "", stderr: "" }] : []), ...smokeCommands.map(({ command: name, ...rest }) => ({ command: name, ...rest }))], benchmarkResearch: { summary: "researched", details: "controlled" } });
        expect(await readFile(summaryPath, "utf8")).toBe((result as { summary: string }).summary.trimEnd() + "\n");
      }
      const smokeFrame = await render("daily-benchmark-maintenance.tsx", { runSotaResearch: false, runBenchmarkSmoke: true, runEvalSmoke: true }, { inventory });
      await expect(runTask(task(smokeFrame, "run-existing-benchmarks-and-evals") as never)).resolves.toMatchObject({ ok: true, commands: [{ command: "bun test benchmarks/fleet" }, { command: "bun benchmarks/site/make-site.ts" }, { command: "bun evals/harness/run-all.ts --only-model codex --max-cases 1 -j 2" }] });
      const failed = await render("daily-benchmark-maintenance.tsx", { runSotaResearch: false, summaryPath: join(root, "failed.md") }, { inventory, smoke: row("run-existing-benchmarks-and-evals", { ok: false, commands: [command("bun test benchmarks/fleet", false)], summary: "1/1 benchmark/eval smoke command(s) failed." }), benchmarkResearch: research });
      await expect(runTask(task(failed, "output") as never)).rejects.toThrow("Daily benchmark maintenance failed");
      expect(await readFile(join(root, "failed.md"), "utf8")).toContain("Overall: attention needed");
    } finally {
      process.env.PATH = oldPath;
      await rm(root, { recursive: true, force: true }); await rm(fake.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("fresh canary protects owned state and the persistent path executes canary, memory LRU, and terminal truth", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-a-canary-test-"));
    const oldPath = process.env.PATH; const oldCwd = process.cwd(); const oldLog = process.env.LOCAL_A_BUN_LOG; const oldFail = process.env.LOCAL_A_BUN_FAIL; const oldBun = process.env.SMITHERS_CANARY_BUN;
    const fake = await fakeBunPath(join(root, "bun.log"));
    try {
      process.env.PATH = [fake.dir, oldPath].filter(Boolean).join(delimiter); process.env.SMITHERS_CANARY_BUN = fake.path; process.env.LOCAL_A_BUN_LOG = fake.logPath; process.env.LOCAL_A_BUN_FAIL = "0";
      for (const protectedPath of [resolve("."), homedir(), parse(resolve(".")).root]) {
        const frame = await render("daily-canary.tsx", { mode: "fresh", workspaceDir: protectedPath });
        await expect(runTask(task(frame, "prepare") as never)).rejects.toThrow(/unowned|protected/i);
      }
      const unowned = join(root, "unowned"); await mkdir(unowned, { recursive: true }); await writeFile(join(unowned, "sentinel"), "keep");
      const unownedFrame = await render("daily-canary.tsx", { mode: "fresh", workspaceDir: unowned });
      await expect(runTask(task(unownedFrame, "prepare") as never)).rejects.toThrow("unowned path");
      const owned = join(root, "owned"); await mkdir(owned, { recursive: true }); await writeFile(join(owned, ".smithers-canary-owned"), `smithers-daily-canary:${resolve(owned)}\n`); await writeFile(join(owned, "old"), "remove");
      const ownedResult = await runTask(task(await render("daily-canary.tsx", { mode: "fresh", workspaceDir: owned }), "prepare") as never) as { workspaceDir: string };
      expect(ownedResult.workspaceDir).toBe(resolve(owned));
      await expect(readFile(join(owned, "old"), "utf8")).rejects.toThrow();

      const workspace = join(root, "persistent");
      const input = { mode: "persistent", workspaceDir: workspace, runLabel: "old", runHello: true, lruLimit: 2 };
      const initial = await render("daily-canary.tsx", input);
      const prepared = await runTask(task(initial, "prepare") as never) as Record<string, unknown>;
      expect(prepared).toMatchObject({ mode: "persistent", workspaceDir: resolve(workspace), runLabel: "old" });
      const prepare = row("prepare", prepared);
      const runTrueFrame = await render("daily-canary.tsx", input, { prepare });
      const cli = prepared.cliPath as string;
      const runTrue = await runTask(task(runTrueFrame, "run-canary") as never) as { ok: boolean; commands: Array<{ command: string; ok: boolean }>; summary: string };
      expect(runTrue.ok).toBe(true);
      expect(runTrue.commands.every((entry) => entry.ok)).toBe(true);
      expect(runTrue.commands).toHaveLength(6);
      expect(runTrue.commands[0]?.command).toBe(`bun ${cli} init --yes --no-skill --format json`);
      expect(runTrue.commands[1]?.command).toBe(`bun ${cli} workflow list --system --format json`);
      expect(runTrue.commands[2]?.command).toBe(`bun ${cli} graph .smithers/workflows/hello.tsx`);
      expect(runTrue.commands[3]?.command).toContain(`memory set workflow:daily-canary canary-probe`);
      expect(runTrue.commands[3]?.command).toContain(`"runLabel":"old"`);
      expect(runTrue.commands[4]?.command).toBe(`bun ${cli} memory get workflow:daily-canary canary-probe --format json`);
      expect(runTrue.commands[5]?.command).toBe(`bun ${cli} workflow run hello --input {"name":"persistent canary"} --format json --no-report --max-output-bytes 20000`);
      const calls = (await readFile(fake.logPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
      expect(calls.slice(-6).map((args) => args.slice(1, 3))).toEqual([
        ["init", "--yes"], ["workflow", "list"], ["graph", ".smithers/workflows/hello.tsx"],
        ["memory", "set"], ["memory", "get"], ["workflow", "run"],
      ]);
      expect(calls.at(-6)?.[0]).toBe(cli); expect(JSON.parse(calls.at(-3)![5]!)).toMatchObject({ runLabel: "old", mode: "persistent" });
      const memoryFrame = await render("daily-canary.tsx", input, { prepare, canary: row("run-canary", runTrue as unknown as Record<string, unknown>) });
      const memory = await runTask(task(memoryFrame, "read-test-memory") as never) as { namespace: string; key: string; entries: unknown[]; readOk: boolean; parseError: string };
      expect(memory).toEqual({ namespace: "workflow:daily-canary", key: "test-lru", entries: [{ runLabel: "old", mode: "persistent" }, { nested: { ok: true } }], readOk: true, parseError: "" });
      const bugHunt = { summary: "no credible bug", bugs: [], recommendations: [], confidence: "high", shouldOpenIssue: false };
      const writeFrame = await render("daily-canary.tsx", input, { prepare, canary: row("run-canary", runTrue as unknown as Record<string, unknown>), memory: row("read-test-memory", memory as unknown as Record<string, unknown>), bugHunt: row("smart-bug-hunt", bugHunt) });
      const memoryUpdate = await runTask(task(writeFrame, "write-test-memory") as never) as { ok: boolean; entries: Array<Record<string, unknown>>; command: { ok: boolean } };
      expect(memoryUpdate.ok).toBe(true); expect(memoryUpdate.command.ok).toBe(true); expect(memoryUpdate.entries).toHaveLength(2);
      expect(memoryUpdate.entries[0]).toMatchObject({ runLabel: "old", mode: "persistent", ok: true }); expect(memoryUpdate.entries[1]).toEqual({ nested: { ok: true } });
      const finished = await render("daily-canary.tsx", input, { prepare, canary: row("run-canary", runTrue as unknown as Record<string, unknown>), memory: row("read-test-memory", memory as unknown as Record<string, unknown>), memoryUpdate: row("write-test-memory", memoryUpdate as unknown as Record<string, unknown>), bugHunt: row("smart-bug-hunt", bugHunt), gitHistory: row("git-history", { since: "7 days ago", log: "", diffStat: "" }) });
      const output = await runTask(task(finished, "output") as never) as { summary: string; summaryPath: string; memoryEntries: number };
      expect(output.summaryPath).toBe(join(tmpdir(), "smithers-canary-persistent-old.md")); expect(await readFile(output.summaryPath, "utf8")).toBe(output.summary.trimEnd() + "\n"); expect(output.summary).toContain("Canary: PASS"); expect(output.memoryEntries).toBe(2);
      process.env.LOCAL_A_BUN_FAIL = "1";
      const failure = await runTask(task(runTrueFrame, "run-canary") as never) as { ok: boolean; commands: unknown[]; summary: string };
      expect(failure).toMatchObject({ ok: false, summary: "persistent canary has 1/1 failed command(s)." }); expect(failure.commands).toHaveLength(1);
    } finally {
      process.env.PATH = oldPath; process.env.SMITHERS_CANARY_BUN = oldBun; process.env.LOCAL_A_BUN_LOG = oldLog; process.env.LOCAL_A_BUN_FAIL = oldFail; process.chdir(oldCwd);
      await rm(join(tmpdir(), "smithers-canary-persistent-old.md"), { force: true });
      await rm(root, { recursive: true, force: true }); await rm(fake.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("demo validates all bounds and silently returns the exact final-slide result", async () => {
    const workflow = await load("demo.tsx");
    for (const input of [{ rate: 0 }, { rate: 501 }, { autoMs: -1 }, { autoMs: 600001 }, { startAt: -1 }]) expect(workflow.inputSchema.safeParse(input).success).toBe(false);
    await expect(runTask(task(await render("demo.tsx", { silent: true, startAt: 999, auto: true, autoMs: 0 }), "slideshow") as never)).resolves.toEqual({ finished: true });
  });

  test("dynamic demo preserves exact phase state, concurrency, bounds, terminal cycle, trace, and mocks", async () => {
    const workflow = await load("dynamic-demo.tsx");
    for (const input of [{ delayMs: -1 }, { delayMs: 30001 }, { maxIterations: 0 }, { maxIterations: 501 }]) expect(workflow.inputSchema.safeParse(input).success).toBe(false);
    const frame = await render("dynamic-demo.tsx", { delayMs: 0, maxIterations: 4 }); expect(task(frame, "dynamic:intake:read-context").parallelMaxConcurrency).toBe(2);
    const simulation = simulate(workflow, { input: { delayMs: 0, maxIterations: 4 }, workflowPath: join(workflows, "dynamic-demo.tsx") }); await simulation.run();
    expect(simulation.outputs.phase).toEqual([
      { cycle: 0, phase: "Intake", added: ["Read Context", "Inventory Files"], removed: [], active: ["Read Context", "Inventory Files"], summary: "Starting with Intake; adding Read Context, Inventory Files." },
      { cycle: 1, phase: "Fan Out", added: ["Docs Pass", "Tests Pass", "API Pass", "GUI Pass"], removed: ["Read Context", "Inventory Files"], active: ["Docs Pass", "Tests Pass", "API Pass", "GUI Pass"], summary: "Switching from Intake to Fan Out; adding Docs Pass, Tests Pass, API Pass, GUI Pass and removing Read Context, Inventory Files." },
      { cycle: 2, phase: "Narrow", added: ["Risk Summary"], removed: ["Docs Pass", "Tests Pass", "API Pass", "GUI Pass"], active: ["Risk Summary"], summary: "Switching from Fan Out to Narrow; adding Risk Summary and removing Docs Pass, Tests Pass, API Pass, GUI Pass." },
      { cycle: 3, phase: "Handoff", added: ["Demo Notes", "Cleanup Queue", "Next Cycle"], removed: ["Risk Summary"], active: ["Demo Notes", "Cleanup Queue", "Next Cycle"], summary: "Switching from Narrow to Handoff; adding Demo Notes, Cleanup Queue, Next Cycle and removing Risk Summary." },
    ]);
    expect(simulation.output).toEqual({ cycle: 4, phase: "Complete", step: "Demo Complete", summary: "Dynamic task tree demo finished after the requested iterations." }); expect(simulation.executed).toEqual(["dynamic:intake:announce", "dynamic:intake:read-context", "dynamic:intake:inventory-files", "dynamic:fanout:announce", "dynamic:fanout:docs-pass", "dynamic:fanout:tests-pass", "dynamic:fanout:api-pass", "dynamic:fanout:gui-pass", "dynamic:narrow:announce", "dynamic:narrow:risk-summary", "dynamic:handoff:announce", "dynamic:handoff:demo-notes", "dynamic:handoff:cleanup-queue", "dynamic:handoff:next-cycle", "dynamic:complete"]); expect(simulation.unusedMocks).toEqual([]);
  });

  test("probes preserve exact agent, approval, human, and intentional failure contracts", async () => {
    const probe = await render("e2e-probe.tsx"); const probeTask = task(probe, "probe"); const sim = simulate(await load("e2e-probe.tsx"), { mocks: { probe: fakeAgent(probeTask.outputSchema as never, { output: { answer: "deterministic answer" } }) }, workflowPath: join(workflows, "e2e-probe.tsx") }); await sim.run(); expect(sim.output).toEqual({ answer: "deterministic answer" }); expect(sim.unusedMocks).toEqual([]);
    const approval = await render("e2e-approval-probe.tsx"); expect(task(approval, "approve-probe")).toMatchObject({ needsApproval: true, approvalOnDeny: "fail", label: "Approve E2E gated task", meta: { requestTitle: "Approve E2E gated task", requestSummary: "Approving this request lets the static gated task mount and finish." } });
    expect((await render("e2e-approval-probe.tsx", {}, { approval: row("approve-probe", { approved: false, note: "no" }) })).tasks.some((item) => item.nodeId === "gated-task")).toBe(false);
    const approved = await render("e2e-approval-probe.tsx", {}, { approval: row("approve-probe", { approved: true, note: "yes" }) }); expect(await runTask(task(approved, "gated-task") as never)).toEqual({ marker: "approval-gated-task-ran" });
    const ask = await render("e2e-ask-human-probe.tsx"); expect(task(ask, "ask-probe").outputSchema!.safeParse({ answer: "  yes  " }).success).toBe(true); expect(task(ask, "ask-probe").outputSchema!.safeParse({ answer: "   " }).success).toBe(false); expect(task(ask, "ask-probe")).toMatchObject({ meta: { maxAttempts: 10 } });
    const consumed = await render("e2e-ask-human-probe.tsx", {}, { ask: row("ask-probe", { answer: "trimmed answer" }) }); expect(await runTask(task(consumed, "consume-task") as never)).toEqual({ marker: "ask-human-consume-task-ran", answer: "trimmed answer" });
    const failed = await render("fail-probe.tsx"); const boom = task(failed, "boom"); expect(boom.retries).toBe(0); expect(boom.outputSchema!.safeParse({ ok: true }).success).toBe(true); await expect(runTask(boom as never)).rejects.toThrow("fail-probe: intentional failure to exercise the post-failure auto-trigger");
  });
});
