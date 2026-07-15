/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPrompt, renderWorkflow, runTask, simulate, type RenderedWorkflow } from "smithers-orchestrator/testing";

setDefaultTimeout(60_000);
const workflows = join(import.meta.dir, "..", "workflows");
const pathFor = (file: string) => join(workflows, file);
const load = async (file: string) => (await import(pathFor(file))).default;
type Outputs = Record<string, unknown[]>;
const task = (frame: RenderedWorkflow, id: string) => frame.tasks.find((item) => item.nodeId === id)!;
function add(frame: RenderedWorkflow, outputs: Outputs, id: string, value: Record<string, unknown>, iteration = task(frame, id).iteration): Outputs {
  const mounted = task(frame, id);
  const parsed = mounted.outputSchema?.safeParse(value);
  expect(parsed?.success, `schema for ${id}`).toBe(true);
  return { ...outputs, [mounted.outputTableName]: [...(outputs[mounted.outputTableName] ?? []), { nodeId: id, iteration, iterationCount: iteration, ...(parsed?.data ?? value) }] };
}
const preflight = (ok: boolean) => ({ ok, dockerOk: ok, plueDirOk: ok, ffmpegOk: ok, claudeCliOk: ok, claudeAuthOk: ok, chatUpstreamOk: ok, chatProvider: ok ? "cerebras" : "", codexOk: ok, codexSkipped: false, missing: ok ? "" : "credentials", detail: ok ? "ready" : "blocked" });

describe("real stack and release workflow owner coverage", () => {
  test("real stack gates human repair, all tickets, Ralph feedback, and terminal work", async () => {
    const file = "real-stack-e2e.tsx";
    const workflow = await load(file);
    expect(workflow.inputSchema.parse({})).toEqual({});
    expect(workflow.inputSchema.safeParse({ goal: "ship the real stack" }).success).toBe(true);
    expect(workflow.inputSchema.safeParse({ goal: 42 }).success).toBe(false);

    const base = await renderWorkflow(workflow, { input: {}, workflowPath: pathFor(file) });
    let staged = add(base, {}, "preflight:probe", preflight(false));
    const blocked = await renderWorkflow(workflow, { input: {}, outputs: staged, workflowPath: pathFor(file) });
    expect(blocked.tasks.some((item) => item.nodeId === "preflight:fix")).toBe(true);
    expect(blocked.tasks.some((item) => item.nodeId === "preflight:apply")).toBe(false);
    staged = add(blocked, staged, "preflight:fix", { cerebrasApiKey: null, geminiApiKey: null, claudeOauthToken: null, anthropicApiKey: null, skipCodex: null, note: "fixed out of band" });
    const answered = await renderWorkflow(workflow, { input: {}, outputs: staged, workflowPath: pathFor(file) });
    expect(task(answered, "preflight:apply")).toMatchObject({ kind: "compute", outputTableName: "envApply", dependsOn: ["preflight:fix"] });
    staged = add(answered, staged, "preflight:apply", { wrote: true, keysWritten: "none", path: "isolated" });
    staged = add(base, staged, "preflight:probe", preflight(true), 1);
    const ready = await renderWorkflow(workflow, { input: {}, outputs: staged, workflowPath: pathFor(file) });
    expect(ready.tasks.some((item) => item.nodeId === "preflight:fix")).toBe(false);
    expect(ready.tasks.some((item) => item.nodeId === "tickets:write")).toBe(true);
    const ralphLoop = (function find(node: RenderedWorkflow["xml"]): any {
      if (!node || node.kind !== "element") return undefined;
      if (node.props.id === "ralph:loop") return node;
      return node.children.map(find).find(Boolean);
    })(ready.xml);
    expect(ralphLoop?.props.maxIterations).toBe("12");

    const readyMock = ({ nodeId }: { nodeId: string }) => {
      if (nodeId === "preflight:probe") return preflight(true);
      if (nodeId === "tickets:write") return { count: 10, dir: "tickets" };
      if (nodeId.endsWith(":implement")) return { summary: "done", filesChanged: "current.ts", commits: "commit", blocked: false, blockedReason: null };
      if (nodeId.endsWith(":verify") || nodeId === "finalize:capture") return { passed: true, exitCode: 0, command: "true", outputTail: "green", durationMs: 1 };
      if (nodeId.endsWith(":audit")) return { clean: true, violations: "none" };
      if (nodeId.endsWith(":review")) return { approved: true, feedback: "approved" };
      if (nodeId.includes(":push")) return { pushed: true, detail: "pushed" };
      if (nodeId === "ralph:plan") return { done: true, focus: "complete", items: "", rationale: "all green" };
      if (nodeId === "finalize:report") return { path: "report.md", summary: "complete" };
      throw new Error(`Unexpected task: ${nodeId}`);
    };
    const sim = simulate(workflow, { input: {}, mocks: { "**": readyMock }, workflowPath: pathFor(file) });
    await sim.run();
    const ticketVerifies = sim.executed.filter((id) => /^t\d+.*:verify$/.test(id));
    expect(sim.task("tickets:write").outputs).toEqual([{ count: 10, dir: "tickets" }]);
    expect(ticketVerifies).toHaveLength(10);
    expect(sim.executed.filter((id) => /^t\d+.*:audit$/.test(id))).toHaveLength(10);
    for (const [before, after] of [["tickets:write", ticketVerifies[0]], ["t10-slideshow:review", "base:push"], ["base:push", "ralph:plan"], ["ralph:plan", "finalize:capture"], ["finalize:capture", "finalize:push"], ["finalize:push", "finalize:report"]]) {
      expect(sim.executed.indexOf(before!)).toBeLessThan(sim.executed.indexOf(after!));
    }
    expect(sim.status).toBe("finished");

    let feedbackOutputs = add(ready, staged, "tickets:write", { count: 10, dir: "tickets" });
    feedbackOutputs = add(ready, feedbackOutputs, "ralph:plan", { done: false, focus: "coverage", items: "add tests", rationale: "gap" });
    feedbackOutputs = add(ready, feedbackOutputs, "ralph:verify", { passed: false, exitCode: 1, command: "gate", outputTail: "RALPH_VERIFY_SENTINEL", durationMs: 5 });
    feedbackOutputs = add(ready, feedbackOutputs, "ralph:audit", { clean: true, violations: "none" });
    const retry = await renderWorkflow(workflow, { input: {}, outputs: feedbackOutputs, iterations: { "ralph:loop": 1 }, workflowPath: pathFor(file) });
    expect(renderPrompt(task(retry, "ralph:plan").prompt)).toContain("RALPH_VERIFY_SENTINEL");
  });

  test("release probe and context tasks execute against an isolated real git repository", async () => {
    const file = "release-content.tsx";
    const workflow = await load(file);
    const root = mkdtempSync(join(tmpdir(), "release-workflow-"));
    const oldCwd = process.cwd();
    const oldGitConfig = process.env.GIT_CONFIG_GLOBAL;
    try {
      // devNull is "\\\\.\\nul" on Windows, which git rejects with "unable to
      // access": point at a real empty file instead so no global config leaks
      // into the fixture on any platform.
      const emptyGitConfig = join(root, "empty-gitconfig");
      writeFileSync(emptyGitConfig, "");
      process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
      mkdirSync(join(root, "packages", "demo"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "release-fixture", version: "1.0.0" }));
      writeFileSync(join(root, "packages/demo/feature.ts"), "export const feature = 1;\n");
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
      git("init", "--initial-branch=main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
      git("add", "package.json", "packages/demo/feature.ts"); git("commit", "-m", "baseline"); git("tag", "v1.0.0");
      writeFileSync(join(root, "packages/demo/feature.ts"), "export const feature = 2;\n");
      git("add", "packages/demo/feature.ts"); git("commit", "-m", "add release feature");
      process.chdir(root);
      const input = { bump: "minor", releaseDate: "2026-07-14", dryRun: true };
      const first = await renderWorkflow(workflow, { input, workflowPath: pathFor(file) });
      const probe = await runTask(task(first, "probe-release")) as Record<string, unknown>;
      expect(probe).toMatchObject({ version: "1.1.0", previousTag: "v1.0.0", range: "v1.0.0..HEAD" });
      const withProbe = add(first, {}, "probe-release", probe);
      const second = await renderWorkflow(workflow, { input, outputs: withProbe, workflowPath: pathFor(file) });
      const context = await runTask(task(second, "collect-context")) as any;
      expect(context.commits.map((row: any) => row.subject)).toContain("add release feature");
      expect(context.changedFiles).toContain("packages/demo/feature.ts");
      expect(context.fileExcerpts[0].excerpt).toContain("feature = 2");
    } finally {
      process.chdir(oldCwd);
      if (oldGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = oldGitConfig;
      try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best-effort temp cleanup */ }
    }
  });

  test("release channels flow through quality, approval, and side-effect-free dry run", async () => {
    const file = "release-content.tsx";
    const workflow = await load(file);
    const defaults = workflow.inputSchema.parse({ bump: "minor" });
    expect(defaults).toMatchObject({ dryRun: true, publish: false, tweetThread: { maxTweets: 8, maxChars: 280 }, blogPost: { targetWords: 1600 }, quality: { minScore: 0.86, maxRevisionLoops: 2 } });
    expect(workflow.inputSchema.safeParse({ quality: { maxRevisionLoops: 6 } }).success).toBe(false);
    expect(workflow.inputSchema.safeParse({ tweetThread: { maxTweets: 21 } }).success).toBe(false);
    const input = { bump: "minor", dryRun: false, publish: true, channels: { changelog: true, tweetThread: false, blogPost: true }, skip: { renderMedia: true, writePreviewArtifacts: true } };
    const probe = { currentVersion: "1.0.0", nextVersion: "1.1.0", version: "1.1.0", bump: "minor", range: "v1.0.0..HEAD", previousTag: "v1.0.0", currentSha: "abc", releaseDate: "2026-07-14", changelogPath: "change.mdx", blogPath: "blog.mdx", threadPath: "thread.md", artifactRoot: "artifacts" };
    const analysis = { version: "1.1.0", title: "Release", oneSentenceSummary: "Durable workflows", primaryAudience: "agent-builders", releaseType: "agent-workflow-primitive", claimLedger: [{ id: "claim-1", claim: "Durable workflows", sources: [{ kind: "commit", ref: "abc", quoteOrSummary: "feature", confidence: 1 }], allowedInMarketing: true, risk: "low" }] };
    let frame = await renderWorkflow(workflow, { input, workflowPath: pathFor(file) });
    let outputs = add(frame, {}, "probe-release", probe);
    frame = await renderWorkflow(workflow, { input, outputs, workflowPath: pathFor(file) });
    outputs = add(frame, outputs, "collect-context", { version: "1.1.0", range: "v1.0.0..HEAD" });
    frame = await renderWorkflow(workflow, { input, outputs, workflowPath: pathFor(file) });
    outputs = add(frame, outputs, "analyze-release", analysis);
    frame = await renderWorkflow(workflow, { input, outputs, workflowPath: pathFor(file) });
    outputs = add(frame, outputs, "select-template", await runTask(task(frame, "select-template")) as Record<string, unknown>);
    frame = await renderWorkflow(workflow, { input, outputs, workflowPath: pathFor(file) });
    outputs = add(frame, outputs, "draft-content-brief", await runTask(task(frame, "draft-content-brief")) as Record<string, unknown>);
    frame = await renderWorkflow(workflow, { input, outputs, workflowPath: pathFor(file) });
    const channelDrafts = ["draft-changelog", "draft-thread", "draft-blog-outline", "draft-blog"];
    expect(frame.tasks.filter((item) => channelDrafts.includes(item.nodeId) && !item.skipIf).map((item) => item.nodeId)).toEqual(["draft-changelog", "draft-blog-outline"]);
    for (const id of ["draft-changelog", "draft-blog-outline"]) expect(task(frame, id)).toMatchObject({ parallelGroupId: "draft-channel-content", parallelMaxConcurrency: 3 });
    outputs = add(frame, outputs, "draft-changelog", { title: "Release", markdown: "Durable workflows", claimIds: ["claim-1"] });
    outputs = add(frame, outputs, "draft-blog-outline", { title: "Release", slug: "release" });
    frame = await renderWorkflow(workflow, { input, outputs, workflowPath: pathFor(file) });
    expect(task(frame, "draft-blog")).toMatchObject({ parallelGroupId: "draft-channel-content", parallelMaxConcurrency: 3 });
    outputs = add(frame, outputs, "draft-blog", { title: "Release", slug: "release", excerpt: "Durable", markdown: "Durable workflows", wordCount: 800, claimIds: ["claim-1"] });
    frame = await renderWorkflow(workflow, { input, outputs, workflowPath: pathFor(file) });
    outputs = add(frame, outputs, "edit-content", { summary: "edited", changelog: { title: "Release", markdown: "Durable workflows", claimIds: ["claim-1"] }, blogPost: { title: "Release", slug: "release", excerpt: "Durable", markdown: "Durable workflows", wordCount: 800, claimIds: ["claim-1"] } });
    frame = await renderWorkflow(workflow, { input, outputs, workflowPath: pathFor(file) });
    outputs = add(frame, outputs, "claim-check", await runTask(task(frame, "claim-check")) as Record<string, unknown>);
    frame = await renderWorkflow(workflow, { input, outputs, workflowPath: pathFor(file) });
    outputs = add(frame, outputs, "score-content", { score: 0.95, passed: true, checks: { factuality: 1, templateFit: 1, specificity: 1, smithersPositioning: 1, channelFit: 1, publishReadiness: 1 } });
    frame = await renderWorkflow(workflow, { input, outputs, workflowPath: pathFor(file) });
    expect(await runTask(task(frame, "quality-gate"))).toMatchObject({ ok: true });
    expect(frame.tasks.some((item) => item.nodeId === "approve-content")).toBe(true);
    outputs = add(frame, outputs, "approve-content", { approved: true, note: null, decidedBy: "tester", decidedAt: "2026-07-14T12:00:00.000Z" });
    const approved = await renderWorkflow(workflow, { input, outputs, workflowPath: pathFor(file) });
    expect(task(approved, "publish-files").skipIf).toBe(false);

    const dryInput = { ...input, dryRun: true };
    const dry = await renderWorkflow(workflow, { input: dryInput, outputs: { ...outputs, approval: [] }, workflowPath: pathFor(file) });
    const notPublished = await runTask(task(dry, "record-not-published")) as Record<string, unknown>;
    expect(notPublished).toMatchObject({ published: false, dryRun: true, files: [], tweetIds: [] });
    const dryDone = await renderWorkflow(workflow, { input: dryInput, outputs: add(dry, { ...outputs, approval: [] }, "record-not-published", notPublished), workflowPath: pathFor(file) });
    const external = ["publish-files", "post-x-thread", "commit-release-content"].filter((id) => dryDone.tasks.some((item) => item.nodeId === id && !item.skipIf));
    expect(external).toEqual([]);
  });
});
