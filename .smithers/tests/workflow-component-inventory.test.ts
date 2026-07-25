import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { discoverWorkflows } from "@smithers-orchestrator/cli/workflows";

const packRoot = join(import.meta.dir, "..");
const repoRoot = join(packRoot, "..");
const workflowRoot = join(packRoot, "workflows");
const componentRoot = join(packRoot, "components");

const slash = (value: string) => value.split(sep).join("/");
const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b));

const workflowOwners = {
  "./tests/daily-ceo-intel-pipeline.test.ts": ["daily-ceo-intel.tsx"],
  "./tests/issue-blitz.test.ts": ["issue-blitz.tsx", "issue-train.tsx"],
  "./tests/curated-authoring-workflows.test.tsx": ["create-skill.tsx", "create-workflow.tsx"],
  "./tests/curated-ddd-eval-workflows.test.tsx": ["docs-driven-development.tsx", "eval-suite-run.tsx"],
  "./tests/curated-system-workflows.test.tsx": ["init.tsx", "post-failure.tsx", "upgrade.tsx"],
  "./tests/seeded-pack-workflows.test.tsx": ["add.tsx", "share-pack.tsx"],
  "./tests/seeded-workflows-a-foundations.test.tsx": ["audit.tsx", "backpressure-plan.tsx", "context-doctor.tsx", "create-ui.tsx", "eval-author.tsx", "events-probe.tsx", "extract-skill.tsx", "feature-enum.tsx", "hello.tsx"],
  "./tests/seeded-workflows-a-progression.test.tsx": ["context-engineer.tsx", "debug.tsx", "delegation-chain.tsx", "extract-prompt.tsx", "grill-all-three.tsx", "grill-me.tsx", "implement.tsx", "improve-test-coverage.tsx"],
  "./tests/seeded-onboarding-mission.test.tsx": ["make-workflow-tutorial.tsx", "mission.tsx", "smithering.tsx"],
  "./tests/seeded-core-workflows.test.tsx": ["plan.tsx", "ralph.tsx", "research-plan-implement.tsx", "research.tsx", "review.tsx", "route-task.tsx", "ticket-create.tsx", "tickets-create.tsx"],
  "./tests/seeded-ops-workflows.test.tsx": ["release.tsx", "report-slideshow.tsx", "smoketest.tsx", "ticket-fleet-monitor.tsx", "triage-run.tsx", "workflow-skill.tsx"],
  "./tests/local-workflows-a-audit.test.tsx": ["audit-burndown.tsx", "audit-fix-train.tsx", "break-smithers.tsx", "build-tui-monitor.tsx", "bulletproof-audit.tsx", "bulletproof-ui-design-pass.tsx", "bulletproof-ui-watchdog.tsx", "bulletproof-ui.tsx", "close-issues.tsx"],
  "./tests/local-workflows-a-queue.test.tsx": ["codex-issue-merge-queue.tsx", "consolidate-tanstack-db.tsx", "context-engineering-levers.tsx", "coverage-codex-swarm.tsx", "crash-recovery.tsx"],
  "./tests/local-workflows-a-maintenance.test.tsx": ["daily-benchmark-maintenance.tsx", "daily-canary.tsx", "demo.tsx", "dynamic-demo.tsx", "e2e-approval-probe.tsx", "e2e-ask-human-probe.tsx", "e2e-probe.tsx", "fail-probe.tsx"],
  "./tests/local-workflows-a-issues.test.tsx": ["fix-all-issues.tsx", "fix-six-issues.tsx", "implement-codex-antigravity.tsx"],
  "./tests/local-workflows-b-delivery.test.tsx": ["kanban.tsx", "local-ui-feature-swarm.tsx", "merge-train-all-issues.tsx", "plan-implement-review-issues.tsx", "pr-review-improve-merge.tsx"],
  "./tests/local-workflows-b-framework-issues.test.tsx": ["issue-222-integrations-agent-callable-tool-catalog.tsx", "issue-306-audit-test-coverage-gaps-apps-gateway-ui.tsx", "issue-491-review-cloud-hosted-walkthrough-lifecycl.tsx", "issue-522-components-seven-composite-components-ar.tsx"],
  "./tests/local-workflows-b-pipeline.test.tsx": ["implement-packs.tsx", "implement-plue-runner.tsx", "implement-stable.tsx", "investor.tsx"],
  "./tests/implement-testing-framework-e2e-workflow.test.ts": ["implement-testing-framework-e2e.tsx"],
  "./tests/local-workflows-b-real-release.test.tsx": ["real-stack-e2e.tsx", "release-content.tsx"],
  "./tests/local-workflows-b-utilities.test.tsx": ["open-code-review.tsx", "openclaw-integration-hardening.tsx", "plue-demo-child.tsx", "postgres-tanstack-sync.tsx", "repo-prospector.tsx", "restore-claude-implement.tsx"],
  "./tests/local-workflows-c-control.test.tsx": ["review-cloud-ship.tsx"],
  "./tests/local-workflows-c-progression.test.tsx": ["roadmapbench.tsx", "serverless-refactor.tsx", "ship-pipeline.tsx", "sweep.tsx", "sync-features.tsx", "tanstack-db-migration.tsx", "tanstack-db-sync-engine.tsx", "telegram-daily-digest.tsx"],
  "./tests/local-workflows-c-utilities.test.tsx": ["microsandbox-finish.tsx", "review-codex-antigravity.tsx", "review-nokimi.tsx", "run-on-plue.tsx", "test-fortress-monitor.tsx", "trellis.tsx", "vcs.tsx", "verify-push-safety.tsx"],
  "./tests/local-workflows-c-orchestration.test.tsx": ["monitor-redesign.tsx", "orchbench.tsx", "route-and-merge-issues.tsx", "studio-parity-swarm.tsx", "test-fortress.tsx", "ultragrill.tsx", "validated-implement.tsx"],
  "./tests/ticket-fleet-workflow.test.tsx": ["ticket-fleet.tsx"],
  "./tests/authoring-benchmark-workflow.test.ts": ["authoring-benchmark.tsx"],
  "./tests/finish-campaigns.test.tsx": ["finish-campaigns.tsx"],
  "./tests/build-agentic-ui-library.test.tsx": ["build-agentic-ui-library.tsx"],
  "./tests/converge-agentic-ui-library.test.tsx": ["converge-agentic-ui-library.tsx"],
  "./tests/finish-agentic-ui-library.test.tsx": ["finish-agentic-ui-library.tsx"],
  "./tests/docs-concise-workflow.test.tsx": ["docs-concise.tsx"],
  "./tests/agui-cross-verdicts-workflow.test.tsx": ["agui-cross-verdicts.tsx"],
  "./tests/agui-adopt-product-fix-workflow.test.tsx": ["agui-adopt-product-fix.tsx"],
  "./tests/land-shared-ui.test.tsx": ["land-shared-ui.tsx"],
  "./tests/riskless-github-issue-sweep.test.ts": ["riskless-github-issue-sweep.tsx"],
  "./tests/shared-ui-library.test.tsx": ["shared-ui-library.tsx"],
  "./tests/xstate-release-train.test.tsx": ["xstate-release-train.tsx"],
  "./tests/memory-recall-demo.test.tsx": ["memory-recall-demo.tsx"],
  "./tests/vibe-audit.test.tsx": ["vibe-audit.tsx"],
} as const;

const componentOwners = {
  "./tests/component-workflow-core.test.tsx": ["CommandProbe.tsx", "Estimate.tsx", "FeatureEnum.tsx", "ForEachFeature.tsx", "GrillMe.tsx", "LoopUntilScored.tsx", "PlanPanel.tsx", "Review.tsx"],
  "./tests/component-workflow-advanced.test.tsx": ["ShipTickets.tsx", "TestFortress.tsx", "ValidationLoop.tsx", "VerifiableGoals.tsx", "extract-prompt/ExtractPrompt.tsx"],
  "./tests/component-helpers.test.ts": ["extract-prompt/MarkdownPromptCache.ts", "extract-prompt/MemoryPromptCache.ts", "extract-prompt/PromptCache.ts", "extract-prompt/SqlitePromptCache.ts", "extract-prompt/index.ts", "extract-prompt/rctfCompletenessScorer.ts", "extract-prompt/rctfPromptSchema.ts", "extract-prompt/readLatestScore.ts", "extract-prompt/stakesToThreshold.ts", "roles.ts"],
  "./tests/xstate-release-train.test.tsx": ["releaseTrainMachine.ts"],
} as const;

function physicalWorkflowEntries(): string[] {
  const entries: string[] = [];
  for (const child of readdirSync(workflowRoot, { withFileTypes: true })) {
    if (child.name.startsWith(".") || child.name === "node_modules" || child.name === "curated") continue;
    if (child.isFile() && child.name.endsWith(".tsx")) entries.push(child.name);
    if (child.isDirectory()) {
      const candidate = join(workflowRoot, child.name, "workflow.tsx");
      try {
        if (statSync(candidate).isFile()) entries.push(`${child.name}/workflow.tsx`);
      } catch { /* not a directory-form workflow */ }
    }
  }
  return sorted(entries);
}

function productionComponentFiles(dir = componentRoot): string[] {
  const files: string[] = [];
  for (const child of readdirSync(dir, { withFileTypes: true })) {
    if (child.name.startsWith(".") || ["node_modules", "dist", "build", "coverage", "tests", "fixtures"].includes(child.name)) continue;
    const full = join(dir, child.name);
    if (child.isDirectory()) files.push(...productionComponentFiles(full));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(child.name) && !/\.(?:test|spec|d)\.[^.]+$/.test(child.name)) files.push(slash(relative(componentRoot, full)));
  }
  return sorted(files);
}

function assertOwnedExactlyOnce(physical: string[], owners: Record<string, readonly string[]>): void {
  const claimed = Object.values(owners).flat();
  expect(sorted(claimed)).toEqual(physical);
  expect(new Set(claimed).size).toBe(claimed.length);
  for (const owner of Object.keys(owners)) expect(statSync(join(packRoot, owner)).isFile()).toBe(true);
}

describe("shipped workflow and component test ownership", () => {
  test("CLI discovery and physical workflow entries agree exactly", () => {
    const home = mkdtempSync(join(tmpdir(), "smithers-inventory-home-"));
    try {
      const discovered = discoverWorkflows(repoRoot, { ...process.env, SMITHERS_HOME: home, SMITHERS_WORKFLOW_PATHS: "" })
        .filter((workflow) => workflow.scope === "local" && workflow.packDir === packRoot)
        .map((workflow) => slash(relative(workflowRoot, workflow.entryFile)));
      expect(sorted(discovered)).toEqual(physicalWorkflowEntries());
    } finally {
      try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best-effort temp cleanup */ }
    }
  });

  test("every discoverable workflow and production component has one focused owner", () => {
    assertOwnedExactlyOnce(physicalWorkflowEntries(), workflowOwners);
    assertOwnedExactlyOnce(productionComponentFiles(), componentOwners);
  });

  test("each owner suite actually references every module it claims", async () => {
    for (const [owner, files] of Object.entries(workflowOwners)) {
      const source = await Bun.file(join(packRoot, owner)).text();
      for (const file of files) expect(source, `${owner} does not reference ${file}`).toContain(file);
    }
    for (const [owner, files] of Object.entries(componentOwners)) {
      const source = await Bun.file(join(packRoot, owner)).text();
      for (const file of files) {
        const moduleName = file.replace(/\.(?:ts|tsx|js|jsx)$/, "").split("/").at(-1)!;
        expect(source, `${owner} does not reference ${moduleName}`).toContain(moduleName);
      }
    }
  });

  test("the default package test command includes every owner suite", async () => {
    const pkg = await Bun.file(join(packRoot, "package.json")).json() as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toContain("--preload ./preload.ts");
    expect(pkg.scripts.test).toContain("--max-concurrency=1");
    for (const owner of [...Object.keys(workflowOwners), ...Object.keys(componentOwners)]) {
      expect(pkg.scripts.test, `missing owner suite ${owner}`).toContain(owner);
    }
  });
});
