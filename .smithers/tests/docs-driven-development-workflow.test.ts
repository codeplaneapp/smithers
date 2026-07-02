import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = resolve(here, "../workflows/docs-driven-development.tsx");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

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
      agent: "sonnet",
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
          agent: "codex",
          taskType: "fix",
          reason: "Need proof.",
          acceptance: ["Ticket is written."],
        },
      ],
    });
    expect(full.created).toBe(1);
    expect(full.tickets[0].path).toBe("docs-driven-development--run-with-spaces--02-docs-driven-development");
    const written = join(root, ".smithers/tickets/docs-driven-development--run-with-spaces--02-docs-driven-development.md");
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toContain("Task type: fix");
  });

  test("agent routing clamps max agents and falls back to Codex when Claude planning is disabled", async () => {
    const mod = await importWorkflow(tempRoot());

    expect(mod.resolvedMaxAgents(undefined)).toBe(1);
    expect(mod.resolvedMaxAgents(null)).toBe(1);
    expect(mod.resolvedMaxAgents(0)).toBe(1);
    expect(mod.resolvedMaxAgents(99)).toBe(8);
    expect(mod.resolvedMaxAgents("3")).toBe(3);
    expect(mod.resolvedMaxRounds(undefined)).toBe(100000);
    expect(mod.resolvedMaxRounds(null)).toBe(100000);
    expect(mod.resolvedMaxRounds(0)).toBe(100000);
    expect(mod.resolvedMaxRounds(7)).toBe(7);

    const ctx = (useClaudeForPlanning: boolean) => ({
      input: { useClaudeForPlanning },
      outputMaybe: () => ({ selected: [{ slot: 1, agent: "opus" }, { slot: 2, agent: "sonnet" }] }),
    });
    expect(mod.agentForSlot(ctx(false), 1).cliEngine).toBe("codex");
    expect(mod.agentForSlot(ctx(false), 2).cliEngine).toBe("codex");
    expect(mod.planningAgent(ctx(false)).cliEngine).toBe("codex");
    expect(mod.auditAgent(ctx(false)).cliEngine).toBe("codex");
    expect(mod.agentForSlot(ctx(true), 1).cliEngine).toBe("claude-code");
    expect(mod.agentForSlot(ctx(true), 3).cliEngine).toBe("codex");
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
});
