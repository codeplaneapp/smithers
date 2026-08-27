import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { discoverWorkflows } from "@smthrs/cli/workflows";
import { SMITHERS_WORKFLOW_VIEW_KIND } from "@smthrs/components";
import { renderWorkflow } from "smthrs/testing";
import "./whole-foods-meal-planner.test";

const packRoot = join(import.meta.dir, "..");
const repoRoot = join(packRoot, "..");
const workflowRoot = join(packRoot, "workflows");
const componentRoot = join(packRoot, "components");

const slash = (value: string) => value.split(sep).join("/");
const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b));

const workflowOwners = {
  "./tests/fallback-agents-poc.test.tsx": ["fallback-agents-poc.tsx"],
  "./tests/stacked-ship-workflow.test.tsx": ["stacked-ship.tsx"],
  "./tests/daily-ceo-intel-pipeline.test.ts": ["daily-ceo-intel.tsx"],
  "./tests/issue-blitz.test.ts": ["issue-blitz.tsx", "issue-train.tsx"],
  "./tests/curated-authoring-workflows.test.tsx": ["create-skill.tsx", "create-workflow.tsx"],
  "./tests/curated-ddd-eval-workflows.test.tsx": ["docs-driven-development.tsx", "eval-suite-run.tsx"],
  "./tests/curated-system-workflows.test.tsx": ["init.tsx", "post-failure.tsx", "upgrade.tsx"],
  "./tests/seeded-pack-workflows.test.tsx": ["add.tsx", "share-pack.tsx"],
  "./tests/seeded-workflows-a-foundations.test.tsx": [
    "audit.tsx",
    "backpressure-plan.tsx",
    "context-doctor.tsx",
    "create-ui.tsx",
    "eval-author.tsx",
    "events-probe.tsx",
    "extract-skill.tsx",
    "feature-enum.tsx",
    "hello.tsx",
  ],
  "./tests/seeded-workflows-a-progression.test.tsx": [
    "context-engineer.tsx",
    "debug.tsx",
    "delegation-chain.tsx",
    "extract-prompt.tsx",
    "grill-all-three.tsx",
    "grill-me.tsx",
    "implement.tsx",
    "improve-test-coverage.tsx",
  ],
  "./tests/seeded-onboarding-mission.test.tsx": ["make-workflow-tutorial.tsx", "mission.tsx", "smithering.tsx"],
  "./tests/seeded-core-workflows.test.tsx": [
    "plan.tsx",
    "ralph.tsx",
    "research-plan-implement.tsx",
    "research.tsx",
    "review.tsx",
    "route-task.tsx",
    "ticket-create.tsx",
    "tickets-create.tsx",
  ],
  "./tests/seeded-ops-workflows.test.tsx": [
    "release.tsx",
    "report-slideshow.tsx",
    "smoketest.tsx",
    "ticket-fleet-monitor.tsx",
    "triage-run.tsx",
    "workflow-skill.tsx",
  ],
  "./tests/local-workflows-a-audit.test.tsx": [
    "audit-burndown.tsx",
    "audit-fix-train.tsx",
    "break-smithers.tsx",
    "build-tui-monitor.tsx",
    "bulletproof-audit.tsx",
    "bulletproof-ui-design-pass.tsx",
    "bulletproof-ui-watchdog.tsx",
    "bulletproof-ui.tsx",
    "close-issues.tsx",
  ],
  "./tests/local-workflows-a-queue.test.tsx": [
    "consolidate-tanstack-db.tsx",
    "context-engineering-levers.tsx",
    "coverage-codex-swarm.tsx",
    "crash-recovery.tsx",
  ],
  "./tests/local-workflows-a-maintenance.test.tsx": [
    "daily-benchmark-maintenance.tsx",
    "daily-canary.tsx",
    "demo.tsx",
    "dynamic-demo.tsx",
    "e2e-approval-probe.tsx",
    "e2e-ask-human-probe.tsx",
    "e2e-probe.tsx",
    "fail-probe.tsx",
  ],
  "./tests/local-workflows-a-issues.test.tsx": ["implement-codex-antigravity.tsx"],
  "./tests/local-workflows-b-delivery.test.tsx": [
    "kanban.tsx",
    "local-ui-feature-swarm.tsx",
    "plan-implement-review-issues.tsx",
    "pr-review-improve-merge.tsx",
  ],
  "./tests/local-workflows-b-framework-issues.test.tsx": [
    // Owns only archived issue single-shots under workflows/archive/, which
    // are not discoverable and therefore not part of this inventory.
  ],
  "./tests/local-workflows-b-pipeline.test.tsx": [
    "implement-packs.tsx",
    "implement-plue-runner.tsx",
    "implement-stable.tsx",
  ],
  "./tests/implement-testing-framework-e2e-workflow.test.ts": ["implement-testing-framework-e2e.tsx"],
  "./tests/local-workflows-b-real-release.test.tsx": ["real-stack-e2e.tsx", "release-content.tsx"],
  "./tests/local-workflows-b-utilities.test.tsx": [
    "open-code-review.tsx",
    "openclaw-integration-hardening.tsx",
    "plue-demo-child.tsx",
    "postgres-tanstack-sync.tsx",
    "restore-claude-implement.tsx",
  ],
  "./tests/local-workflows-c-control.test.tsx": ["review-cloud-ship.tsx"],
  "./tests/local-workflows-c-progression.test.tsx": [
    "roadmapbench.tsx",
    "serverless-refactor.tsx",
    "ship-pipeline.tsx",
    "sweep.tsx",
    "sync-features.tsx",
    "tanstack-db-migration.tsx",
    "tanstack-db-sync-engine.tsx",
    "telegram-daily-digest.tsx",
  ],
  "./tests/local-workflows-c-utilities.test.tsx": [
    "microsandbox-finish.tsx",
    "review-codex-antigravity.tsx",
    "review-nokimi.tsx",
    "run-on-plue.tsx",
    "test-fortress-monitor.tsx",
    "trellis.tsx",
    "vcs.tsx",
    "verify-push-safety.tsx",
  ],
  // Owns tui-parity only. Its sol-issue-train / xcombo-fix-train cases still
  // run, but local-workflows-c-orchestration is their registered owner.
  "./tests/local-workflows-d-campaigns.test.tsx": ["tui-parity.tsx"],
  "./tests/local-workflows-c-orchestration.test.tsx": [
    "monitor-redesign.tsx",
    "orchbench.tsx",
    "sol-issue-train.tsx",
    "studio-parity-swarm.tsx",
    "test-fortress.tsx",
    "ultragrill.tsx",
    "validated-implement.tsx",
    "xcombo-fix-train.tsx",
  ],
  "./tests/workflow-component-inventory.test.ts": [
    "bug-triage-train.tsx",
    "docs-home-design-system.tsx",
    "federation-approval-polish-hardening.tsx",
    "federation-architecture-fix.tsx",
    "federation-artifact-edge-sync.tsx",
    "federation-dynamic-read-hardening.tsx",
    "federation-final-audit-hardening.tsx",
    "federation-init-pack-support-hardening.tsx",
    "federation-luna-residual-hardening-2.tsx",
    "federation-manifest-hardening.tsx",
    "federation-materialization-inventory-hardening.tsx",
    "federation-pack-boundary-fix.tsx",
    "federation-release-plan-fix.tsx",
    "federation-standalone-manifest-hardening.tsx",
    "federation-static-import-audit.tsx",
    "federation-static-import-hardening.tsx",
    "federation-workflow-hardening-2.tsx",
    "file-change-contract.tsx",
    "n8n-gap-research.tsx",
    "n8n-mvp-mission-v2.tsx",
    "n8n-mvp-mission.tsx",
    "pr-polish-panel.tsx",
    "rename-dependents.tsx",
    "rename-package.tsx",
    "smithers-repo-federation.tsx",
    "sol-issue-train-pinned.tsx",
    "upgrade-dependents.tsx",
    "whole-foods-meal-planner.tsx",
  ],
  "./tests/review-since-publish.test.tsx": ["review-since-publish.tsx"],
  "./tests/ticket-fleet-workflow.test.tsx": ["ticket-fleet.tsx"],
  "./tests/jjhub-issue-fleet-workflow.test.tsx": ["jjhub-issue-fleet.tsx"],
  "./tests/ferric-campaign-workflows.test.tsx": ["react-rust-port.tsx", "ultrafusion.tsx"],
  "./tests/authoring-benchmark-workflow.test.ts": ["authoring-benchmark.tsx"],
  "./tests/api-ab-benchmark.test.tsx": ["api-ab-benchmark.tsx"],
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
} as const;

const componentOwners = {
  "./tests/ferric-campaign-workflows.test.tsx": [
    "accounts/accountAgents.ts",
    "accounts/accountPool.ts",
    "accounts/RefreshAccountUsage.tsx",
    "ferric/BenchTask.tsx",
    "ferric/CampaignGate.tsx",
    "ferric/Closeout.tsx",
    "ferric/ferricAgents.ts",
    "ferric/ferricConfig.ts",
    "ferric/ferricGates.ts",
    "ferric/ferricLedger.ts",
    "ferric/ferricSchemas.ts",
    "ferric/ferricShell.ts",
    "ferric/ferricSmithers.ts",
    "ferric/FoundationAndBudget.tsx",
    "ferric/FuzzTask.tsx",
    "ferric/PhaseGA.tsx",
    "ferric/PhaseM0.tsx",
    "ferric/PhaseM25.tsx",
    "ferric/PhaseM3.tsx",
    "ferric/PhaseM4.tsx",
    "ferric/PhaseM5M6.tsx",
    "ferric/PhaseM7.tsx",
    "ferric/PhaseM8.tsx",
    "ferric/PhaseM9.tsx",
    "ferric/PortCampaign.tsx",
    "ferric/PublishPipeline.tsx",
    "ferric/QueueParse.tsx",
    "ferric/Slice.tsx",
    "ferric/SuiteTask.tsx",
    "ferric/TrialPhase.tsx",
  ],
  "./tests/component-workflow-core.test.tsx": [
    "CommandProbe.tsx",
    "Estimate.tsx",
    "FeatureEnum.tsx",
    "ForEachFeature.tsx",
    "GrillMe.tsx",
    "LoopUntilScored.tsx",
    "PlanPanel.tsx",
    "Review.tsx",
  ],
  "./tests/component-workflow-advanced.test.tsx": [
    "ShipTickets.tsx",
    "TestFortress.tsx",
    "ValidationLoop.tsx",
    "VerifiableGoals.tsx",
    "extract-prompt/ExtractPrompt.tsx",
  ],
  "./tests/component-helpers.test.ts": [
    "extract-prompt/MarkdownPromptCache.ts",
    "extract-prompt/MemoryPromptCache.ts",
    "extract-prompt/PromptCache.ts",
    "extract-prompt/SqlitePromptCache.ts",
    "extract-prompt/index.ts",
    "extract-prompt/rctfCompletenessScorer.ts",
    "extract-prompt/rctfPromptSchema.ts",
    "extract-prompt/readLatestScore.ts",
    "extract-prompt/stakesToThreshold.ts",
    "roles.ts",
  ],
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
      } catch {
        /* not a directory-form workflow */
      }
    }
  }
  return sorted(entries);
}

function productionComponentFiles(dir = componentRoot): string[] {
  const files: string[] = [];
  for (const child of readdirSync(dir, { withFileTypes: true })) {
    if (
      child.name.startsWith(".") ||
      ["node_modules", "dist", "build", "coverage", "tests", "fixtures"].includes(child.name)
    )
      continue;
    const full = join(dir, child.name);
    if (child.isDirectory()) files.push(...productionComponentFiles(full));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(child.name) && !/\.(?:test|spec|d)\.[^.]+$/.test(child.name))
      files.push(slash(relative(componentRoot, full)));
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
      const discovered = discoverWorkflows(repoRoot, {
        ...process.env,
        SMITHERS_HOME: home,
        SMITHERS_WORKFLOW_PATHS: "",
      })
        .filter((workflow) => workflow.scope === "local" && workflow.packDir === packRoot)
        .map((workflow) => slash(relative(workflowRoot, workflow.entryFile)));
      expect(sorted(discovered)).toEqual(physicalWorkflowEntries());
    } finally {
      try {
        rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* best-effort temp cleanup */
      }
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
        const moduleName = file
          .replace(/\.(?:ts|tsx|js|jsx)$/, "")
          .split("/")
          .at(-1)!;
        expect(source, `${owner} does not reference ${moduleName}`).toContain(moduleName);
      }
    }
  });

  test("the default package test command includes every owner suite", async () => {
    const pkg = (await Bun.file(join(packRoot, "package.json")).json()) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toContain("--preload ./preload.ts");
    expect(pkg.scripts.test).toContain("--max-concurrency=1");
    for (const owner of [...Object.keys(workflowOwners), ...Object.keys(componentOwners)]) {
      expect(pkg.scripts.test, `missing owner suite ${owner}`).toContain(owner);
    }
  });
});

const federationStandalone = [
  ["federation-approval-polish-hardening.tsx", "hardenApprovalPolishFindings"],
  ["federation-architecture-fix.tsx", "fix"],
  ["federation-artifact-edge-sync.tsx", "synchronizeFutureDependencyFacts"],
  ["federation-dynamic-read-hardening.tsx", "hardenDynamicReads"],
  ["federation-final-audit-hardening.tsx", "hardenFinalAuditFindings"],
  ["federation-init-pack-support-hardening.tsx", "inventoryInitPackSupportExactly"],
  ["federation-luna-residual-hardening-2.tsx", "hardenFreshLunaResiduals"],
  ["federation-manifest-hardening.tsx", "harden"],
  ["federation-materialization-inventory-hardening.tsx", "inventoryAllMaterializations"],
  ["federation-pack-boundary-fix.tsx", "fixPackBoundary"],
  ["federation-release-plan-fix.tsx", "fix"],
  ["federation-standalone-manifest-hardening.tsx", "resolveFinalStandaloneFindings"],
  ["federation-static-import-audit.tsx", "auditStaticImports"],
  ["federation-static-import-hardening.tsx", "hardenStaticImports"],
  ["federation-workflow-hardening-2.tsx", "harden"],
] as const;

async function renderWorkflowFile(file: string) {
  const workflowPath = join(workflowRoot, file);
  const module = await import(workflowPath);
  return await renderWorkflow(module.default, { workflowPath, input: {}, outputs: {} });
}

describe("federation workflow smoke coverage", () => {
  test("standalone hardening workflows render their single typed task", async () => {
    for (const [file, nodeId] of federationStandalone) {
      const frame = await renderWorkflowFile(file);
      expect(
        frame.tasks.map((task) => task.nodeId),
        file,
      ).toEqual([nodeId]);
      expect(frame.tasks[0]?.outputSchema, file).toBeDefined();
    }
  }, 60_000);

  test("campaign workflows retain their initial boundaries and bounded defaults", async () => {
    const federation = await renderWorkflowFile("smithers-repo-federation.tsx");
    expect(federation.tasks.map((task) => task.nodeId)).toContain("prepareRoot");

    const file = "sol-issue-train-pinned.tsx";
    const workflowPath = join(workflowRoot, file);
    const module = await import(workflowPath);
    expect(module.default.inputSchema.parse({})).toMatchObject({
      maxIssues: 400,
      waveSize: 8,
      reviewIterations: 3,
      gateFixIterations: 3,
      dryRun: false,
    });
    const train = await renderWorkflow(module.default, { workflowPath, input: {}, outputs: {} });
    expect(train.tasks.map((task) => task.nodeId)).toContain("setup");
  }, 30_000);

  test("docs-home-design-system loops implement then review until the reviewer says LGTM", async () => {
    const workflowPath = join(workflowRoot, "docs-home-design-system.tsx");
    const module = await import(workflowPath);
    const first = await renderWorkflow(module.default, { workflowPath, input: {}, outputs: {} });
    const nodeIds = first.tasks.map((task) => task.nodeId);

    expect(nodeIds).toContain("dhds:implement");
    expect(nodeIds).toContain("dhds:review");
    expect(nodeIds.indexOf("dhds:implement")).toBeLessThan(nodeIds.indexOf("dhds:review"));

    const xml = first.toXml();
    expect(xml).toContain('"smithers:ralph"');
    expect(xml).toContain("design system");
  }, 30_000);

  test("dependent rename and upgrade workflows render their lead lanes", async () => {
    const renamePackage = await renderWorkflowFile("rename-package.tsx");
    expect(renamePackage.tasks.map((task) => task.nodeId)).toContain("sweep-packages");

    const renamePath = join(workflowRoot, "rename-dependents.tsx");
    const renameModule = await import(renamePath);
    expect(renameModule.default.inputSchema.safeParse({}).success).toBe(false);
    const renameDependents = await renderWorkflow(renameModule.default, {
      workflowPath: renamePath,
      input: { repos: ["smithersai/example-dependent"] },
      outputs: {},
    });
    expect(renameDependents.tasks.map((task) => task.nodeId)).toContain("rename-smithersai-example-dependent");

    const upgradeDependents = await renderWorkflowFile("upgrade-dependents.tsx");
    expect(upgradeDependents.tasks.map((task) => task.nodeId)).toContain("discover");
  }, 30_000);

  test("file-change-contract leads with the spec task before fixtures, polish, and land", async () => {
    const frame = await renderWorkflowFile("file-change-contract.tsx");
    const nodeIds = frame.tasks.map((task) => task.nodeId);
    expect(nodeIds).toContain("fcc:spec");
    expect(nodeIds[0]).toBe("fcc:spec");
    expect(frame.tasks[0]?.outputSchema).toBeDefined();
  }, 30_000);

  test("n8n research fans out one task per facet before synthesizing", async () => {
    const frame = await renderWorkflowFile("n8n-gap-research.tsx");
    const nodeIds = frame.tasks.map((task) => task.nodeId);
    const facets = nodeIds.filter((id) => id.startsWith("gap:") && id !== "gap:synthesize");
    expect(facets.length).toBeGreaterThan(1);
    expect(nodeIds).toContain("gap:synthesize");
    expect(nodeIds.indexOf("gap:synthesize")).toBeGreaterThan(nodeIds.indexOf(facets[0]!));
  }, 30_000);

  test("n8n-mvp-mission opens each round with an independent plan panel it then judges", async () => {
    const frame = await renderWorkflowFile("n8n-mvp-mission.tsx");
    const nodeIds = frame.tasks.map((task) => task.nodeId);
    expect(nodeIds).toContain("mission:plan-fable");
    expect(nodeIds).toContain("mission:plan-sol");
    expect(nodeIds.indexOf("mission:plan-fable")).toBeLessThan(nodeIds.indexOf("mission:plan"));
    // Never-stop mission: no lanes exist until the judge emits a plan, so the
    // first frame stops at the synthesized plan rather than mounting lanes.
    expect(nodeIds.some((id) => id.startsWith("mission:impl:"))).toBe(false);
  }, 30_000);

  test("n8n-mvp-mission-v2 gates every round behind the environment preflight", async () => {
    const frame = await renderWorkflowFile("n8n-mvp-mission-v2.tsx");
    const nodeIds = frame.tasks.map((task) => task.nodeId);
    // v2's headline change over v1: a round never fans out onto a sick machine,
    // so the preflight runs ahead of the two independent planners and the judge.
    expect(nodeIds[0]).toBe("mission:preflight");
    expect(nodeIds.indexOf("mission:plan-fable")).toBeGreaterThan(nodeIds.indexOf("mission:preflight"));
    expect(nodeIds.indexOf("mission:plan-sol")).toBeGreaterThan(nodeIds.indexOf("mission:preflight"));
    expect(nodeIds.indexOf("mission:plan-sol")).toBeLessThan(nodeIds.indexOf("mission:plan"));
    expect(nodeIds.some((id) => id.startsWith("mission:impl:"))).toBe(false);
  }, 30_000);

  test("pr-polish-panel opens with independent reviews before the isolated polish step", async () => {
    const workflowPath = join(workflowRoot, "pr-polish-panel.tsx");
    const module = await import(workflowPath);
    const frame = await renderWorkflow(module.default, {
      workflowPath,
      input: { pr: 1449 },
      outputs: {},
    });
    const hasUiEntry = (node: any): boolean => {
      if (Array.isArray(node)) return node.some(hasUiEntry);
      if (!node || typeof node !== "object") return false;
      if (node.type?.[SMITHERS_WORKFLOW_VIEW_KIND] === "ui" && node.props?.entry === "../ui/pr-polish-panel.tsx") {
        return true;
      }
      return hasUiEntry(node.props?.children);
    };
    const nodeIds = frame.tasks.map((task) => task.nodeId);

    expect(nodeIds).toContain("review-fable");
    expect(nodeIds).toContain("review-sol");
    expect(nodeIds.indexOf("review-fable")).toBeLessThan(nodeIds.indexOf("polish"));
    expect(nodeIds.indexOf("review-sol")).toBeLessThan(nodeIds.indexOf("polish"));
    expect(frame.toXml()).toContain("git fetch origin main");
    expect(frame.toXml()).toContain("never merge the PR");
    expect(hasUiEntry(module.default.build(frame.ctx))).toBe(true);
  }, 30_000);

  test("pr-polish-panel derives deterministic run-isolated clone paths", async () => {
    const module = await import(join(workflowRoot, "pr-polish-panel.tsx"));
    const first = module.prPolishClonePath("run/with unsafe chars", 1449);
    const repeat = module.prPolishClonePath("run/with unsafe chars", 1449);
    const otherRun = module.prPolishClonePath("another-run", 1449);

    expect(first).toBe(repeat);
    expect(first).toEndWith("/pr-1449");
    expect(first).not.toContain("unsafe chars");
    expect(otherRun).not.toBe(first);
  });

  test("the publish approval is proof-bound to the reviewed release revision", async () => {
    const file = "smithers-repo-federation.tsx";
    const workflowPath = join(workflowRoot, file);
    const module = await import(workflowPath);
    const lanes = [
      "smithers-examples",
      "smithers-agents",
      "smithers-sandboxes",
      "smithers-integrations",
      "smithers-plugins",
      "smithers-packs",
      "smithers-observability",
      "smithers-review",
      "smithers-evals",
      "smithers-signal",
      "multi",
      "plue",
      "awesome-smithers",
    ];
    const binding = {
      nodeId: "releaseApprovalBinding",
      iteration: 0,
      laneRevisions: lanes.map((lane) => ({
        lane,
        headSha: `${lane}-reviewed`,
        remote: `https://github.com/smithersai/${lane}.git`,
        branch: `federation/${lane}`,
      })),
      releasePlanSha256: "reviewed-plan",
      coordinatorSha256: "reviewed-coordinator",
      summary: "Exact release revision captured for approval.",
    };
    const frame = await renderWorkflow(module.default, {
      workflowPath,
      input: {},
      outputs: {
        manifestReview: [
          {
            nodeId: "manifestReviewFinalApproved",
            approvable: true,
            summary: "reviewed",
            boundaryIssues: [],
            ambiguousUtilities: [],
            licenseGaps: [],
          },
        ],
        gateManifest: [{ nodeId: "gate-manifest", approved: true }],
        lanePush: lanes.map((lane) => ({ nodeId: `push-${lane}`, lane, pushed: true })),
        updateSmithers: [{ nodeId: "updateSmithers" }],
        releaseDryRun: [
          { nodeId: "releaseDryRun", ok: true },
          { nodeId: "releaseDryRunPostFix", ok: true },
        ],
        releaseReadiness: [{ nodeId: "releaseReadiness", ok: true, issues: [], summary: "ready" }],
        finalVerify: [{ nodeId: "finalVerify", approvable: true, fixList: [], summary: "reviewed" }],
        releaseApprovalBinding: [binding],
      },
    });
    const gate = frame.tasks.find((task) => task.nodeId === "gate-publish");

    expect(gate?.needsApproval).toBe(true);
    expect(gate?.proofBindingRequired).toBe(true);
    expect(gate?.proofBindings).toEqual([
      expect.objectContaining({
        table: "releaseApprovalBinding",
        nodeId: "releaseApprovalBinding",
        iteration: 0,
        digest: expect.stringMatching(/^sha256:/),
      }),
    ]);
  }, 30_000);
});
