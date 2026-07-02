import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const realDddLib = resolve(here, "../lib/ddd");
const realNodeModules = resolve(repoRoot, "node_modules");
const tempDirs: string[] = [];

const generateWorkflowPath = resolve(here, "../workflows/ddd-generate-docs.tsx");
const bugScanWorkflowPath = resolve(here, "../workflows/ddd-bug-scan.tsx");

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "ddd-generate-bug-unit-"));
  tempDirs.push(root);
  mkdirSync(join(root, ".smithers/spec/content"), { recursive: true });
  cpSync(realDddLib, join(root, ".smithers/lib/ddd"), { recursive: true });
  symlinkSync(realNodeModules, join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ddd-unit-fixture", type: "module" }) + "\n");
  writeFileSync(join(root, ".smithers/spec/content/overview.md"), "# Overview\n");
  writeFeatures(root, [
    {
      id: "known-feature",
      title: "Known Feature",
      summary: "Known feature summary.",
      status: "partial",
      priority: "p0",
      owner: "product",
      missing: [],
    },
  ]);
  return root;
}

function writeFeatures(root: string, value: unknown) {
  mkdirSync(join(root, ".smithers/spec"), { recursive: true });
  writeFileSync(join(root, ".smithers/spec/features.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function writeExecutable(path: string, source: string) {
  writeFileSync(path, `#!${process.execPath}\n${source}\n`);
  chmodSync(path, 0o755);
}

function writeShellExecutable(path: string, source: string) {
  writeFileSync(path, `#!/bin/sh\n${source}\n`);
  chmodSync(path, 0o755);
}

async function generateModule() {
  return await import(`${generateWorkflowPath}?unit=${Date.now()}-${Math.random()}`) as Record<string, any>;
}

async function bugScanModule() {
  return await import(`${bugScanWorkflowPath}?unit=${Date.now()}-${Math.random()}`) as Record<string, any>;
}

describe("ddd-generate-docs and ddd-bug-scan helpers", () => {
  test("surveyRepo discovers root, packages, and apps manifests, skips invalid package.json, truncates README, and lists docs/tests", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "packages/alpha"), { recursive: true });
    mkdirSync(join(root, "packages/bad"), { recursive: true });
    mkdirSync(join(root, "apps/web"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "e2e"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "README.md"), `${"r".repeat(5000)}tail`);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root-package", type: "module" }) + "\n");
    writeFileSync(join(root, "packages/alpha/package.json"), JSON.stringify({ name: "@fixture/alpha" }) + "\n");
    writeFileSync(join(root, "packages/bad/package.json"), "{");
    writeFileSync(join(root, "apps/web/package.json"), JSON.stringify({ name: "@fixture/web" }) + "\n");
    writeFileSync(join(root, "docs/a.md"), "# A\n");

    const { surveyRepo } = await generateModule();
    const survey = surveyRepo(root);

    expect(survey.hasSpec).toBe(true);
    expect(survey.readmeExcerpt).toHaveLength(4000);
    expect(survey.readmeExcerpt).not.toContain("tail");
    expect(survey.packageNames.sort()).toEqual(["@fixture/alpha", "@fixture/web", "root-package"]);
    expect(survey.docsFiles).toEqual(["a.md"]);
    expect(survey.testDirs.sort()).toEqual(["e2e", "tests"]);
    expect(survey.summary).toContain("packages");
  });

  test("runSpecBuild returns clear pass and failure summaries", async () => {
    const root = tempRoot();
    const { runSpecBuild } = await generateModule();

    const passed = runSpecBuild(root);
    expect(passed.passed).toBe(true);
    expect(passed.summary).toContain("features.json validated");
    expect(existsSync(join(root, ".smithers/ui/ddd-docsContent.generated.ts"))).toBe(true);

    writeFeatures(root, [{ id: "bad", title: "Bad", summary: "Bad", status: "not-real", priority: "p0", owner: "product" }]);
    const failed = runSpecBuild(root);
    expect(failed.passed).toBe(false);
    expect(failed.summary).toContain("Spec build failed:");
  });

  test("kickoffBugScan handles disabled, parsed run id success, launched-without-id, and failure paths", async () => {
    const root = tempRoot();
    const binDir = mkdtempSync(join(tmpdir(), "ddd-bugscan-bin-"));
    tempDirs.push(binDir);
    const previousPath = process.env.PATH;
    const smithersPath = join(binDir, "smithers");
    const { kickoffBugScan, kickoffBugScanAfterGate } = await generateModule();

    expect(kickoffBugScan(root, false)).toEqual({
      launched: false,
      bugScanRunId: "",
      summary: "Bug scan disabled by input (runBugScan=false).",
    });
    expect(kickoffBugScanAfterGate(root, true, { buildPassed: false, reviewApproved: true })).toEqual({
      launched: false,
      bugScanRunId: "",
      summary: "Bug scan blocked because the generated spec build failed.",
    });
    expect(kickoffBugScanAfterGate(root, true, { buildPassed: true, reviewApproved: false })).toEqual({
      launched: false,
      bugScanRunId: "",
      summary: "Bug scan blocked because the generated spec review was not approved.",
    });

    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    try {
      writeShellExecutable(smithersPath, 'printf "started run-abc-123\\n"');
      expect(kickoffBugScan(root, true)).toEqual({
        launched: true,
        bugScanRunId: "run-abc-123",
        summary: "Detached bug scan launched: run-abc-123.",
      });

      writeShellExecutable(smithersPath, 'printf "queued without id\\n"');
      const withoutId = kickoffBugScan(root, true);
      expect(withoutId.launched).toBe(true);
      expect(withoutId.bugScanRunId).toBe("");
      expect(withoutId.summary).toContain("run id not parsed");

      writeShellExecutable(smithersPath, 'printf "boom\\n" >&2\nexit 7');
      const failed = kickoffBugScan(root, true);
      expect(failed.launched).toBe(false);
      expect(failed.summary).toContain("Bug scan launch failed:");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("bugSlug and bugTicketMarkdown provide fallback, truncation, and default fields", async () => {
    const { bugSlug, bugTicketMarkdown } = await bugScanModule();

    expect(bugSlug("  File path (weird)! ")).toBe("file-path-weird");
    expect(bugSlug("x".repeat(120))).toHaveLength(80);
    expect(bugSlug("!!!")).toBe("bug");
    expect(bugSlug(null)).toBe("bug");

    const markdown = bugTicketMarkdown("run-1", { id: "bug-1" });
    expect(markdown).toContain("# bug-1");
    expect(markdown).toContain("Run: run-1");
    expect(markdown).toContain("Severity: minor");
    expect(markdown).not.toContain("Priority:");
    expect(bugTicketMarkdown("run-2", { id: "bug-2", priority: "p1" })).toContain("Priority: P1");
    expect(markdown).toContain("No evidence recorded.");
    expect(markdown).toContain("Not specified.");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  test("fileBugTickets files markdown, dedupes existing tickets, updates known features, and rebuilds generated docs", async () => {
    const root = tempRoot();
    writeFeatures(root, [
      {
        id: "known-feature",
        title: "Known Feature",
        summary: "Known feature summary.",
        status: "fixed",
        priority: "p0",
        owner: "product",
        missing: [],
      },
    ]);
    const { fileBugTickets } = await bugScanModule();
    const finding = {
      id: "bug-1",
      title: "Trim crashes on null",
      severity: "major",
      featureId: "known-feature",
      file: "packages/server/src/index.ts",
      evidence: "risk(null) throws",
      suggestedFix: "Guard null before trim.",
    };

    const first = fileBugTickets("run-1", [finding], root);
    expect(first.created).toBe(1);
    expect(first.skippedExisting).toBe(0);
    expect(first.featuresUpdated).toEqual(["known-feature"]);
    expect(first.buildPassed).toBe(true);
    expect(first.ticketPaths[0]).toBe("ddd-bug-scan--packages-server-src-index.ts--trim-crashes-on-null.md");

    const ticket = readFileSync(join(root, ".smithers/tickets", first.ticketPaths[0]), "utf8");
    expect(ticket).toContain("# Trim crashes on null");
    expect(ticket).toContain("Feature title: Known Feature");
    expect(ticket).toContain("Priority: P0");
    expect(ticket).toContain("risk(null) throws");
    const updatedFeatures = readFileSync(join(root, ".smithers/spec/features.json"), "utf8");
    expect(updatedFeatures).toContain('"status": "broken"');
    expect(updatedFeatures).toContain("Bug (major): Trim crashes on null [packages/server/src/index.ts]");
    expect(readFileSync(join(root, ".smithers/spec/content/features/known-feature.md"), "utf8")).toContain("Trim crashes on null");

    const second = fileBugTickets("run-2", [finding], root);
    expect(second.created).toBe(0);
    expect(second.skippedExisting).toBe(1);
    expect(second.featuresUpdated).toEqual([]);
    expect(second.buildPassed).toBe(true);
  });

  test("fileBugTickets handles unknown features, unreadable specs, invalid builds, and no confirmed findings", async () => {
    const root = tempRoot();
    const { fileBugTickets } = await bugScanModule();

    const unknown = fileBugTickets("run-unknown", [
      { id: "bug-unknown", title: "Unknown bug", severity: "minor", featureId: "missing-feature", file: "apps/web/src/app.ts" },
    ], root);
    expect(unknown.created).toBe(1);
    expect(unknown.featuresUpdated).toEqual([]);
    expect(unknown.buildPassed).toBe(true);

    const none = fileBugTickets("run-none", [], root);
    expect(none.created).toBe(0);
    expect(none.skippedExisting).toBe(0);
    expect(none.summary).toBe("No confirmed findings; nothing filed.");

    writeFileSync(join(root, ".smithers/spec/features.json"), "{");
    const unreadable = fileBugTickets("run-bad-json", [
      { id: "bug-json", title: "Json bug", severity: "major", featureId: "known-feature", file: "packages/a.ts" },
    ], root);
    expect(unreadable.created).toBe(1);
    expect(unreadable.featuresUpdated).toEqual([]);
    expect(unreadable.buildPassed).toBe(false);

    writeFeatures(root, [{ id: "bad", title: "Bad", summary: "Bad", status: "not-real", priority: "p0", owner: "product" }]);
    const invalidBuild = fileBugTickets("run-invalid", [
      { id: "bug-invalid", title: "Invalid build bug", severity: "critical", featureId: "bad", file: "packages/bad.ts" },
    ], root);
    expect(invalidBuild.created).toBe(1);
    expect(invalidBuild.featuresUpdated).toEqual(["bad"]);
    expect(invalidBuild.buildPassed).toBe(false);
  });

  test("fileBugTickets is idempotent when ticket files preexist but feature state is stale", async () => {
    const root = tempRoot();
    writeFeatures(root, [
      {
        id: "known-feature",
        title: "Known Feature",
        summary: "Known feature summary.",
        status: "fixed",
        priority: "p0",
        owner: "product",
        missing: "not-an-array",
      },
    ]);
    const { fileBugTickets, bugSlug } = await bugScanModule();
    const finding = {
      id: "bug-1",
      title: "Existing ticket still updates feature",
      severity: "critical",
      featureId: "known-feature",
      file: "packages/server/src/existing.ts",
      evidence: "existing(null) throws",
      suggestedFix: "Handle null.",
    };
    mkdirSync(join(root, ".smithers/tickets"), { recursive: true });
    const ticketName = `ddd-bug-scan--${bugSlug(finding.file)}--${bugSlug(finding.title)}.md`;
    writeFileSync(join(root, ".smithers/tickets", ticketName), "# Existing ticket\n");

    const result = fileBugTickets("run-existing", [finding], root);
    expect(result.created).toBe(0);
    expect(result.skippedExisting).toBe(1);
    expect(result.ticketPaths).toEqual([]);
    expect(result.featuresUpdated).toEqual(["known-feature"]);
    expect(result.buildPassed).toBe(true);

    const features = JSON.parse(readFileSync(join(root, ".smithers/spec/features.json"), "utf8"));
    expect(features[0].status).toBe("broken");
    expect(features[0].missing).toEqual(["Bug (critical): Existing ticket still updates feature [packages/server/src/existing.ts]"]);

    const second = fileBugTickets("run-existing-again", [finding], root);
    expect(second.created).toBe(0);
    expect(second.skippedExisting).toBe(1);
    expect(second.featuresUpdated).toEqual([]);
    const stableFeatures = JSON.parse(readFileSync(join(root, ".smithers/spec/features.json"), "utf8"));
    expect(stableFeatures[0].missing).toEqual(features[0].missing);
  });

  test("fileBugTickets collapses duplicate confirmed findings and reports build failure after updating features", async () => {
    const root = tempRoot();
    writeFeatures(root, [
      {
        id: "known-feature",
        title: "Known Feature",
        summary: "Known feature summary.",
        status: "fixed",
        priority: "p0",
        owner: "product",
        missing: [],
      },
      {
        id: "broken-build-feature",
        title: "Broken Build Feature",
        summary: "Invalid status should make the rebuild fail after updates.",
        status: "not-real",
        priority: "p0",
        owner: "product",
        missing: [],
      },
    ]);
    const { fileBugTickets } = await bugScanModule();
    const duplicate = {
      id: "bug-duplicate",
      title: "Duplicate gap",
      severity: "major",
      featureId: "known-feature",
      file: "packages/server/src/duplicate.ts",
      evidence: "duplicate evidence",
    };
    const buildFailure = {
      id: "bug-build",
      title: "Build failure is still reported",
      severity: "minor",
      featureId: "broken-build-feature",
      file: "packages/server/src/build.ts",
      evidence: "build evidence",
    };

    const result = fileBugTickets("run-duplicates", [duplicate, { ...duplicate, id: "bug-duplicate-again" }, buildFailure], root);
    expect(result.created).toBe(2);
    expect(result.skippedExisting).toBe(1);
    expect(result.featuresUpdated.sort()).toEqual(["broken-build-feature", "known-feature"]);
    expect(result.buildPassed).toBe(false);
    expect(result.summary).toContain("build FAILED");

    const ticketFiles = result.ticketPaths.filter((path) => path.includes("duplicate-gap"));
    expect(ticketFiles).toHaveLength(1);
    const features = JSON.parse(readFileSync(join(root, ".smithers/spec/features.json"), "utf8"));
    const known = features.find((feature: any) => feature.id === "known-feature");
    expect(known.status).toBe("broken");
    expect(known.missing).toEqual(["Bug (major): Duplicate gap [packages/server/src/duplicate.ts]"]);
  });
});
