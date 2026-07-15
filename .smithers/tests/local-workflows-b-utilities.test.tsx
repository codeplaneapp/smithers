/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { renderPrompt, renderWorkflow, runTask, simulate } from "smithers-orchestrator/testing";

type Task = Readonly<{
  nodeId: string;
  dependsOn?: readonly string[];
  needs?: Readonly<Record<string, string>>;
  outputSchema?: { safeParse(v: unknown): { success: boolean } };
  parallelGroupId?: string;
  parallelMaxConcurrency?: number;
  retries?: number;
  timeoutMs?: number;
  heartbeatTimeoutMs?: number;
  continueOnFail?: boolean;
  needsApproval?: boolean;
  approvalOnDeny?: string;
  prompt?: unknown;
  [key: string]: unknown;
}>;
type Frame = Readonly<{ tasks: readonly Task[] }>;
const workflows = join(import.meta.dir, "..", "workflows");
const pathOf = (name: string) => join(workflows, name);
const load = async (name: string) => (await import(pathOf(name))).default;
const render = async (name: string, input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  (await renderWorkflow(await load(name), { input, outputs, workflowPath: pathOf(name) })) as Frame;
const task = (f: Frame, id: string): Task => {
  const found = f.tasks.find((x) => x.nodeId === id);
  expect(found, `mounted ${id}; got ${f.tasks.map((x) => x.nodeId).join(",")}`).toBeDefined();
  return found as Task;
};
const maybe = (f: Frame, id: string) => f.tasks.find((x) => x.nodeId === id);
const prompt = (f: Frame, id: string) => String(renderPrompt(task(f, id).prompt));
const validated = (f: Frame, id: string, value: Record<string, unknown>) => {
  const schema = task(f, id).outputSchema;
  expect(schema, `${id} has its mounted outputSchema`).toBeDefined();
  expect(schema!.safeParse(value).success, `${id} output is schema-valid`).toBe(true);
  return [{ nodeId: id, ...value }];
};
const row = (f: Frame, id: string, value: Record<string, unknown>, key: string) => ({ [key]: validated(f, id, value) });
const rows = (...parts: Record<string, unknown[]>[]) => Object.assign({}, ...parts);

async function isolated<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const cwd = process.cwd();
  const env = { ...process.env };
  try {
    process.chdir(root);
    for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) process.env[key] = root;
    return await fn(root);
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best-effort temp cleanup */ }
  }
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
function fixtureRepo(root: string) {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "workflow test");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), "export const fixture = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
}

describe("Batch B utility workflow behavior", () => {
  test("open-code-review: disabled terminal, exact fanout, validated aggregation and genuinely missing output", async () => {
    await isolated("b-review-", async (root) => {
      fixtureRepo(root);
      writeFileSync(join(root, "src/index.ts"), "export const fixture = false;\n");
      writeFileSync(join(root, "src/extra.ts"), "export const extra = true;\n");
      const input = { repo: root, runReview: false, concurrency: 3, timeout: 1 };
      const initial = await render("open-code-review.tsx", input);
      expect(maybe(initial, "review-file-1-src-index-ts")).toBeUndefined();
      expect(task(initial, "prepare-review").dependsOn).toEqual(["preview"]);
      expect(task(initial, "review").dependsOn).toEqual(["prepare-review"]);
      expect(task(initial, "review").retries ?? 0).toBe(0);
      const preview = await runTask(task(initial, "preview") as never) as Record<string, unknown>;
      const preparedFrame = await render("open-code-review.tsx", input, row(initial, "preview", preview, "preview"));
      const prepared = await runTask(task(preparedFrame, "prepare-review") as never) as Record<string, unknown>;
      expect(prepared).toEqual(expect.objectContaining({ shouldReview: false, files: [] }));
      const disabled = await render("open-code-review.tsx", input, rows(row(initial, "preview", preview, "preview"), row(preparedFrame, "prepare-review", prepared, "reviewPrompt")));
      expect(await runTask(task(disabled, "review") as never)).toEqual({
        status: "skipped", ok: true, reviewer: "smithers-native", message: "Review execution disabled by input.runReview.", summary: null, comments: [], warnings: [], error: "",
      });

      const liveInput = { repo: root, runReview: true, concurrency: 3, timeout: 1 };
      const live = await render("open-code-review.tsx", liveInput);
      const target = await runTask(task(live, "resolve-target") as never) as Record<string, unknown>;
      const livePreview = await runTask(task(live, "preview") as never) as Record<string, unknown>;
      const pf = await render("open-code-review.tsx", liveInput, row(live, "preview", livePreview, "preview"));
      const prep = await runTask(task(pf, "prepare-review") as never) as Record<string, unknown>;
      const ids = (prep.files as { id: string }[]).map((x) => x.id);
      expect(ids).toEqual(["review-file-1-src-index-ts", "review-file-2-src-extra-ts"]);
      const fan = await render("open-code-review.tsx", liveInput, rows(row(live, "resolve-target", target, "target"), row(live, "preview", livePreview, "preview"), row(pf, "prepare-review", prep, "reviewPrompt")));
      for (const id of ids) {
        expect(task(fan, id).dependsOn).toEqual(["prepare-review"]);
        expect(task(fan, id).parallelGroupId).toBe(task(fan, ids[0]).parallelGroupId);
        expect(task(fan, id).parallelMaxConcurrency).toBe(3);
        expect(task(fan, id).continueOnFail).toBe(true);
        expect(task(fan, id).retries ?? 0).toBe(0);
        expect(task(fan, id).timeoutMs).toBe(60_000);
      }
      expect(task(fan, "review").dependsOn).toEqual(["prepare-review", ...ids]);
      const good = { status: "success", ok: true, comments: [], warnings: [], message: "all clear", summary: { filesReviewed: 1, comments: 0, totalTokens: 7, inputTokens: 4, outputTokens: 3, elapsed: "1s" }, error: "" };
      const failed = { status: "failed", ok: false, comments: [], warnings: [{ file: "src/extra.ts", message: "agent failed", type: "agent" }], message: "failed", summary: null, error: "boom" };
      const one = validated(fan, ids[0], good);
      const missing = await render("open-code-review.tsx", liveInput, rows(row(live, "resolve-target", target, "target"), row(live, "preview", livePreview, "preview"), row(pf, "prepare-review", prep, "reviewPrompt"), { agentReview: one }));
      const missingReview = await runTask(task(missing, "review") as never) as Record<string, unknown>;
      expect(missingReview).toEqual(expect.objectContaining({ status: "completed_with_warnings", ok: true, comments: [], error: "" }));
      expect((missingReview.warnings as unknown[]).length).toBe(1);
      const both = await render("open-code-review.tsx", liveInput, rows(row(live, "resolve-target", target, "target"), row(live, "preview", livePreview, "preview"), row(pf, "prepare-review", prep, "reviewPrompt"), { agentReview: [...one, ...validated(fan, ids[1], failed)] }));
      const review = await runTask(task(both, "review") as never) as Record<string, unknown>;
      expect(review).toEqual(expect.objectContaining({ status: "completed_with_warnings", ok: true, comments: [], error: "" }));
      expect((review.warnings as unknown[]).length).toBe(2);
      const sf = await render("open-code-review.tsx", liveInput, rows(row(live, "resolve-target", target, "target"), row(live, "preview", livePreview, "preview"), row(pf, "prepare-review", prep, "reviewPrompt"), { agentReview: [...one, ...validated(fan, ids[1], failed)] }, row(both, "review", review, "review")));
      expect(await runTask(task(sf, "summary") as never)).toEqual(expect.objectContaining({ reviewableFiles: 2, warnings: 2, comments: 0, repoDir: root }));
    });
  }, { timeout: 15_000 });

  test("openclaw: every mounted audit is parallel, policy-bound, schema-validated, and synthesis has all terminals", async () => {
    const verify = { mode: "verify", allowEdits: false, focus: "focused" };
    const ids = ["fable-integration-audit", "codex-test-hardening-audit", "codex-openclaw-worker-audit", "fable-marketing-audit"];
    const base = await render("openclaw-integration-hardening.tsx", verify);
    const group = task(base, ids[0]).parallelGroupId;
    for (const id of ids) {
      expect(task(base, id).parallelGroupId).toBe(group); expect(task(base, id).parallelMaxConcurrency).toBe(5);
      expect(task(base, id).dependsOn ?? []).toEqual([]); expect(task(base, id).continueOnFail).toBe(true); expect(task(base, id).retries ?? 0).toBe(0); expect(task(base, id).timeoutMs).toBe(120_000);
      expect(prompt(base, id)).toContain("Verify only. Do not edit files, stage files, commit, or run destructive commands.");
    }
    const impl = await render("openclaw-integration-hardening.tsx", { mode: "implement", allowEdits: true, focus: "focused" });
    for (const id of ids) { expect(prompt(impl, id)).toContain("You may edit files if needed"); expect(prompt(impl, id)).not.toContain("Verify only"); }
    expect(task(base, "targeted-tests").parallelGroupId).toBe(group); expect(task(base, "synthesis").dependsOn).toEqual(["targeted-tests", ...ids]);
    const audit = { status: "pass", summary: "ok", findings: [], testGaps: [], filesReviewed: [], commandsRun: [] };
    const checks = { status: "pass", commands: [{ command: "bun test", exitCode: 0, tail: "" }] };
    const allRows = rows({ audit: ids.flatMap((id) => validated(base, id, audit)) }, row(base, "targeted-tests", checks, "commandCheck"));
    const all = await render("openclaw-integration-hardening.tsx", verify, allRows);
    expect(await runTask(task(all, "synthesis") as never)).toEqual({ status: "pass", summary: "OpenClaw integration hardening checks passed.", failingAreas: [], nextCommands: ["pnpm typecheck", "pnpm test", "pnpm -C e2e test"] });
    const missing = await render("openclaw-integration-hardening.tsx", verify, row(base, "targeted-tests", checks, "commandCheck"));
    expect(await runTask(task(missing, "synthesis") as never)).toEqual(expect.objectContaining({ status: "needs-work", failingAreas: ids.map((id) => `${id} did not produce audit output.`) }));
    const failure = await render("openclaw-integration-hardening.tsx", verify, rows({ audit: ids.flatMap((id) => validated(base, id, audit)) }, row(base, "targeted-tests", { status: "fail", commands: [{ command: "bun test", exitCode: 1, tail: "boom" }] }, "commandCheck")));
    expect(await runTask(task(failure, "synthesis") as never)).toEqual(expect.objectContaining({ status: "needs-work", failingAreas: ["bun test"] }));
  }, { timeout: 15_000 });

  test("plue demo: one deterministic simulation executes all three tasks and dataflows into the exact output", async () => {
    const workflow = await load("plue-demo-child.tsx");
    const sim = simulate(workflow, { mocks: { "ask-first": { answer: "4" }, "ask-second": { answer: "Paris" } }, workflowPath: pathOf("plue-demo-child.tsx") });
    await sim.run();
    expect(sim.status).toBe("finished"); expect(sim.executed).toEqual(["ask-first", "ask-second", "output"]);
    expect(sim.outputs.firstStep).toEqual([{ answer: "4" }]); expect(sim.outputs.secondStep).toEqual([{ answer: "Paris" }]); expect(sim.outputs.output).toEqual([{ firstAnswer: "4", secondAnswer: "Paris" }]);
    const f0 = await render("plue-demo-child.tsx");
    const f1 = await render("plue-demo-child.tsx", {}, { firstStep: validated(f0, "ask-first", { answer: "4" }) });
    const f2 = await render("plue-demo-child.tsx", {}, { firstStep: validated(f0, "ask-first", { answer: "4" }), secondStep: validated(f1, "ask-second", { answer: "Paris" }) });
    expect(task(f2, "output").dependsOn ?? []).toEqual([]); expect(await runTask(task(f2, "output") as never)).toEqual({ firstAnswer: "4", secondAnswer: "Paris" });
  }, { timeout: 15_000 });

  test("postgres sync: rejected feedback rerenders phases 2-6, phase 7 reaches commit, and integration/landing gates are causal", async () => {
    const input = { baseRef: "main", runE2e: false }; let f = await render("postgres-tanstack-sync.tsx", input);
    const design = { summary: "design", syncSourceSeam: "seam", collectionCatalog: [], persistenceContract: "persist", writePathContract: "write", migrationErrorContract: "error", docsTableContract: "docs", backendResolverContract: "backend", phaseNotes: [], risks: "none" };
    let out: Record<string, unknown[]> = { design: validated(f, "design", design) };
    const work = { layer: "sync", status: "done", summary: "done", filesChanged: [], commandsRun: [], typecheck: "pass", tests: "pass", notes: "" };
    const verify = (p: number) => ({ phase: `p${p}`, status: "green", summary: "green", typecheck: "pass", unitTests: "pass", e2e: "n/a", acceptanceCriteria: [], obsSpansEmitted: true, obsMetricsEmitted: true, obsNotes: "", bpBoundedBuffers: true, bpSlowConsumerTested: true, bpLargeBurstTested: true, bpNotes: "", filesChanged: [], remaining: [] });
    const commit = (p: number) => ({ branch: `pgts/p${p}`, committed: true, sha: `${p}`.repeat(40), summary: "committed" });
    for (const p of [2, 3, 4, 5, 6]) {
      f = await render("postgres-tanstack-sync.tsx", input, out); const impl = validated(f, `p${p}-impl`, work);
      expect(task(f, `p${p}-impl`).retries).toBe(2); expect(task(f, `p${p}-impl`).timeoutMs).toBe(7_200_000);
      const rejected = { approved: false, feedback: "fix the seam", issues: [{ severity: "major", title: "feedback", file: null, description: "fix the seam" }] };
      const rejectedFrame = await render("postgres-tanstack-sync.tsx", input, { ...out, [`p${p}Impl`]: impl, [`p${p}ReviewOpus`]: validated(f, `p${p}-review-opus`, rejected), [`p${p}ReviewCodex`]: validated(f, `p${p}-review-codex`, rejected) });
      expect(prompt(rejectedFrame, `p${p}-verify`)).toContain("fix the seam");
      const approved = { approved: true, feedback: "", issues: [] }; const ro = validated(f, `p${p}-review-opus`, approved); const rc = validated(f, `p${p}-review-codex`, approved);
      const vf = await render("postgres-tanstack-sync.tsx", input, { ...out, [`p${p}Impl`]: impl, [`p${p}ReviewOpus`]: ro, [`p${p}ReviewCodex`]: rc });
      const vr = validated(vf, `p${p}-verify`, verify(p)); const cf = await render("postgres-tanstack-sync.tsx", input, { ...out, [`p${p}Impl`]: impl, [`p${p}ReviewOpus`]: ro, [`p${p}ReviewCodex`]: rc, [`p${p}Verify`]: vr });
      expect(task(cf, `p${p}-review-opus`).parallelGroupId).toBe(task(cf, `p${p}-review-codex`).parallelGroupId); expect(task(cf, `p${p}-review-opus`).parallelMaxConcurrency).toBe(2); expect(task(cf, `p${p}-commit`).dependsOn ?? []).toEqual([]);
      out = { ...out, [`p${p}Impl`]: impl, [`p${p}ReviewOpus`]: ro, [`p${p}ReviewCodex`]: rc, [`p${p}Verify`]: vr, [`p${p}Commit`]: validated(cf, `p${p}-commit`, commit(p)) };
    }
    f = await render("postgres-tanstack-sync.tsx", input, out); const gate = { pgliteCanServeElectric: false, pgliteVersion: "0.2", pgliteEvidence: "single connection", cloudInfraReady: true, cloudReadinessNotes: "ready", blockers: [], recommendation: "proceed", summary: "gate" };
    const gateRow = validated(f, "phase7-gate", gate); const gateFrame = await render("postgres-tanstack-sync.tsx", input, { ...out, phase7Gate: gateRow });
    expect(task(gateFrame, "approve-phase-7").needsApproval).toBe(true); expect(task(gateFrame, "approve-phase-7").approvalOnDeny).toBe("skip"); expect(task(gateFrame, "approve-phase-7").approvalMode).toBe("decision"); expect((task(gateFrame, "approve-phase-7").meta as { requestTitle: string }).requestTitle).toBe("Proceed with Phase 7 (Electric cloud source)?");
    const denied = validated(gateFrame, "approve-phase-7", { approved: false, note: "hold" }); const deniedFrame = await render("postgres-tanstack-sync.tsx", input, { ...out, phase7Gate: gateRow, phase7Approval: denied }); expect(maybe(deniedFrame, "p7-impl")).toBeUndefined();
    const approval = validated(gateFrame, "approve-phase-7", { approved: true, note: null }); const approvedFrame = await render("postgres-tanstack-sync.tsx", input, { ...out, phase7Gate: gateRow, phase7Approval: approval });
    expect(task(approvedFrame, "p7-impl").dependsOn ?? []).toEqual([]); expect(prompt(approvedFrame, "integrate")).not.toContain("&& `pnpm -C apps/smithers exec playwright test`");
    const p7impl = validated(approvedFrame, "p7-impl", work); const p7ro = validated(approvedFrame, "p7-review-opus", { approved: true, feedback: "", issues: [] }); const p7rc = validated(approvedFrame, "p7-review-codex", { approved: true, feedback: "", issues: [] }); const p7vf = await render("postgres-tanstack-sync.tsx", input, { ...out, phase7Gate: gateRow, phase7Approval: approval, p7Impl: p7impl, p7ReviewOpus: p7ro, p7ReviewCodex: p7rc }); const p7verify = validated(p7vf, "p7-verify", verify(7)); const p7cf = await render("postgres-tanstack-sync.tsx", input, { ...out, phase7Gate: gateRow, phase7Approval: approval, p7Impl: p7impl, p7ReviewOpus: p7ro, p7ReviewCodex: p7rc, p7Verify: p7verify }); const p7commit = validated(p7cf, "p7-commit", commit(7));
    const common = { ...out, phase7Gate: gateRow, phase7Approval: approval, p7Impl: p7impl, p7ReviewOpus: p7ro, p7ReviewCodex: p7rc, p7Verify: p7verify, p7Commit: p7commit }; const audits = { obsAudit: validated(p7cf, "obs-audit", { dimension: "observability", status: "pass", summary: "ok", checks: [], testsAdded: [], notes: "" }), bpAudit: validated(p7cf, "bp-audit", { dimension: "backpressure", status: "pass", summary: "ok", checks: [], testsAdded: [], notes: "" }) }; const integ = { green: true, typecheck: "pass", unitTests: "pass", e2e: "skipped", acceptanceMet: true, summary: "green", remaining: [] };
    const ready = await render("postgres-tanstack-sync.tsx", { ...input, runE2e: true }, { ...common, ...audits }); expect(prompt(ready, "integrate")).toContain("playwright test"); expect(task(ready, "integrate").dependsOn ?? []).toEqual([]);
    const integrated = await render("postgres-tanstack-sync.tsx", input, { ...common, ...audits, integrate: validated(ready, "integrate", integ), integrateCommit: validated(ready, "integrate-commit", commit(9)) });
    expect(task(integrated, "approve-land").needsApproval).toBe(true); expect(task(integrated, "approve-land").approvalOnDeny).toBe("skip");
    const deniedLand = await render("postgres-tanstack-sync.tsx", input, { ...common, ...audits, integrate: validated(ready, "integrate", integ), integrateCommit: validated(ready, "integrate-commit", commit(9)), landingApproval: validated(integrated, "approve-land", { approved: false, note: "later" }) }); expect(maybe(deniedLand, "land")).toBeUndefined();
    const approvedLand = await render("postgres-tanstack-sync.tsx", input, { ...common, ...audits, integrate: validated(ready, "integrate", integ), integrateCommit: validated(ready, "integrate-commit", commit(9)), landingApproval: validated(integrated, "approve-land", { approved: true, note: null }) }); expect(task(approvedLand, "land").timeoutMs).toBe(600_000);
  }, { timeout: 30_000 });

  test("repo prospector: isolated ledger gates, exact no/weak terminals, strong causal draft approval and safe send", async () => {
    await isolated("b-prospect-", async (root) => {
      const cold = await render("repo-prospector.tsx", { force: false }); const opened = await runTask(task(cold, "gate") as never) as Record<string, unknown>; expect(opened).toEqual({ proceed: true, reason: "window open", seen: [], seenCount: 0 });
      const throttled = await render("repo-prospector.tsx", { force: false }); expect(await runTask(task(throttled, "gate") as never)).toEqual({ proceed: false, reason: expect.stringContaining("throttled"), seen: [], seenCount: 0 });
      const forced = await render("repo-prospector.tsx", { force: true }); const forcedGate = validated(forced, "gate", opened);
      const no = { found: false, fullName: "", owner: "", repo: "", url: "", stars: 0, defaultBranch: "main", existingAutomation: "none", smithersAngle: "", rationale: "none" }; const nof = await render("repo-prospector.tsx", { force: true }, row(forced, "gate", opened, "gate")); const noDone = await render("repo-prospector.tsx", { force: true }, { gate: forcedGate, discover: validated(nof, "discover", no) }); expect(maybe(noDone, "assess")).toBeUndefined(); expect(maybe(noDone, "record")).toBeUndefined();
      const found = { found: true, fullName: "owner/repo", owner: "owner", repo: "repo", url: "https://example.invalid/repo", stars: 100, defaultBranch: "main", existingAutomation: "manual", smithersAngle: "workflow", rationale: "fit" }; const foundFrame = await render("repo-prospector.tsx", { force: true }, { gate: forcedGate, discover: validated(nof, "discover", found) });
      const weak = { fit: "weak", defaultBranch: "main", existingWorkflowSummary: "manual", proposedChange: "small", smithersWorkflows: [], valueProps: [], maintainerHandle: "owner", maintainerContact: null }; const weakFrame = await render("repo-prospector.tsx", { force: true }, { gate: forcedGate, discover: validated(nof, "discover", found), record: validated(foundFrame, "record", { recorded: true, repo: "owner/repo", seenCount: 1 }), assess: validated(foundFrame, "assess", weak) }); expect(maybe(weakFrame, "fork")).toBeUndefined(); expect(maybe(weakFrame, "send")).toBeUndefined();
      const strong = { fit: "strong", defaultBranch: "main", existingWorkflowSummary: "manual", proposedChange: "small", smithersWorkflows: ["demo"], valueProps: ["value"], maintainerHandle: "owner", maintainerContact: null }; const strongFrame = await render("repo-prospector.tsx", { force: true }, { gate: forcedGate, discover: validated(nof, "discover", found), record: validated(foundFrame, "record", { recorded: true, repo: "owner/repo", seenCount: 1 }), assess: validated(foundFrame, "assess", strong) }); expect(task(strongFrame, "fork").dependsOn ?? []).toEqual([]); expect(task(strongFrame, "fork").retries).toBe(1);
      const fork = { forked: true, forkFullName: "roninjin10/repo", clonePath: join(root, "fork"), branch: "smithers-demo/smithers-improvement", defaultBranch: "main", note: "fixture" }; mkdirSync(fork.clonePath, { recursive: true }); const forkFrame = await render("repo-prospector.tsx", { force: true }, { gate: forcedGate, discover: validated(nof, "discover", found), record: validated(foundFrame, "record", { recorded: true, repo: "owner/repo", seenCount: 1 }), assess: validated(foundFrame, "assess", strong), fork: validated(strongFrame, "fork", fork) });
      const impl = { forked: true, pushed: false, forkFullName: fork.forkFullName, branch: fork.branch, commitSha: "abc", filesChanged: ["SMITHERS_DEMO.md"], summary: "demo" }; const implFrame = await render("repo-prospector.tsx", { force: true }, { gate: forcedGate, discover: validated(nof, "discover", found), record: validated(foundFrame, "record", { recorded: true, repo: "owner/repo", seenCount: 1 }), assess: validated(foundFrame, "assess", strong), fork: validated(strongFrame, "fork", fork), implement: validated(forkFrame, "implement", impl) });
      const pub = { pushed: true, commitSha: "abc", filesChanged: ["SMITHERS_DEMO.md"], compareUrl: "https://example.invalid/compare", forkFullName: fork.forkFullName, branch: fork.branch, note: "verified" }; const pubFrame = await render("repo-prospector.tsx", { force: true }, { gate: forcedGate, discover: validated(nof, "discover", found), record: validated(foundFrame, "record", { recorded: true, repo: "owner/repo", seenCount: 1 }), assess: validated(foundFrame, "assess", strong), fork: validated(strongFrame, "fork", fork), implement: validated(forkFrame, "implement", impl), publish: validated(implFrame, "publish", pub) });
      const draft = { channel: "dm", to: "owner", subject: "Smithers demo", body: "A concise demo" }; const draftFrame = await render("repo-prospector.tsx", { force: true }, { gate: forcedGate, discover: validated(nof, "discover", found), record: validated(foundFrame, "record", { recorded: true, repo: "owner/repo", seenCount: 1 }), assess: validated(foundFrame, "assess", strong), fork: validated(strongFrame, "fork", fork), implement: validated(forkFrame, "implement", impl), publish: validated(implFrame, "publish", pub), draft: validated(pubFrame, "draft", draft) }); expect(task(draftFrame, "approval").needsApproval).toBe(true); expect(task(draftFrame, "approval").approvalOnDeny).toBe("continue");
      const denial = await render("repo-prospector.tsx", { force: true }, { gate: forcedGate, discover: validated(nof, "discover", found), record: validated(foundFrame, "record", { recorded: true, repo: "owner/repo", seenCount: 1 }), assess: validated(foundFrame, "assess", strong), fork: validated(strongFrame, "fork", fork), implement: validated(forkFrame, "implement", impl), publish: validated(implFrame, "publish", pub), draft: validated(pubFrame, "draft", draft), approval: validated(draftFrame, "approval", { approved: false, note: "not now", decidedBy: "test", decidedAt: "2026-01-01T00:00:00Z" }) }); expect(maybe(denial, "send")).toBeUndefined();
      const approved = await render("repo-prospector.tsx", { force: true }, { gate: forcedGate, discover: validated(nof, "discover", found), record: validated(foundFrame, "record", { recorded: true, repo: "owner/repo", seenCount: 1 }), assess: validated(foundFrame, "assess", strong), fork: validated(strongFrame, "fork", fork), implement: validated(forkFrame, "implement", impl), publish: validated(implFrame, "publish", pub), draft: validated(pubFrame, "draft", draft), approval: validated(draftFrame, "approval", { approved: true, note: null, decidedBy: "test", decidedAt: "2026-01-01T00:00:00Z" }) }); expect(await runTask(task(approved, "send") as never)).toEqual({ action: "draft-only", sent: false, issueUrl: null, note: "Approved dm. Send this yourself to owner. Subject: Smithers demo" }); expect(readFileSync(join(root, ".smithers/state/repo-prospector.json"), "utf8")).toContain("lastRunAt");
    });
  }, { timeout: 30_000 });

  test("restore Claude implement: isolated existing and missing targets return schema-valid exact three-field results without mutation", async () => {
    await isolated("b-restore-", async (root) => {
      mkdirSync(join(root, ".smithers/workflows"), { recursive: true }); const source = resolve(import.meta.dir, "../workflows/restore-claude-implement.tsx"); const before = readFileSync(source, "utf8"); const missingFrame = await render("restore-claude-implement.tsx"); const target = resolve(process.cwd(), ".smithers/workflows/implement-codex-antigravity.tsx");
      const missing = await runTask(task(missingFrame, "restore") as never) as Record<string, unknown>; expect(missingFrame.tasks[0].outputSchema!.safeParse(missing).success).toBe(true); expect(missing).toEqual({ filePath: resolve(target), restored: false, message: "No change needed: the implementation workflow is Codex-first and already retains Claude/Gemini as automatic fallback providers." });
      writeFileSync(target, "fixture\n"); const existingFrame = await render("restore-claude-implement.tsx"); const existing = await runTask(task(existingFrame, "restore") as never) as Record<string, unknown>; expect(existingFrame.tasks[0].outputSchema!.safeParse(existing).success).toBe(true); expect(existing).toEqual({ filePath: resolve(target), restored: false, message: "No change needed: the implementation workflow is Codex-first and already retains Claude/Gemini as automatic fallback providers." }); expect(readFileSync(target, "utf8")).toBe("fixture\n"); expect(readFileSync(source, "utf8")).toBe(before);
    });
  }, { timeout: 15_000 });
});
