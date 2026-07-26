/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { renderPrompt, renderWorkflow, runTask } from "smithers-orchestrator/testing";
import { delegationV2Schemas } from "smithers-orchestrator";
import { resolveJjBinary } from "@smithers-orchestrator/vcs/resolveJjBinary";
import { invocationOutcomeNodeId } from "../../packages/components/src/components/delegation-v2/delegationV2Ids.js";

type Task = {
  nodeId: string;
  kind?: string;
  dependsOn?: readonly string[];
  needs?: Record<string, string>;
  parallelGroupId?: string;
  parallelMaxConcurrency?: number;
  retries?: number;
  timeoutMs?: number;
  heartbeatTimeoutMs?: number;
  agent?: any;
  prompt?: unknown;
  outputSchema?: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  computeFn?: () => Promise<unknown>;
  meta?: Record<string, any>;
  staticPayload?: unknown;
  [key: string]: unknown;
};
type Frame = { tasks: readonly Task[]; toXml?: () => string };

setDefaultTimeout(45_000);
const workflowDir = join(import.meta.dir, "..", "workflows");
const pathFor = (name: string) => join(workflowDir, name);
const load = async (name: string) => (await import(pathFor(name))).default;
const render = async (
  name: string,
  input: unknown = {},
  outputs: Record<string, unknown[]> = {},
  extra: Record<string, unknown> = {},
) => (await renderWorkflow(await load(name), { workflowPath: pathFor(name), input, outputs, ...extra })) as Frame;
const task = (frame: Frame, id: string) => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
};
const row = (frame: Frame, id: string, value: Record<string, unknown>) => {
  const descriptor = task(frame, id);
  expect(descriptor.outputSchema?.safeParse(value).success, `${id} row must validate at its outputSchema`).toBe(true);
  return [{ nodeId: id, ...value }];
};
const prompt = (frame: Frame, id: string) => renderPrompt(task(frame, id).prompt);
function wait<T>(value: Promise<T>, ms = 40_000) {
  return Promise.race([
    value,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`case exceeded ${ms}ms`)), ms)),
  ]);
}

async function isolated(prefix: string, body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = process.cwd();
  const path = process.env.PATH;
  process.chdir(root);
  try {
    await body(root);
  } finally {
    process.chdir(cwd);
    process.env.PATH = path;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
  }
}

async function executable(file: string, source: string) {
  await mkdir(dirname(file), { recursive: true });
  if (process.platform === "win32" && file.endsWith(".cmd")) {
    const js = file.slice(0, -4) + ".js";
    await writeFile(js, `#!/usr/bin/env node\n${source}`);
    await writeFile(file, `@echo off\r\n"${process.execPath}" "%~dp0${js.split(/[\\/]/).pop()}" %*\r\n`);
  } else {
    await writeFile(file, `#!/usr/bin/env node\n${source}`);
    if (process.platform !== "win32") await chmod(file, 0o755);
  }
}
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("Batch C utility behavior", () => {
  test("microsandbox finish starts with its deterministic preparation gate", async () => {
    const frame = await render("microsandbox-finish.tsx");
    expect(frame.tasks.map((candidate) => candidate.nodeId)).toEqual(["prep", "summary"]);
    expect(task(frame, "prep").agent).toBeUndefined();

    const source = await readFile(pathFor("microsandbox-finish.tsx"), "utf8");
    expect(source).toContain("if (!existsSync(gate.cwd))");
    expect(source).toContain("Gate cwd does not exist:");
    expect(source).toContain('runProcess("/bin/bash", ["-lc", gate.command]');
    expect(source).not.toContain('runProcess("bash", ["-lc", gate.command]');
  });

  test("review wrappers use exact prompt, distinct configured chains, staged schema rows, and moderator terminal", async () =>
    wait(
      (async () => {
        for (const name of ["review-codex-antigravity.tsx", "review-nokimi.tsx"]) {
          const original = "C-BATCH\n<exact>&\nkeep all punctuation";
          const initial = await render(name, { prompt: original });
          const p0 = task(initial, "review-panelist-0");
          const p1 = task(initial, "review-panelist-1");
          const moderator = task(initial, "review-moderator");
          expect(p0.dependsOn).toBeUndefined();
          expect(p0.needs).toBeUndefined();
          expect(p1.dependsOn).toBeUndefined();
          expect(p1.needs).toBeUndefined();
          expect(p0.parallelGroupId).toBe("parallel:0.0");
          expect(p1.parallelGroupId).toBe("parallel:0.0");
          expect(p0.parallelMaxConcurrency).toBeUndefined();
          expect(p1.parallelMaxConcurrency).toBeUndefined();
          expect(moderator.parallelGroupId).toBeUndefined();
          expect(moderator.parallelMaxConcurrency).toBeUndefined();
          expect(moderator.dependsOn).toEqual(["review-panelist-0", "review-panelist-1"]);
          expect(moderator.needs).toEqual({
            "review-panelist-0": "review-panelist-0",
            "review-panelist-1": "review-panelist-1",
          });
          expect(p0.retries).toBe(1);
          expect(p1.retries).toBe(1);
          expect(moderator.retries).toBe(1);
          expect(prompt(initial, p0.nodeId)).toContain(original);
          expect(prompt(initial, p1.nodeId)).toContain(original);
          expect(Array.isArray(p0.agent)).toBe(true);
          expect(Array.isArray(p1.agent)).toBe(true);
          expect(p0.agent).not.toBe(p1.agent);
          expect(p0.agent[0]).not.toBe(p1.agent[0]);
          expect(p0.agent[0].constructor.name).toBe("CodexAgent");
          expect(p0.agent[0].model).toBe("gpt-5.6-sol");
          expect(moderator.agent).not.toBe(p0.agent);
          expect(moderator.agent[0]).not.toBe(p0.agent[0]);
          const panel0 = { reviewer: "panel-0", approved: true, feedback: "FIRST-UNIQUE", issues: [] };
          const panel1 = { reviewer: "panel-1", approved: false, feedback: "SECOND-UNIQUE", issues: [] };
          const staged = await render(
            name,
            { prompt: original },
            { review: [...row(initial, p0.nodeId, panel0), ...row(initial, p1.nodeId, panel1)] },
          );
          const moderatorPrompt = prompt(staged, "review-moderator");
          expect(moderatorPrompt).toContain(JSON.stringify(panel0));
          expect(moderatorPrompt).toContain(JSON.stringify(panel1));
          const generated = { approved: false, feedback: "MERGED-FIRST-AND-SECOND", issues: [] };
          let received = "";
          const runnable = {
            generate: async ({ prompt: value }: { prompt: unknown }) => {
              received = String(value);
              return generated;
            },
          };
          await expect(runTask({ ...task(staged, "review-moderator"), agent: runnable } as never)).resolves.toEqual(
            generated,
          );
          expect(received).toBe(moderatorPrompt);
          expect(task(staged, "review-moderator").outputSchema?.safeParse(generated).success).toBe(true);
        }
      })(),
    ));

  test("run-on-plue forwards Sandbox input and executes a safe terminal boundary without network", async () =>
    wait(
      isolated("smithers-plue-c-", async (root) => {
        const script = join(root, "child.tsx");
        const log = join(root, "commands.log");
        await writeFile(script, "export default {}\n");
        const plue = join(root, process.platform === "win32" ? "plue.cmd" : "plue");
        const ssh = join(root, process.platform === "win32" ? "ssh.cmd" : "ssh");
        await executable(
          plue,
          `const a=process.argv.slice(2); if(a[0]==="workspace"&&a[1]==="view") process.stdout.write(JSON.stringify({id:a[2],status:"running",ssh:{command:"ssh fake@host"}})); else if(a[0]==="workspace"&&a[1]==="exec") process.stdout.write("seeded"); else if(a[0]==="workspace"&&a[1]==="delete") process.stdout.write("deleted");`,
        );
        await executable(
          ssh,
          `const fs=require("node:fs"); const a=process.argv.slice(2); const c=a.at(-1)||""; fs.appendFileSync(${JSON.stringify(log)},c+"\\n"); if(c.includes(" up ")) process.stdout.write("runId: child-1\\nstatus: finished\\n"); else if(c.includes(" inspect ")) process.stdout.write(JSON.stringify({status:"finished",output:{answer:"through-input"}}));`,
        );
        process.env.PATH = root + (process.platform === "win32" ? ";" : ":") + (process.env.PATH ?? "");
        const input = {
          script,
          repo: "owner/repo",
          input: { answer: "through-input" },
          existingWorkspaceId: "fixture",
          plueBin: plue,
        };
        const frame = await render("run-on-plue.tsx", input, {}, { baseRootDir: root });
        const sandbox = task(frame, "plue-run");
        expect(sandbox.meta?.__sandboxReviewDiffs).toBe(false);
        expect(sandbox.prompt).toBeUndefined();
        expect(sandbox.meta?.__sandboxInput).toEqual({
          scriptSource: "export default {}\n",
          scriptName: "child.tsx",
          childInput: { answer: "through-input" },
        });
        expect(sandbox.dependsOn).toBeUndefined();
        expect(sandbox.needs).toBeUndefined();
        expect(sandbox.retries).toBe(Infinity);
        const provider = (await import("../lib/plue-provider.ts")).createPlueSandboxProvider({
          repo: "owner/repo",
          plueBin: plue,
          existingWorkspaceId: "fixture",
          pollIntervalMs: 1,
        });
        const request = {
          runId: "test-run",
          sandboxId: "plue-run",
          input: sandbox.meta?.__sandboxInput,
          toolTimeoutMs: 2_000,
          heartbeat: () => {},
        };
        const providerResult = await provider.run(request as never);
        if (!("outputs" in providerResult)) throw new Error("expected inline provider output");
        const providerOutputs = providerResult.outputs;
        expect(providerOutputs).toEqual({
          status: "finished",
          output: { status: "finished", output: { answer: "through-input" } },
          remoteRunId: "child-1",
          workspaceId: "fixture",
        });
        await expect(
          runTask({ ...sandbox, kind: "static", staticPayload: providerOutputs, computeFn: undefined } as never),
        ).resolves.toEqual(providerOutputs);
        await expect(
          runTask({
            ...sandbox,
            kind: "static",
            staticPayload: { status: "not-terminal" },
            computeFn: undefined,
          } as never),
        ).rejects.toThrow("output failed validation");
        const commands = await readFile(log, "utf8");
        expect(commands).toContain("bun install");
        expect(commands).toContain("child.tsx");
        expect(commands).toContain("input.json");
      }),
    ));

  test("Fortress uses only an isolated real CLI tree and exact escaped health output", async () =>
    wait(
      isolated("smithers-monitor-c-", async (root) => {
        const cli = join(root, "apps/cli/src/index.js");
        const calls = join(root, "calls.log");
        await executable(
          cli,
          `const fs=require("node:fs"); const a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+"\\n"); if(a[0]==="ps") process.stdout.write(JSON.stringify({runs:[{id:"other",workflowId:"other",status:"running"},{id:"old",workflowId:"target<id>",status:"finished"},{id:"live",workflowId:"target<id>",status:"running"}]})); else if(a[0]==="tree") process.stdout.write(JSON.stringify({runState:{state:"running"},root:{type:"sequence",children:[{type:"task",task:{nodeId:"done<&",kind:"task"}},{type:"task",task:{nodeId:"active",kind:"task"}},{type:"task",task:{nodeId:"waiting",kind:"task"}}]}})); else if(a[0]==="inspect") process.stdout.write(JSON.stringify({run:{status:"running"},steps:[{id:"done<&",state:"finished"},{id:"active",state:"running"},{id:"waiting",state:"waiting"}]}));`,
        );
        const frame = await render("test-fortress-monitor.tsx", {
          workflowId: "target<id>",
          outPath: ".smithers/status.html",
        });
        expect(task(frame, "health").dependsOn).toBeUndefined();
        expect(task(frame, "health").retries).toBe(Infinity);
        await expect(runTask(task(frame, "health") as never)).resolves.toEqual({
          watchedRunId: "live",
          status: "running",
          done: 1,
          inFlight: 1,
          scheduled: 1,
          outPath: resolve(process.cwd(), ".smithers/status.html"),
          wroteHtml: true,
        });
        expect(await readFile(calls, "utf8")).toBe(
          '["ps","--json","--limit","500"]\n["tree","live","--json"]\n["inspect","live","--json"]\n',
        );
        const html = await readFile(join(root, ".smithers/status.html"), "utf8");
        expect(html).toContain("workflow <b>target&lt;id&gt;</b>");
        expect(html).toContain("done&lt;&amp;");
        expect(html).toContain("1/3 nodes complete — 33%");
      }),
    ));

  test("Trellis stages exact policy-bound author outcome and executes the real final terminal", async () =>
    wait(
      (async () => {
        const workflow = await load("trellis.tsx");
        expect(workflow.inputSchema.safeParse({}).data).toEqual({
          prompt: "Build the requested result and prove it works.",
          role: "sol",
          work: "synthesize",
          maxConcurrency: 4,
          maxAuthorGenerations: 4,
          maxAuthorDepth: 4,
          maxTotalAuthorTurns: 32,
        });
        for (const [field, value] of [
          ["prompt", ""],
          ["maxConcurrency", 0],
          ["maxConcurrency", 17],
          ["maxAuthorGenerations", 0],
          ["maxAuthorDepth", 9],
          ["maxTotalAuthorTurns", 257],
        ] as const)
          expect(workflow.inputSchema.safeParse({ [field]: value }).success).toBe(false);
        const policy = { allowedCategories: ["protocol_core"], allowedPathPrefixes: ["packages"], maxChangedLines: 20 };
        const input = {
          prompt: "trellis exact",
          role: "fable",
          work: "research",
          maxConcurrency: 3,
          maxAuthorGenerations: 2,
          maxAuthorDepth: 5,
          maxTotalAuthorTurns: 7,
          criticalExecutionPolicy: policy,
        };
        const opts = {
          runtimeConfig: { requireRerenderOnOutputChange: true, maxConcurrencyPinned: true, maxConcurrency: 3 },
        };
        const initial = await render("trellis.tsx", input, {}, opts);
        const author = initial.tasks[0];
        const truth = author.meta?.trellis;
        expect({
          role: truth.role,
          work: truth.work,
          rootMaxConcurrency: truth.rootMaxConcurrency,
          rootAuthorTurnsTotal: truth.rootAuthorTurnsTotal,
          rootMaxAuthorGenerations: truth.rootMaxAuthorGenerations,
          rootMaxAuthorDepth: truth.rootMaxAuthorDepth,
          invocationAuthorTurnsAllocated: truth.invocationAuthorTurnsAllocated,
        }).toEqual({
          role: "fable",
          work: "research",
          rootMaxConcurrency: 3,
          rootAuthorTurnsTotal: 7,
          rootMaxAuthorGenerations: 2,
          rootMaxAuthorDepth: 5,
          invocationAuthorTurnsAllocated: 7,
        });
        expect(truth.criticalExecutionPolicyHash).toMatch(/^[0-9a-f]{64}$/);
        expect(prompt(initial, author.nodeId)).toContain("trellis exact");
        expect(prompt(initial, author.nodeId)).toContain('"workKind": "research"');
        expect(prompt(initial, author.nodeId)).toContain(truth.criticalExecutionPolicyHash);
        const outcome = {
          invocationKey: truth.invocationKey,
          logicalId: "root",
          generation: 0,
          role: "fable",
          work: "research",
          outputContract: "evidence_collection",
          assignmentDigest: "0".repeat(64),
          acceptanceCriterionIds: ["root-goal"],
          status: "complete",
          sourceNodeId: author.nodeId,
          product: {
            work: "research",
            summary: "terminal",
            evidence: [{ id: "e1", kind: "source", summary: "direct" }],
            artifacts: [],
            assumptions: [],
            openRisks: [],
            acceptance: [{ criterionId: "root-goal", status: "passed", evidenceIds: ["e1"], explanation: "terminal" }],
            details: { conclusion: "terminal", findings: [] },
          },
        };
        expect(delegationV2Schemas.dv2Outcome.safeParse(outcome).success).toBe(true);
        const outcomeId = invocationOutcomeNodeId({ prefix: "trellis", invocationKey: truth.invocationKey });
        const finalFrame = await render(
          "trellis.tsx",
          input,
          { dv2Outcome: [{ nodeId: outcomeId, ...outcome }] },
          opts,
        );
        const final = finalFrame.tasks.find((candidate) => candidate.meta?.trellis?.phase === "final");
        expect(final).toBeDefined();
        expect(final!.dependsOn).toEqual([outcomeId]);
        expect(final!.meta?.trellis?.criticalExecutionPolicyHash).toBe(truth.criticalExecutionPolicyHash);
        await expect(runTask(final as never)).resolves.toEqual({ status: "complete", summary: "terminal", outcome });
      })(),
    ));

  test("VCS independently executes every action/default on real isolated git and jj trees", async () =>
    wait(
      isolated("smithers-vcs-c-", async (root) => {
        git(root, "init", "-b", "main");
        git(root, "config", "user.email", "test@example.com");
        git(root, "config", "user.name", "Test");
        await writeFile(join(root, "tracked.txt"), "one\n");
        git(root, "add", "tracked.txt");
        git(root, "commit", "-m", "initial");
        await writeFile(join(root, "tracked.txt"), "one\ntwo\n");
        git(root, "checkout", "-b", "feature/c");
        const before = git(root, "rev-parse", "HEAD");
        for (const vcs of ["git"] as const) {
          const status = await render("vcs.tsx", { action: "status", vcs });
          await expect(runTask(task(status, "vcs:status") as never)).resolves.toEqual(
            expect.objectContaining({ tool: "git", branch: "feature/c", clean: false }),
          );
          const log = await render("vcs.tsx", { action: "log", vcs });
          const logValue = await runTask(task(log, "vcs:log") as never);
          expect(logValue).toEqual(
            expect.objectContaining({ tool: "git", commits: [expect.objectContaining({ subject: "initial" })] }),
          );
          const commit = await render("vcs.tsx", { action: "commit", vcs });
          const diff = await runTask(task(commit, "vcs:diff") as never);
          const withDiff = await render(
            "vcs.tsx",
            { action: "commit", vcs },
            { diff: row(commit, "vcs:diff", diff as any) },
          );
          expect(task(withDiff, "vcs:message").dependsOn).toBeUndefined();
          expect(task(withDiff, "vcs:message").needs).toBeUndefined();
          expect(prompt(withDiff, "vcs:message")).toContain((diff as any).patch);
          await expect(
            runTask({
              ...task(withDiff, "vcs:message"),
              agent: { generate: async () => ({ message: "✨ feat(vcs): staged", command: "git commit -m staged" }) },
            } as never),
          ).resolves.toEqual({ message: "✨ feat(vcs): staged", command: "git commit -m staged" });
          const rebase = await render(
            "vcs.tsx",
            { action: "rebase-plan", vcs },
            { log: row(log, "vcs:log", logValue as any) },
          );
          expect(task(rebase, "vcs:rebasePlan").dependsOn).toBeUndefined();
          expect(task(rebase, "vcs:rebasePlan").needs).toBeUndefined();
          expect(prompt(rebase, "vcs:rebasePlan")).toContain("initial");
          await expect(
            runTask({
              ...task(rebase, "vcs:rebasePlan"),
              agent: { generate: async () => ({ summary: "plan", steps: ["git rebase main"] }) },
            } as never),
          ).resolves.toEqual({ summary: "plan", steps: ["git rebase main"] });
          const defaults = await render("vcs.tsx", {});
          await expect(runTask(task(defaults, "vcs:status") as never)).resolves.toEqual(
            expect.objectContaining({ tool: "git", branch: "feature/c" }),
          );
        }
        expect(git(root, "rev-parse", "HEAD")).toBe(before);
        expect(git(root, "branch", "--show-current")).toBe("feature/c");
        await isolated("smithers-vcs-jj-c-", async (jjRoot) => {
          const oldPath = process.env.PATH;
          const oldOverride = process.env.SMITHERS_JJ_PATH;
          try {
            delete process.env.SMITHERS_JJ_PATH;
            const jj = resolveJjBinary();
            // The vendored jj binaries are fetched at release time (pnpm fetch:jj)
            // and never committed, so a clean workspace checkout may not carry one
            // for this platform; fall back to a PATH-resolved jj before skipping.
            const jjPath = jj.source === "path" ? Bun.which(jj.path) : jj.path;
            if (!jjPath) {
              console.warn(
                `skipping jj coverage: no bundled or PATH jj for ${process.platform}-${process.arch} (resolved source=${jj.source})`,
              );
              return;
            }
            expect(resolve(jjPath)).toBe(jjPath);
            process.env.SMITHERS_JJ_PATH = jjPath;
            process.env.PATH = "";
            execFileSync(jjPath!, ["git", "init", "--colocate"], { cwd: jjRoot });
            await writeFile(join(jjRoot, "j.txt"), "jj\n");
            const status = await render("vcs.tsx", { action: "status", vcs: "jj" });
            await expect(runTask(task(status, "vcs:status") as never)).resolves.toEqual(
              expect.objectContaining({
                tool: "jj",
                isRepo: true,
                clean: false,
                changes: expect.arrayContaining([expect.objectContaining({ path: "j.txt" })]),
              }),
            );
            const log = await render("vcs.tsx", { action: "log", vcs: "jj" });
            await expect(runTask(task(log, "vcs:log") as never)).resolves.toEqual(
              expect.objectContaining({ tool: "jj", isRepo: true }),
            );
          } finally {
            process.env.PATH = oldPath;
            if (oldOverride === undefined) delete process.env.SMITHERS_JJ_PATH;
            else process.env.SMITHERS_JJ_PATH = oldOverride;
          }
        });
      }),
    ));

  test("verify-push-safety validates gate/review rows and exact verdict truth table", async () =>
    wait(
      (async () => {
        const base = await render("verify-push-safety.tsx");
        const approved = { reviewer: "smart", approved: true, feedback: "approved", issues: [] };
        const gate = {
          originHasBurndownBranches: false,
          rogueBranches: "",
          localMainSha: "a",
          originMainSha: "a",
          mainInSync: true,
          typecheckGreen: true,
          lintGreen: true,
          cleanWorkingTree: true,
          summary: "S",
          output: "O",
        };
        const expected = (clean: boolean, review: boolean) => ({
          pushStateClean: clean,
          hardeningApproved: review,
          overallPass: clean && review,
          summary: `push-state ${clean ? "CLEAN" : "NOT-CLEAN"} (S); hardening ${review ? "APPROVED" : "not-yet-approved"} by review.`,
        });
        const cases: Array<[string, any, any, any]> = [
          ["clean", gate, approved, expected(true, true)],
          ["dirty", { ...gate, cleanWorkingTree: false }, approved, expected(false, true)],
          ["review rejected", gate, { ...approved, approved: false }, expected(true, false)],
          [
            "rogue",
            { ...gate, originHasBurndownBranches: true, rogueBranches: "refs/heads/burndown/x" },
            approved,
            expected(false, true),
          ],
          [
            "divergence",
            { ...gate, localMainSha: "a", originMainSha: "b", mainInSync: false },
            approved,
            expected(false, true),
          ],
          ["typecheck", { ...gate, typecheckGreen: false }, approved, expected(false, true)],
          ["lint", { ...gate, lintGreen: false }, approved, expected(false, true)],
        ];
        for (const [name, gateValue, reviewValue, verdict] of cases) {
          const frame = await render(
            "verify-push-safety.tsx",
            {},
            { gate: row(base, "gate", gateValue), review: row(base, "hardening:review:0", reviewValue) },
          );
          expect(task(frame, "gate").dependsOn).toBeUndefined();
          expect(task(frame, "hardening:review:0").parallelGroupId).toBe("parallel:0.1");
          expect(task(frame, "hardening:review:0").parallelMaxConcurrency).toBeUndefined();
          expect(task(frame, "verdict").dependsOn).toBeUndefined();
          expect(task(frame, "verdict").needs).toBeUndefined();
          expect(task(frame, "verdict").retries).toBe(Infinity);
          await expect(runTask(task(frame, "verdict") as never), name).resolves.toEqual(verdict);
        }
      })(),
    ));
});
