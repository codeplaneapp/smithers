import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withDddProcessEnvLock } from "./docsDrivenDevelopmentRunFixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const realDddLib = resolve(here, "../lib/ddd");
const realNodeModules = resolve(repoRoot, "node_modules");
const tempDirs: string[] = [];

const generateWorkflowPath = resolve(here, "../workflows/ddd-generate-docs.tsx");
const bugScanWorkflowPath = resolve(here, "../workflows/ddd-bug-scan.tsx");

afterEach(async () => {
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

async function removeTempDir(dir: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: unknown }).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (process.platform === "win32") return;
  throw lastError;
}

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
  writeFileSync(path, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(path, 0o755);
}

function writeSmithersExecutable(path: string, output: "run" | "no-id" | "fail") {
  if (process.platform === "win32") {
    const source = output === "run"
      ? "@echo off\r\necho started run-abc-123\r\n"
      : output === "no-id"
        ? "@echo off\r\necho queued without id\r\n"
        : "@echo off\r\necho boom 1>&2\r\nexit /b 7\r\n";
    writeFileSync(path, source);
    return;
  }
  const source = output === "run"
    ? 'printf "started run-abc-123\\n"'
    : output === "no-id"
      ? 'printf "queued without id\\n"'
      : 'printf "boom\\n" >&2\nexit 7';
  writeFileSync(path, `#!/bin/sh\n${source}\n`);
  chmodSync(path, 0o755);
}

function smithersExecutablePath(binDir: string): string {
  return join(binDir, process.platform === "win32" ? "smithers.cmd" : "smithers");
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
    const smithersPath = smithersExecutablePath(binDir);
    const { kickoffBugScan, kickoffBugScanAfterGate, resolveExecutable } = await generateModule();

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

    await withDddProcessEnvLock(async () => {
      const previousPath = process.env.PATH;
      process.env.PATH = [binDir, previousPath ?? ""].filter(Boolean).join(delimiter);
      try {
        writeSmithersExecutable(smithersPath, "run");
        expect(resolveExecutable("smithers", process.env.PATH)).toBe(smithersPath);
        expect(kickoffBugScan(root, true)).toEqual({
          launched: true,
          bugScanRunId: "run-abc-123",
          summary: "Detached bug scan launched: run-abc-123.",
        });

        writeSmithersExecutable(smithersPath, "no-id");
        const withoutId = kickoffBugScan(root, true);
        expect(withoutId.launched).toBe(true);
        expect(withoutId.bugScanRunId).toBe("");
        expect(withoutId.summary).toContain("run id not parsed");

        writeSmithersExecutable(smithersPath, "fail");
        const failed = kickoffBugScan(root, true);
        expect(failed.launched).toBe(false);
        expect(failed.summary).toContain("Bug scan launch failed:");
      } finally {
        process.env.PATH = previousPath;
      }
    });
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
    expect(first.ticketPaths[0]).toMatch(
      /^ddd-bug-scan--packages-server-src-index\.ts--bug-1--trim-crashes-on-null--[0-9a-f]{8}\.md$/,
    );

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
    expect(unknown.ticketCreationPassed).toBe(true);
    expect(unknown.specUpdatePassed).toBe(true);
    expect(unknown.buildPassed).toBe(true);
    expect(unknown.ticketErrors).toEqual([]);
    expect(unknown.specErrors).toEqual([]);

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
    expect(unreadable.ticketCreationPassed).toBe(true);
    expect(unreadable.specUpdatePassed).toBe(false);
    expect(unreadable.buildPassed).toBe(false);
    expect(unreadable.specErrors.join("\n")).toContain("Failed to read");
    expect(unreadable.specErrors.join("\n")).toContain("features.json");
    expect(unreadable.buildErrors.join("\n")).toContain("Spec build failed");
    expect(unreadable.summary).toContain("spec update error");

    writeFeatures(root, [{ id: "bad", title: "Bad", summary: "Bad", status: "not-real", priority: "p0", owner: "product" }]);
    const invalidBuild = fileBugTickets("run-invalid", [
      { id: "bug-invalid", title: "Invalid build bug", severity: "critical", featureId: "bad", file: "packages/bad.ts" },
    ], root);
    expect(invalidBuild.created).toBe(1);
    expect(invalidBuild.featuresUpdated).toEqual(["bad"]);
    expect(invalidBuild.specUpdatePassed).toBe(true);
    expect(invalidBuild.buildPassed).toBe(false);
    expect(invalidBuild.buildErrors.join("\n")).toContain("Spec build failed");
    expect(invalidBuild.summary).toContain("build FAILED");
  });

  test("fileBugTickets reports ticket creation errors separately from spec updates", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".smithers/tickets"), "not a directory");
    const { fileBugTickets } = await bugScanModule();

    const result = fileBugTickets("run-ticket-error", [
      { id: "bug-ticket", title: "Ticket path is blocked", severity: "major", featureId: "known-feature", file: "packages/ticket.ts" },
    ], root);

    expect(result.created).toBe(0);
    expect(result.ticketCreationPassed).toBe(false);
    expect(result.ticketErrors.join("\n")).toContain("ticket");
    expect(result.specUpdatePassed).toBe(true);
    expect(result.featuresUpdated).toEqual(["known-feature"]);
    expect(result.buildPassed).toBe(true);
    expect(result.summary).toContain("ticket creation error");
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
    const { fileBugTickets } = await bugScanModule();
    const finding = {
      id: "bug-1",
      title: "Existing ticket still updates feature",
      severity: "critical",
      featureId: "known-feature",
      file: "packages/server/src/existing.ts",
      evidence: "existing(null) throws",
      suggestedFix: "Handle null.",
    };
    const preexisting = fileBugTickets("run-preexisting", [finding], root);
    expect(preexisting.created).toBe(1);
    expect(preexisting.ticketPaths[0]).toMatch(
      /^ddd-bug-scan--packages-server-src-existing\.ts--bug-1--existing-ticket-still-updates-feature--[0-9a-f]{8}\.md$/,
    );
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
    expect(result.buildErrors.join("\n")).toContain("Spec build failed");
    expect(result.summary).toContain("build FAILED");

    const ticketFiles = result.ticketPaths.filter((path) => path.includes("duplicate-gap"));
    expect(ticketFiles).toHaveLength(1);
    const features = JSON.parse(readFileSync(join(root, ".smithers/spec/features.json"), "utf8"));
    const known = features.find((feature: any) => feature.id === "known-feature");
    expect(known.status).toBe("broken");
    expect(known.missing).toEqual(["Bug (major): Duplicate gap [packages/server/src/duplicate.ts]"]);
  });

  test("generate-docs and bug-scan prompt contracts keep DDD safe and bounded", () => {
    const generateSource = readFileSync(generateWorkflowPath, "utf8");
    const bugScanSource = readFileSync(bugScanWorkflowPath, "utf8");

    expect(generateSource).toContain("never recursive dumps");
    expect(generateSource).toContain("never blindly replace records or drop their fields");
    expect(generateSource).toContain("preserve tier, group, userValue, capabilities, endpoints, and links");
    expect(generateSource).toContain("run \"bun .smithers/lib/ddd/build.ts\"");
    expect(generateSource).toContain("Set approved=true only when the spec is honest and the build passes");
    expect(generateSource).toContain("OFF-LIMITS — never edit, delete, or rewrite the DDD pack's own machinery");
    expect(generateSource).toContain(".smithers/workflows/ddd-*.tsx");
    expect(generateSource).toContain(".smithers/workflows/docs-driven-development.tsx");

    expect(bugScanSource).toContain("READ-ONLY: do not modify any file");
    expect(bugScanSource).toContain('Start with "bun .smithers/lib/ddd/auditInputs.ts"');
    expect(bugScanSource).toContain("Do not recursively read .smithers/executions or .smithers/pg");
    expect(bugScanSource).toContain("Default to rejected when uncertain");
    expect(bugScanSource).toContain("Do not launch docs-driven-development, ddd-generate-docs, or another ddd-bug-scan");
  });
});
