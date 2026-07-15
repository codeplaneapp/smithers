import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(here, "../workflows/docs-driven-development.tsx");
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) await removeTempDir(tempDirs.pop()!);
});

async function removeTempDir(dir: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

function tempRoot(status = "partial") {
  const root = mkdtempSync(join(tmpdir(), "ddd-workflow-"));
  tempDirs.push(root);
  mkdirSync(join(root, ".smithers/spec/content"), { recursive: true });
  writeFileSync(join(root, ".smithers/spec/content/overview.md"), "# Overview\n");
  writeFeatures(root, status);
  return root;
}

function writeFeatures(root: string, status: string) {
  writeFileSync(
    join(root, ".smithers/spec/features.json"),
    JSON.stringify([
      {
        id: "docs-driven-development",
        title: "Docs driven development",
        summary: "Keep the spec honest.",
        status,
        priority: "p0",
        owner: "product",
      },
    ], null, 2),
  );
}

async function importWorkflow(root: string): Promise<Record<string, any>> {
  const previous = process.cwd();
  process.chdir(root);
  try {
    return await import(`${workflowPath}?case=${Date.now()}-${Math.random()}`);
  } finally {
    process.chdir(previous);
  }
}

describe("docs-driven-development workflow guards", () => {
  test("boundedField spills values over 12k chars to an artifact and preserves a bounded preview", async () => {
    const root = tempRoot();
    const mod = await importWorkflow(root);

    const exact = mod.boundedField("x".repeat(12_000), "exact");
    expect(exact).toEqual({ value: "x".repeat(12_000), artifactPath: "", truncated: false });

    const long = "a".repeat(12_050);
    const bounded = mod.boundedField(long, "long-docs-diff");
    expect(bounded.truncated).toBe(true);
    expect(bounded.value).toContain("...[truncated 50 chars; full value:");
    expect(bounded.value.startsWith("a".repeat(12_000))).toBe(true);
    expect(bounded.artifactPath).toContain(".smithers/docs-driven-development/artifacts/long-docs-diff-");
    expect(readFileSync(bounded.artifactPath, "utf8")).toBe(long);
  });

  test("boundedField reuses a stable per-name artifact so repeated audit rounds never accumulate files", async () => {
    const root = tempRoot();
    const mod = await importWorkflow(root);
    const artifactsDir = join(root, ".smithers/docs-driven-development/artifacts");

    const first = mod.boundedField("a".repeat(20_000), "round-diff");
    const second = mod.boundedField("b".repeat(20_000), "round-diff");

    // Each round overwrites the same `<name>-latest.txt` instead of spilling a
    // new timestamped file, so the auditor's bounded input set cannot grow.
    expect(first.artifactPath).toBe(second.artifactPath);
    expect(readdirSync(artifactsDir).filter((name) => name.startsWith("round-diff"))).toEqual([
      "round-diff-latest.txt",
    ]);
    expect(readFileSync(second.artifactPath, "utf8")).toBe("b".repeat(20_000));
  });

  test("resolveMaxIterations clamps audit-only runs to a single round and preserves bounded implementation rounds", async () => {
    const mod = await importWorkflow(tempRoot());

    // runImplementation:false can never self-terminate (no work wave ever
    // renders), so it must run exactly one spec-refresh pass, whatever maxRounds says.
    expect(mod.resolveMaxIterations(undefined, false)).toBe(1);
    expect(mod.resolveMaxIterations(100000, false)).toBe(1);
    expect(mod.resolveMaxIterations(7, false)).toBe(1);
    // With implementation enabled, the long-running default and explicit caps stand.
    expect(mod.resolveMaxIterations(undefined, true)).toBe(100000);
    expect(mod.resolveMaxIterations(0, true)).toBe(100000);
    expect(mod.resolveMaxIterations(7, true)).toBe(7);
  });

  test("tryRunCommand reports success and failure explicitly instead of leaking error text as command output", async () => {
    const mod = await importWorkflow(tempRoot());

    const ok = mod.tryRunCommand("git", ["--version"]);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("git");
    expect(ok.error).toBe("");

    const failed = mod.tryRunCommand("smithers-no-such-binary-xyz", ["status"]);
    expect(failed.ok).toBe(false);
    expect(failed.output).toBe("");
    expect(failed.error.length).toBeGreaterThan(0);

    // The metaTicket node derives codeDiffFiles from this seam; on failure the
    // list must be empty, never error prose split into fake file names.
    const codeDiffFiles = failed.ok ? failed.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
    expect(codeDiffFiles).toEqual([]);
  });

  test("runCommandResult logs command failures so they surface in run logs", async () => {
    const mod = await importWorkflow(tempRoot());
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      const failed = mod.runCommandResult("smithers-no-such-binary-xyz", [], "code-diff");
      expect(failed.ok).toBe(false);
      const ok = mod.runCommandResult("git", ["--version"], "git-version");
      expect(ok.ok).toBe(true);
    } finally {
      console.error = originalError;
    }
    expect(logged.some((line) => line.includes("code-diff"))).toBe(true);
  });

  test("cleanDiffForMetaTicket filters generated, workflow, UI, and DDD script paths", async () => {
    const mod = await importWorkflow(tempRoot());
    const cleaned = mod.cleanDiffForMetaTicket([
      "diff --git a/.smithers/spec/content/features/x.md b/.smithers/spec/content/features/x.md",
      "+generated feature doc",
      "diff --git a/.smithers/ui/ddd-docsContent.generated.ts b/.smithers/ui/ddd-docsContent.generated.ts",
      "diff --git a/.smithers/workflows/docs-driven-development.tsx b/.smithers/workflows/docs-driven-development.tsx",
      "diff --git a/.smithers/ui/docs-driven-development.tsx b/.smithers/ui/docs-driven-development.tsx",
      "diff --git a/.smithers/lib/ddd/build.ts b/.smithers/lib/ddd/build.ts",
      "diff --git a/.smithers/spec/content/overview.md b/.smithers/spec/content/overview.md",
      "+real editor change",
    ].join("\n"));

    expect(cleaned).toContain(".smithers/spec/content/overview.md");
    expect(cleaned).toContain("+real editor change");
    expect(cleaned).not.toContain("generated feature doc");
    expect(cleaned).not.toContain("ddd-docsContent.generated");
    expect(cleaned).not.toContain(".smithers/lib/ddd/build.ts");
  });

  test("ticketMarkdownFor accepts camelCase and snake_case task types and materializes empty/non-empty triage tickets", async () => {
    const root = tempRoot();
    const mod = await importWorkflow(root);

    const snake = mod.ticketMarkdownFor("run/with spaces", {
      slot: 2,
      featureId: "docs-driven-development",
      title: "Prove DDD",
      agent: "review",
      task_type: "e2e",
      reason: "Missing browser proof.",
      files: [".smithers/ui/docs-driven-development.tsx"],
      tests: ["bun test tests/docs-driven-development-ui.e2e.test.tsx"],
      acceptance: ["Dispatch launches a real run."],
    });
    expect(snake).toContain("Task type: e2e");
    expect(snake).toContain("- .smithers/ui/docs-driven-development.tsx");

    const empty = mod.materializeTriageTickets("empty-run", { selected: [] });
    expect(empty.created).toBe(0);
    expect(empty.summary).toContain("No triage selections");

    const full = mod.materializeTriageTickets("run/with spaces", {
      selected: [
        {
          slot: 2,
          featureId: "docs-driven-development",
          title: "Prove DDD",
          agent: "implementation",
          taskType: "fix",
          reason: "Need proof.",
          acceptance: ["Ticket is written."],
        },
      ],
    });
    expect(full.created).toBe(1);
    expect(full.tickets[0].path).toMatch(
      /^docs-driven-development--run-with-spaces--02-docs-driven-development-[0-9a-f]{8}$/,
    );
    const written = join(root, ".smithers/tickets", `${full.tickets[0].path}.md`);
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toContain("Task type: fix");
  });

  test("materializeTriageTickets uses real ticket paths and feature-title fallbacks", async () => {
    const root = tempRoot();
    const mod = await importWorkflow(root);

    const full = mod.materializeTriageTickets("path-shape-run", {
      selected: [
        {
          slot: 1,
          featureId: "docs-driven-development",
          title: "",
          agent: "implementation",
          taskType: "e2e",
          reason: "Materialized and gateway tickets must dedupe to one row.",
        },
        {
          slot: 2,
          feature_id: "",
          feature_title: "Snake Case Feature",
          title: "",
          agent: "review",
          task_type: "fix",
          reason: "Empty feature id and title still produce a stable ticket.",
        },
      ],
    });

    expect(full.created).toBe(2);
    expect(full.tickets[0]).toMatchObject({
      featureId: "docs-driven-development",
      featureTitle: "Docs driven development",
    });
    expect(full.tickets[0].path).toMatch(
      /^docs-driven-development--path-shape-run--01-docs-driven-development-[0-9a-f]{8}$/,
    );
    expect(full.tickets[1]).toMatchObject({
      featureId: "",
      featureTitle: "Snake Case Feature",
    });
    expect(full.tickets[1].path).toMatch(/^docs-driven-development--path-shape-run--02-ticket-[0-9a-f]{8}$/);

    const materializedPath = join(root, ".smithers/tickets", `${full.tickets[0].path}.md`);
    expect(existsSync(materializedPath)).toBe(true);
    const materialized = readFileSync(materializedPath, "utf8");
    expect(materialized).toContain("Feature title: Docs driven development");
    expect(materialized).toContain("Materialized and gateway tickets must dedupe");
  });

  test("agent routing caps max agents and selects generic configured roles", async () => {
    const mod = await importWorkflow(tempRoot());

    expect(mod.resolvedMaxAgents(undefined)).toBe(1);
    expect(mod.resolvedMaxAgents(null)).toBe(1);
    expect(mod.resolvedMaxAgents(0)).toBe(1);
    expect(mod.resolvedMaxAgents(99)).toBe(1);
    expect(mod.resolvedMaxAgents("3")).toBe(1);
    expect(mod.resolvedMaxRounds(undefined)).toBe(100000);
    expect(mod.resolvedMaxRounds(null)).toBe(100000);
    expect(mod.resolvedMaxRounds(0)).toBe(100000);
    expect(mod.resolvedMaxRounds(7)).toBe(7);

    const ctx = () => ({
      input: {},
      outputMaybe: () => ({ selected: [{ slot: 1, agent: "review" }, { slot: 2, agent: "implementation" }] }),
    });
    expect(Array.isArray(mod.agentForSlot(ctx(), 1))).toBe(true);
    expect(Array.isArray(mod.agentForSlot(ctx(), 2))).toBe(true);
    expect(Array.isArray(mod.planningAgent(ctx()))).toBe(true);
    expect(Array.isArray(mod.auditAgent(ctx()))).toBe(true);
    expect(mod.agentForSlot(ctx(), 1)).not.toBe(mod.agentForSlot(ctx(), 2));
    expect(mod.agentForSlot(ctx(), 3)).toBe(mod.agentForSlot(ctx(), 2));
  });

  test("productComplete trusts round-summary done only when features.json has zero incomplete records", async () => {
    const root = tempRoot("partial");
    const mod = await importWorkflow(root);
    const ctx = { outputMaybe: () => ({ status: "done" }) };

    expect(mod.featuresStillIncomplete()).toBe(1);
    expect(mod.productComplete(ctx)).toBe(false);

    writeFeatures(root, "fixed");
    expect(mod.featuresStillIncomplete()).toBe(0);
    expect(mod.productComplete(ctx)).toBe(true);

    writeFileSync(join(root, ".smithers/spec/features.json"), "{");
    expect(mod.featuresStillIncomplete()).toBe(-1);
    expect(mod.productComplete(ctx)).toBe(false);
  });

  test("roundSummaryFromDeps handles camelCase/snake_case audit and review fields plus disabled work", async () => {
    const mod = await importWorkflow(tempRoot());

    const disabled = mod.roundSummaryFromDeps({
      audit: {},
      review: { approved: true },
      spec: { status: "ready" },
      triage: { selected: [] },
      materializedTickets: { created: 0 },
    });
    expect(disabled.status).toBe("partial");
    expect(disabled.remaining).toEqual([]);

    const mixed = mod.roundSummaryFromDeps({
      audit: { missing_e2e: ["cli"], missingDocs: ["gateway"], broken: ["engine"], partial: ["memory"] },
      review: { approved: false, blocking_findings: ["needs regression test"] },
      work: { status: "partial", featureId: "cli", summary: "not done" },
    });
    expect(mixed.status).toBe("blocked");
    expect(mixed.remaining).toEqual([
      "broken: engine",
      "partial: memory",
      "missing e2e: cli",
      "missing docs: gateway",
      "partial: cli - not done",
      "review blocker: needs regression test",
    ]);

    const done = mod.roundSummaryFromDeps({
      audit: { missingE2E: [], missingDocs: [], broken: [], partial: [] },
      review: { approved: true, blockingFindings: [] },
      work: [{ status: "done", featureId: "gateway", summary: "proved" }],
    });
    expect(done.status).toBe("done");
    expect(done.fixed).toEqual(["gateway: proved"]);
  });

  test("workflow prompt contracts preserve bounded reads, feature fields, and running-source guardrails", () => {
    const source = readFileSync(workflowPath, "utf8");

    expect(source).toContain('Start with "bun .smithers/lib/ddd/auditInputs.ts"');
    expect(source).toContain("Do not recursively read .smithers/executions or .smithers/pg");
    expect(source).toContain("Preserve tier, group, userValue, capabilities, endpoints, and links on every record");
    expect(source).toContain("group is an end-user journey discovered from this product");
    expect(source).toContain("Every link href must resolve to an existing content file");
    expect(source).toContain("do not recursively start another run");
    expect(source).toContain("OFF-LIMITS during a run");
    expect(source).toContain("NEVER edit the live DDD machinery");
    expect(source).toContain("Record pack defects in the summary");
  });
});
