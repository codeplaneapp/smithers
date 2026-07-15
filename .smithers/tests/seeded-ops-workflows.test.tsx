/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { renderPrompt, renderWorkflow, runTask, simulate } from "smithers-orchestrator/testing";
import type { RenderedWorkflow } from "smithers-orchestrator/testing";
import type { TaskDescriptor } from "smithers-orchestrator/graph";
import { parseFirstJsonObject } from "../lib/parse-first-json-value";

// Bun resolves child-process commands against the process-start PATH. Keep
// release's string-command subprocesses hermetic by routing both child APIs
// through the per-test bin directory, whose executables are still real files.
mock.module("node:child_process", () => {
  const run = (argv: string[], options: { cwd?: string; encoding?: string; stdio?: unknown } = {}) => {
    const result = Bun.spawnSync(argv, {
      cwd: options.cwd,
      env: { ...process.env, PATH: process.env.OPS_PATH ?? process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    if (result.exitCode !== 0) throw Object.assign(new Error(stderr), { status: result.exitCode, stdout, stderr });
    return options.encoding === "utf8" ? stdout : Buffer.from(stdout);
  };
  return {
    execSync: (command: string, options?: { cwd?: string; encoding?: string; stdio?: unknown }) => run(
      process.platform === "win32"
        ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
        : ["/bin/sh", "-c", command],
      options,
    ),
    execFileSync: (file: string, args: string[], options?: { cwd?: string; encoding?: string; stdio?: unknown }) => run([file, ...args], options),
  };
});

setDefaultTimeout(30_000);
let importNonce = 0;
type Frame = RenderedWorkflow;
const workflowDir = join(import.meta.dir, "..", "workflows");
const load = async (file: string) => (await import(`${pathToFileURL(join(workflowDir, file)).href}?ops-test=${++importNonce}`)).default;
const render = async (file: string, input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  await renderWorkflow(await load(file), { input, outputs, workflowPath: join(workflowDir, file) }) as Frame;
const task = (frame: Frame, id: string): TaskDescriptor => {
  const found = frame.tasks.find((item) => item.nodeId === id);
  expect(found, `missing ${id}; got ${frame.tasks.map((item) => item.nodeId).join(",")}`).toBeDefined();
  return found!;
};
const staged = (frame: Frame, id: string, value: Record<string, unknown>) => {
  const t = task(frame, id);
  expect(t.outputSchema?.safeParse(value).success, `invalid ${id} fixture`).toBe(true);
  return { [t.outputTableName ?? id]: [{ nodeId: id, ...value }] };
};
const merge = (...parts: Record<string, unknown[]>[]) => Object.assign({}, ...parts);
const combine = (...parts: Record<string, unknown[]>[]) => {
  const out: Record<string, unknown[]> = {};
  for (const part of parts) for (const [key, rows] of Object.entries(part)) out[key] = [...(out[key] ?? []), ...rows];
  return out;
};

async function isolated<T>(prefix: string, body: (root: string, bin: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const cwd = process.cwd();
  const env = { ...process.env };
  try {
    process.chdir(root);
    // Keep ambient npm/pnpm/git completely unreachable. The workflow uses
    // string commands for release, so an empty fallback PATH is intentional.
    process.env.PATH = bin;
    process.env.OPS_PATH = bin;
    return await body(root, bin);
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(root, { recursive: true, force: true });
  }
}
function executable(path: string, source: string): string {
  if (process.platform === "win32") {
    const js = `${path}.js`;
    const cmd = `${path}.cmd`;
    writeFileSync(js, `${source}\n`);
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
    return cmd;
  }
  writeFileSync(path, `#!${process.execPath}\n${source}\n`);
  chmodSync(path, 0o755);
  return path;
}
function nodeFake(path: string, source: string): string {
  return executable(path, `const fs = require("node:fs");\n${source}`);
}
function fixtureRelease(root: string) {
  mkdirSync(join(root, "docs/changelogs"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3", scripts: { release: "echo release-script $@ >> pnpm.calls" } }, null, 2));
  writeFileSync(join(root, "docs/changelogs/1.2.4.mdx"), "# 1.2.4\n");
  writeFileSync(join(root, "docs/docs.json"), JSON.stringify({ navigation: [{ group: "Changelog", pages: ["changelogs/1.2.3"] }] }));
}

describe.serial("seeded ops/filesystem workflows", () => {
  test("object parser skips an earlier valid array and honors nesting and escaped strings", () => {
    expect(parseFirstJsonObject('prefix [{"ignored":true}] CTA {"run":{"status":"failed","message":"brace } and \\\"quote\\\""}} CTA')).toEqual({ run: { status: "failed", message: 'brace } and "quote"' } });
  });

  test("release performs a safe patch against real fixture files and fake commands", async () => {
    await isolated("ops-release-", async (root, bin) => {
      fixtureRelease(root);
      nodeFake(join(bin, "npm"), 'fs.appendFileSync("commands.log", JSON.stringify({ command: "npm", args: process.argv.slice(2) }) + "\\n");');
      nodeFake(join(bin, "git"), 'fs.appendFileSync("commands.log", JSON.stringify({ command: "git", args: process.argv.slice(2) }) + "\\n"); process.exit(1);');
      nodeFake(join(bin, "pnpm"), 'const args = process.argv.slice(2); fs.appendFileSync("commands.log", JSON.stringify({ command: "pnpm", args }) + "\\n"); if (args[0] === "version") { const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); pkg.version = "1.2.4"; fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\\n"); }');
      const input = { bump: "patch", runPublish: false, skipFeatureDocSync: true };
      const first = await render("release.tsx", input);
      const probe = await runTask(task(first, "probe"));
      expect(probe).toEqual({ currentVersion: "1.2.3", nextVersion: "1.2.4", bump: "patch", changelogPath: "docs/changelogs/1.2.4.mdx", lastPublishedVersion: null, lastReleaseRef: null, commitsSinceRelease: [], commitCount: 0 });
      const withProbe = await render("release.tsx", input, staged(first, "probe", probe as Record<string, unknown>));
      const changelog = await runTask(task(withProbe, "changelog-check"));
      expect(changelog).toEqual({ changelogPath: "docs/changelogs/1.2.4.mdx", ok: true, sidebarUpdated: true, commitsSinceRelease: 0 });
      expect(JSON.parse(readFileSync(join(root, "docs/docs.json"), "utf8")).navigation[0].pages).toEqual(["changelogs/1.2.4", "changelogs/1.2.3"]);
      const withChecks = await render("release.tsx", input, merge(staged(first, "probe", probe as Record<string, unknown>), staged(withProbe, "changelog-check", changelog as Record<string, unknown>)));
      const bumped = await runTask(task(withChecks, "bump"));
      expect(bumped).toEqual({ newVersion: "1.2.4" });
      const terminal = await render("release.tsx", input, merge(staged(first, "probe", probe as Record<string, unknown>), staged(withProbe, "changelog-check", changelog as Record<string, unknown>), staged(withChecks, "bump", bumped as Record<string, unknown>)));
      expect(await runTask(task(terminal, "publish"))).toEqual({ published: false, message: "Bumped to v1.2.4. Skipped publish (runPublish=false). Run `pnpm release` manually when ready." });
      expect(task(terminal, "feature-doc-sync").skipIf).toBe(true);
      expect(readFileSync(join(root, "commands.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        { command: "npm", args: ["view", "smithers-orchestrator", "version"] },
        { command: "pnpm", args: ["version", "patch"] },
      ]);
    });
  });

  test("release causal gates cover missing changelog, approval, docs failure, major descriptor, and publish flags", async () => {
    await isolated("ops-release-gates-", async (root, bin) => {
      fixtureRelease(root); rmSync(join(root, "docs/changelogs/1.2.4.mdx"));
      nodeFake(join(bin, "npm"), 'fs.appendFileSync("commands.log", JSON.stringify({ command: "npm", args: process.argv.slice(2) }) + "\\n"); process.exit(1);');
      nodeFake(join(bin, "git"), 'fs.appendFileSync("commands.log", JSON.stringify({ command: "git", args: process.argv.slice(2) }) + "\\n"); process.exit(1);');
      nodeFake(join(bin, "pnpm"), 'fs.appendFileSync("commands.log", JSON.stringify({ command: "pnpm", args: process.argv.slice(2) }) + "\\n"); process.exit(0);');
      const input = { bump: "patch", skipFeatureDocSync: true };
      const frame = await render("release.tsx", input);
      const probe = await runTask(task(frame, "probe"));
      const checked = await render("release.tsx", input, staged(frame, "probe", probe as Record<string, unknown>));
      await expect(runTask(task(checked, "changelog-check"))).rejects.toThrow("Missing changelog");
      const major = await render("release.tsx", { bump: "major", skipFeatureDocSync: true });
      expect(task(major, "major-approval")).toEqual(expect.objectContaining({ needsApproval: true, label: "Approve MAJOR version bump", meta: { requestTitle: "Approve MAJOR version bump", requestSummary: "Pre-1.0 policy: major releases require explicit human approval. Approving will run `pnpm version major`." } }));
      expect(task(major, "bump").needsApproval ?? false).toBe(false);
      const deniedMajor = await render("release.tsx", { bump: "major", skipFeatureDocSync: true }, staged(major, "major-approval", { approved: false, note: "hold", decidedBy: "human", decidedAt: "now" }));
      expect(task(deniedMajor, "major-approval").approvalOnDeny).toBe("fail");
      expect(task(deniedMajor, "major-approval").needsApproval).toBe(true);
      expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"version": "1.2.3"');
      const docs = await render("release.tsx", { bump: "patch", skipFeatureDocSync: false }, staged(frame, "probe", probe as Record<string, unknown>));
      const failedAudit = { ok: false, missingFeatures: ["feature"], missingDocs: ["docs/feature.mdx"], notes: "sync it" };
      const docsGate = await render("release.tsx", { bump: "patch", skipFeatureDocSync: false }, merge(staged(frame, "probe", probe as Record<string, unknown>), staged(docs, "feature-doc-sync", failedAudit)));
      await expect(runTask(task(docsGate, "feature-doc-sync-gate"))).rejects.toThrow("Feature/doc sync audit failed");
      const marketingInput = { bump: "patch", requireMarketingContent: true, marketingArtifactDir: "release-artifacts", skipFeatureDocSync: true };
      const marketing = await render("release.tsx", marketingInput, staged(frame, "probe", probe as Record<string, unknown>));
      expect(task(marketing, "marketing-content-check").skipIf).toBe(false);
      await expect(runTask(task(marketing, "marketing-content-check"))).rejects.toThrow("Missing approved release-content marker");
      mkdirSync(join(root, "release-artifacts"), { recursive: true });
      writeFileSync(join(root, "release-artifacts", "approved-1.2.4.json"), JSON.stringify({ approved: false }));
      await expect(runTask(task(marketing, "marketing-content-check"))).rejects.toThrow("is not approved");
      writeFileSync(join(root, "release-artifacts", "approved-1.2.4.json"), JSON.stringify({ approved: true }));
      expect(await runTask(task(marketing, "marketing-content-check"))).toEqual({ ok: true, markerPath: "release-artifacts/approved-1.2.4.json", message: "Approved release-content marker found at release-artifacts/approved-1.2.4.json." });
      const publishFrame = await render("release.tsx", { bump: "patch", runPublish: true, skipChecks: true, skipFeatureDocSync: true });
      const bump = { newVersion: "1.2.4" };
      const published = await render("release.tsx", { bump: "patch", runPublish: true, skipChecks: true, skipFeatureDocSync: true }, merge(staged(publishFrame, "probe", { currentVersion: "1.2.3", nextVersion: "1.2.4", bump: "patch", changelogPath: "docs/changelogs/1.2.4.mdx", lastPublishedVersion: null, lastReleaseRef: null, commitsSinceRelease: [], commitCount: 0 }), staged(publishFrame, "bump", bump)));
      expect(await runTask(task(published, "publish"))).toEqual({ published: true, message: "Published v1.2.4 via pnpm release." });
      expect(JSON.parse(readFileSync(join(root, "commands.log"), "utf8").trim().split("\n").at(-1)!)).toEqual({ command: "pnpm", args: ["release", "--", "--skip-checks"] });
    });
  });

  test("report-slideshow reads nested inspect JSON before CTA and degrades malformed output", async () => {
    await isolated("ops-report-", async (_root, bin) => {
      process.env.SMITHERS_CLI = nodeFake(join(bin, "smithers"), 'const payload = { data: { run: { status: "completed" }, nodes: [{ id: "n1", type: "task", status: "completed", summary: "nested \\\"quote\\\"" }] } }; process.stdout.write("noise {not-json}\\nCTA: smithers report " + JSON.stringify(payload) + " CTA");');
      const frame = await render("report-slideshow.tsx", { targetRunId: "target-1", title: null });
      const gather = await runTask(task(frame, "gather"));
      expect(gather).toEqual({ ok: true, state: "completed", nodes: [{ id: "n1", type: "task", status: "completed", summary: 'nested "quote"' }], summary: 'Run target-1 is "completed" with 1 node(s).', raw: expect.stringContaining('"data"') });
      const gathered = staged(frame, "gather", gather as Record<string, unknown>);
      const renderFrame = await render("report-slideshow.tsx", { targetRunId: "target-1", title: "Daily report" }, gathered);
      expect(String(renderPrompt(task(renderFrame, "render").prompt))).toContain('"completed"');
      const rendered = { title: "Daily report", html: "<html><body>one</body></html>", slideCount: 1 };
      const outputFrame = await render("report-slideshow.tsx", { targetRunId: "target-1", title: "Daily report" }, merge(gathered, staged(renderFrame, "render", rendered)));
      expect(await runTask(task(outputFrame, "output"))).toEqual({ targetRunId: "target-1", title: "Daily report", state: "completed", nodeCount: 1, slideCount: 1, summary: 'Run target-1 is "completed" with 1 node(s).' });
      nodeFake(join(bin, "smithers"), 'process.stdout.write("{broken CTA: smithers");');
      const degraded = await runTask(task(await render("report-slideshow.tsx", { targetRunId: "bad" }), "gather"));
      expect(degraded).toMatchObject({ ok: false, state: "unknown", nodes: [], summary: expect.stringContaining("Could not inspect run bad") });
    });
  });

  test("smoketest report requires all four areas and every finding to pass", async () => {
    const smokeInput = { versions: "1.0", changelogs: "fixture" };
    const frame = await render("smoketest.tsx", smokeInput);
    const good = ["onboarding-human", "onboarding-agent", "features", "workflow-ui"].map((area) => staged(frame, area, { passed: true, summary: `${area} ok`, findings: [{ area, status: "pass", evidence: "real" }], reproSteps: [] }));
    const all = await render("smoketest.tsx", smokeInput, combine(...good));
    const expectedVersion = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")).version as string;
    const releaseList = readdirSync(join(import.meta.dir, "../../docs/changelogs")).filter((name) => /^\d+\.\d+\.\d+\.mdx$/.test(name)).map((name) => name.slice(0, -4)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 4).join(", ");
    expect(await runTask(task(all, "report"))).toEqual({ passed: true, summary: `Smoke test of smithers-orchestrator@${expectedVersion} across 4/4 areas (changelogs: ${releaseList}). All baseline, onboarding, feature, and UI checks passed. onboarding-human ok onboarding-agent ok features ok workflow-ui ok`, findings: [
      { area: "onboarding-human", status: "pass", evidence: "real" }, { area: "onboarding-agent", status: "pass", evidence: "real" }, { area: "features", status: "pass", evidence: "real" }, { area: "workflow-ui", status: "pass", evidence: "real" },
    ], reproSteps: [] });
    const fail = await render("smoketest.tsx", smokeInput, combine(...good.slice(0, 3), staged(frame, "workflow-ui", { passed: true, summary: "ui", findings: [{ area: "workflow-ui", status: "fail", evidence: "broken" }], reproSteps: ["retry"] })));
    expect(await runTask(task(fail, "report"))).toEqual({ passed: false, summary: `Smoke test of smithers-orchestrator@${expectedVersion} across 4/4 areas (changelogs: ${releaseList}). 1 failing check(s). onboarding-human ok onboarding-agent ok features ok ui`, findings: [
      { area: "onboarding-human", status: "pass", evidence: "real" }, { area: "onboarding-agent", status: "pass", evidence: "real" }, { area: "features", status: "pass", evidence: "real" }, { area: "workflow-ui", status: "fail", evidence: "broken" },
    ], reproSteps: ["retry"] });
    const missing = await render("smoketest.tsx", smokeInput, combine(...good.slice(0, 3)));
    expect(await runTask(task(missing, "report"))).toEqual({ passed: false, summary: `Smoke test of smithers-orchestrator@${expectedVersion} across 3/4 areas (changelogs: ${releaseList}). 0 failing check(s); only 3/4 areas reported. onboarding-human ok onboarding-agent ok features ok`, findings: [
      { area: "onboarding-human", status: "pass", evidence: "real" }, { area: "onboarding-agent", status: "pass", evidence: "real" }, { area: "features", status: "pass", evidence: "real" },
    ], reproSteps: [] });
  });

  test("ticket monitor parses array/object CTAs, filters both identities, and only appends with diagnosis", async () => {
    await isolated("ops-monitor-", async (root, bin) => {
      process.env.SMITHERS_CLI = nodeFake(join(bin, "smithers"), 'if (process.argv[2] === "ps") process.stdout.write(JSON.stringify([{ workflowName: "ticket-fleet-monitor", workflowKey: "ticket-fleet", runId: "excluded", status: "running" }, { workflowName: "other", workflowKey: "ticket-fleet", runId: "fleet-1", status: "completed" }, { workflowName: "ticket-fleet", workflowKey: "monitor", runId: "excluded-2", status: "running" }, { workflowName: "ticket-fleet", workflowKey: "ticket-fleet", runId: "fleet-2", status: "running" }]) + "\\nCTA: smithers ps");');
      const frame = await render("ticket-fleet-monitor.tsx");
      const scan = await runTask(task(frame, "scan"));
      const arrayPs = JSON.stringify([{ workflowName: "ticket-fleet-monitor", workflowKey: "ticket-fleet", runId: "excluded", status: "running" }, { workflowName: "other", workflowKey: "ticket-fleet", runId: "fleet-1", status: "completed" }, { workflowName: "ticket-fleet", workflowKey: "monitor", runId: "excluded-2", status: "running" }, { workflowName: "ticket-fleet", workflowKey: "ticket-fleet", runId: "fleet-2", status: "running" }]) + "\nCTA: smithers ps";
      expect(scan).toEqual({ found: true, watchedRunId: "fleet-2", watchedStatus: "running", psSnapshot: arrayPs.slice(0, 4_000), summary: "Watching ticket-fleet run fleet-2 (running)." });
      nodeFake(join(bin, "smithers"), 'if (process.argv[2] === "ps") process.stdout.write(JSON.stringify({ runs: [{ workflowName: "ticket-fleet", workflowKey: "ticket-fleet", runId: "fleet-escaped", status: "waiting", note: "nested \\\"quote\\\"" }, { workflowName: "ticket-fleet", workflowKey: "ticket-fleet", runId: "fleet-done", status: "completed" }] }) + "\\nCTA: inspect runs");');
      const objectPs = JSON.stringify({ runs: [{ workflowName: "ticket-fleet", workflowKey: "ticket-fleet", runId: "fleet-escaped", status: "waiting", note: 'nested "quote"' }, { workflowName: "ticket-fleet", workflowKey: "ticket-fleet", runId: "fleet-done", status: "completed" }] }) + "\nCTA: inspect runs";
      expect(await runTask(task(await render("ticket-fleet-monitor.tsx"), "scan"))).toEqual({ found: true, watchedRunId: "fleet-escaped", watchedStatus: "waiting", psSnapshot: objectPs, summary: "Watching ticket-fleet run fleet-escaped (waiting)." });
      nodeFake(join(bin, "smithers"), 'if (process.argv[2] === "ps") process.stdout.write(JSON.stringify({ runs: [{ workflowName: "other", workflowKey: "other", runId: "none", status: "completed" }] }) + " CTA");');
      const noRunPs = JSON.stringify({ runs: [{ workflowName: "other", workflowKey: "other", runId: "none", status: "completed" }] }) + " CTA";
      expect(await runTask(task(await render("ticket-fleet-monitor.tsx"), "scan"))).toEqual({ found: false, watchedRunId: "", watchedStatus: "", psSnapshot: noRunPs, summary: "No ticket-fleet run found; nothing to monitor." });
      nodeFake(join(bin, "smithers"), 'process.stdout.write("malformed CTA");');
      expect(await runTask(task(await render("ticket-fleet-monitor.tsx"), "scan"))).toEqual({ found: false, watchedRunId: "", watchedStatus: "", psSnapshot: "malformed CTA", summary: "Could not parse smithers ps output." });
      nodeFake(join(bin, "smithers"), 'if (process.argv[2] === "ps") process.stdout.write(' + JSON.stringify(JSON.stringify(arrayPs)) + ');');
      const found = staged(frame, "scan", scan as Record<string, unknown>);
      const diagnosed = await render("ticket-fleet-monitor.tsx", {}, found);
      expect(String(renderPrompt(task(diagnosed, "diagnose").prompt))).toContain("fleet-2");
      const health = { watchedRunId: "fleet-2", watchedStatus: "running", healthy: true, progressing: true, stuckNodes: [], pendingApprovals: 0, issuesFound: "", recommendation: "no action needed", report: "The fleet is progressing normally." };
      const recorded = await render("ticket-fleet-monitor.tsx", {}, merge(found, staged(diagnosed, "diagnose", health)));
      expect(await runTask(task(recorded, "record"))).toEqual({ logged: true, summary: "HEALTHY: no action needed" });
      const log = readFileSync(join(root, ".smithers/logs/ticket-fleet-monitor.md"), "utf8");
      expect(log).toMatch(/^## \d{4}-\d\d-\d\dT.* — run fleet-2\n- healthy: true, progressing: true, pendingApprovals: 0\n- recommendation: no action needed\nThe fleet is progressing normally\.\n$/);
      const beforeSecond = log;
      expect(await runTask(task(recorded, "record"))).toEqual({ logged: true, summary: "HEALTHY: no action needed" });
      const afterSecond = readFileSync(join(root, ".smithers/logs/ticket-fleet-monitor.md"), "utf8");
      expect(afterSecond.startsWith(beforeSecond)).toBe(true);
      expect(afterSecond.slice(beforeSecond.length)).toMatch(/^## \d{4}-\d\d-\d\dT.* — run fleet-2\n- healthy: true, progressing: true, pendingApprovals: 0\n- recommendation: no action needed\nThe fleet is progressing normally\.\n$/);
      const noDiagnosis = await render("ticket-fleet-monitor.tsx", {}, found);
      const beforeMissingDiagnosis = readFileSync(join(root, ".smithers/logs/ticket-fleet-monitor.md"), "utf8");
      await expect(runTask(task(noDiagnosis, "record"))).resolves.toEqual({ logged: false, summary: "Diagnosis did not complete." });
      expect(readFileSync(join(root, ".smithers/logs/ticket-fleet-monitor.md"), "utf8")).toBe(beforeMissingDiagnosis);
    });
  });

  test("triage gathers nested escaped inspect evidence plus CTA and degrades malformed evidence", async () => {
    await isolated("ops-triage-", async (_root, bin) => {
      process.env.SMITHERS_CLI = nodeFake(join(bin, "smithers"), 'if (process.argv[2] === "inspect") process.stdout.write(JSON.stringify({ run: { status: "failed", error: { message: "bad thing \\\"nested\\\"" } }, nodes: [{ id: "worker", state: "failed", error: "boom \\\"escaped\\\"" }], approvals: [{ nodeId: "approve", status: "pending" }] }) + "\\nCTA"); else process.stdout.write("event-one\\nevent-two");');
      const frame = await render("triage-run.tsx", { targetRunId: "failed-1" });
      const evidence = await runTask(task(frame, "gather"));
      expect(evidence).toEqual({ ok: true, state: "failed", runError: 'bad thing "nested"', failingNodes: [{ id: "worker", reason: 'boom "escaped"' }], pendingApprovals: [{ nodeId: "approve", status: "pending" }], lastEvents: ["event-one", "event-two"], summary: 'Run failed-1 is "failed" with 1 failing/stuck node(s), 1 pending approval(s), and 2 recent event line(s).' });
      const diagnosed = await render("triage-run.tsx", { targetRunId: "failed-1" }, staged(frame, "gather", evidence as Record<string, unknown>));
      expect(String(renderPrompt(task(diagnosed, "diagnose").prompt))).toContain("boom");
      const diagnosis = { rootCauseHypothesis: "worker failed on escaped input", evidence: ['worker reported boom "escaped"'], confidence: "high" as const };
      const recommended = await render("triage-run.tsx", { targetRunId: "failed-1" }, merge(staged(frame, "gather", evidence as Record<string, unknown>), staged(diagnosed, "diagnose", diagnosis)));
      expect(String(renderPrompt(task(recommended, "recommend").prompt))).toContain("worker failed on escaped input");
      const recommendation = { recommendedAction: "retry" as const, command: "smithers retry-task failed-1 --node-id worker", rationale: "The failed worker is the direct cause." };
      const terminal = await render("triage-run.tsx", { targetRunId: "failed-1" }, merge(staged(frame, "gather", evidence as Record<string, unknown>), staged(diagnosed, "diagnose", diagnosis), staged(recommended, "recommend", recommendation)));
      expect(await runTask(task(terminal, "output"))).toEqual({ targetRunId: "failed-1", state: "failed", failingNodes: 1, pendingApprovals: 1, rootCause: "worker failed on escaped input", confidence: "high", recommendedAction: "retry", command: "smithers retry-task failed-1 --node-id worker", summary: 'Run failed-1 is "failed" with 1 failing/stuck node(s), 1 pending approval(s), and 2 recent event line(s).' });
      nodeFake(join(bin, "smithers"), 'process.stdout.write("{broken");');
      expect(await runTask(task(await render("triage-run.tsx", { targetRunId: "bad" }), "gather"))).toMatchObject({ ok: false, state: "unknown", summary: expect.stringContaining("Could not read full state") });
    });
  });

  test("workflow-skill collects real source, metadata, existing content, and exact output rules", async () => {
    await isolated("ops-skill-", async (root) => {
      mkdirSync(join(root, ".smithers/workflows"), { recursive: true }); mkdirSync(join(root, ".smithers/skills/sub"), { recursive: true });
      writeFileSync(join(root, ".smithers/workflows/workflow-skill.tsx"), "self");
      writeFileSync(join(root, ".smithers/workflows/alpha.tsx"), "// smithers-source: seeded\n// smithers-display-name: Alpha\nexport default {};\n");
      writeFileSync(join(root, ".smithers/workflows/beta.tsx"), "// smithers-source: user\nexport default {};\n");
      writeFileSync(join(root, ".smithers/skills/existing.md"), "existing skill");
      writeFileSync(join(root, ".smithers/skills/sub/nested.md"), "nested skill");
      const all = await render("workflow-skill.tsx", {});
      const collected = await runTask(task(all, "collect"));
      expect(collected).toMatchObject({ workflowTarget: "all", output: null, outputRule: "Write one skill per workflow under .smithers/skills.", prompt: "", workflows: [{ id: "alpha", displayName: "Alpha", sourceType: "seeded" }, { id: "beta", displayName: "beta", sourceType: "user" }] });
      expect((collected as any).workflows[0]).toMatchObject({ entryFile: expect.stringContaining("/.smithers/workflows/alpha.tsx"), source: expect.stringContaining("smithers-source: seeded") });
      expect((collected as any).existingSkills.map((item: any) => item.content)).toEqual(["existing skill", "nested skill"]);
      const one = await render("workflow-skill.tsx", { workflow: "alpha", output: "custom.md", prompt: "be concise" });
      const oneCollected = await runTask(task(one, "collect"));
      expect(oneCollected).toMatchObject({ workflowTarget: "alpha", output: "custom.md", outputRule: "Write the skill to exactly custom.md.", prompt: "be concise", workflows: [{ id: "alpha" }] });
      const customAll = await render("workflow-skill.tsx", { workflow: "all", output: "out" });
      expect(await runTask(task(customAll, "collect"))).toMatchObject({ outputRule: "Write one skill per workflow under out." });
      await expect(runTask(task(await render("workflow-skill.tsx", { workflow: "missing" }), "collect"))).rejects.toThrow("Workflow not found: missing");
      await expect(runTask(task(await render("workflow-skill.tsx", { workflow: "all", output: "bad.md" }), "collect"))).rejects.toThrow("output must be a directory");
      expect(String(renderPrompt(task(await render("workflow-skill.tsx", { workflow: "alpha", output: "custom.md", prompt: "be concise" }, staged(one, "collect", oneCollected as Record<string, unknown>)), "write-skills").prompt))).toContain("be concise");
      const writerResult = { summary: "wrote alpha", written: [{ workflow: "alpha", path: "custom.md", skillName: "alpha", action: "created" as const }] };
      const simulation = simulate(await load("workflow-skill.tsx"), {
        input: { workflow: "alpha", output: "custom.md", prompt: "be concise" },
        rootDir: root,
        workflowPath: join(workflowDir, "workflow-skill.tsx"),
        mocks: { "write-skills": writerResult },
      });
      await expect(simulation.run()).resolves.toMatchObject({ status: "finished", unusedMocks: [], output: writerResult });
      expect(simulation.executed).toEqual(["collect", "write-skills"]);
      expect(simulation.output).toEqual(writerResult);
    });
  });
});
