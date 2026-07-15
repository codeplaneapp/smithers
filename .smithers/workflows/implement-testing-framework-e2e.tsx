// smithers-source: user
// smithers-metadata-version: 1
// smithers-display-name: Implement Testing Framework E2E
// smithers-description: Research, plan, implement, verify, and iterate on the testing framework until Sol and Fable approve the same tested diff.
// smithers-tags: coding, testing, e2e, durability, review, consensus
/** @jsxImportSource smithers-orchestrator */
import { execFileSync, spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import {
  ClaudeCodeAgent,
  CodexAgent,
  type AgentLike,
  createSmithers,
} from "smithers-orchestrator";
import { z } from "zod/v4";
import ConsensusFableReviewPrompt from "../prompts/implement-testing-framework-e2e-consensus-fable-review.mdx";
import ConsensusImprovementPrompt from "../prompts/implement-testing-framework-e2e-consensus-improvement.mdx";
import ConsensusSolReviewPrompt from "../prompts/implement-testing-framework-e2e-consensus-sol-review.mdx";
import ImplementPrompt from "../prompts/implement-testing-framework-e2e-implement.mdx";
import InitialFixPrompt from "../prompts/implement-testing-framework-e2e-initial-fix.mdx";
import InitialSolReviewPrompt from "../prompts/implement-testing-framework-e2e-initial-sol-review.mdx";
import PlanPrompt from "../prompts/implement-testing-framework-e2e-plan.mdx";
import ResearchPrompt from "../prompts/implement-testing-framework-e2e-research.mdx";

const ROOT = process.cwd();
const LONG = 1_800_000;
const HEARTBEAT = 600_000;
const AGENT_RETRIES = 2;
const CHECK_TIMEOUT_MS = 7_200_000;
const CHECK_KILL_GRACE_MS = 10_000;
const OUTPUT_TAIL = 8_000;
const MAX_OBJECTIVE_CHARS = 100_000;
const MAX_FOCUSED_COMMANDS = 64;
const MAX_FOCUSED_COMMAND_CHARS = 1_000;
const MAX_REUSED_RUN_ID_CHARS = 256;
const SNAPSHOT_PATHS = [
  "packages/testing",
  "packages/smithers/src/testing.js",
  "packages/smithers/src/testing.d.ts",
  "packages/smithers/tests/barrels.test.js",
  "packages/smithers/tests/package-and-build-process-contract.test.js",
  "e2e/package.json",
  "e2e/faults/case31-real-engine-kill-resume.test.ts",
  "e2e/harness/engineChildRunner.ts",
  "e2e/testing-framework",
  "pnpm-lock.yaml",
  "docs/reference/testing-framework.mdx",
  "scripts/check-dependency-boundaries.mjs",
] as const;

function promptJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

const DEFAULT_OBJECTIVE = `
Implement the testing framework in packages/testing as an unusually high-control unit and
workflow-testing system. Keep the public authoring API plain TypeScript because coding agents
must be able to write tests quickly. Build the internal execution kernel Effect-first, and
translate Effect values/errors only at the final public boundary; do not expose Effect in the
default public API.

Required architecture and proof obligations:
- Separate immutable ScenarioAst authoring data, runtime ControlMessage commands, and observed
  TraceEvent output. Replay identity is scenario AST + seed + ordered control log.
- Support harness-specific configuration, capabilities, native error shapes, and scenario
  extensions without pretending every harness can perform every fault.
- Provide deterministic virtual time, seeded scheduling, explicit interleavings, barriers, and
  fault injection at typed durability cut points before/during/after a task. Arbitrary external
  side effects are controllable only when mediated through a taskRuntime.effect-style boundary;
  make unmediated effects explicitly opaque.
- Model journal/lease/retry/resume/crash ambiguity honestly. Do not promise exactly-once external
  effects. Cover duplicate delivery, crash-after-effect-before-journal, crash-after-journal-before-
  ack, lost wakeups, cancellation races, lease loss, and restart in the middle of a task.
- Make error mocks trustworthy with contract probes that exercise real production adapters/code
  and compare error class/tag/code/cause/serialization at the boundary. Unit harness simulations
  are allowed; tests called e2e must use real backends and real fault paths, never interception or
  fabricated backend data.
- Provide bounded wait/cleanup, replay and shrinking diagnostics, capability-aware failures or
  skips, reusable realistic fixtures, and an ergonomic dry-run path for agents.
- Preserve compatibility where reasonable, document migrations, and prove types, unit behavior,
  integration behavior, real fault behavior, and deterministic replay. Treat Effect Cause trees as
  internal/debug detail rather than a public compatibility contract.
- A harness advertised as real-db or real-process must execute the corresponding production system
  or fail admission explicitly; descriptors, declarations, echo runners, and skipped tests are not
  proof. Complete at least one real production error-parity probe, one real DB integration path,
  and one real-process durability fault path under e2e/testing-framework.
- Replay bundles, first-divergence diagnostics, validity-preserving bounded shrinking, scoped
  cleanup/leak assertions, and a runtime rejection of exactly-once external-effect assertions are
  required behavior, not roadmap-only types.
- Current review blockers must be closed, not restated: the executor must be an actual Effect
  service/layer program rather than a sequential Promise loop wrapped at the boundary; all seven
  ambiguity classes must arise from wired state transitions; adapters must prove and execute their
  real production identity; and e2e/testing-framework must contain real error-parity, durable DB
  CAS/lease, replay, and SIGKILL-mid-task/fresh-process-resume tests.

Inspect what already exists before choosing coherent vertical slices. No critical or major item may
be accepted as deferred. Roadmap items are allowed only after the implemented framework satisfies
the concrete proof obligations above.
`.trim();

const input = z.object({
  objective: z.string().trim().min(1).max(MAX_OBJECTIVE_CHARS).nullable().default(null),
  maxRounds: z.number().int().min(1).max(8).nullable().default(null),
  verificationProfile: z.enum(["focused", "ci", "full"]).nullable().default(null),
  focusedTestCommands: z.array(
    z.string().trim().min(1).max(MAX_FOCUSED_COMMAND_CHARS)
      .refine((command) => !command.includes("\n") && !command.includes("\0"), "commands must be single-line and NUL-free"),
  ).max(MAX_FOCUSED_COMMANDS).nullable().default(null),
  reusePlanRunId: z.string().trim().min(1).max(MAX_REUSED_RUN_ID_CHARS).nullable().default(null),
});

const text = z.string().default("");
const list = z.array(z.string()).default([]);
const issue = z.object({
  id: z.string(),
  severity: z.enum(["critical", "major", "minor"]),
  title: z.string(),
  evidence: z.string(),
  requiredChange: z.string(),
});
const check = z.object({
  kind: z.enum(["unit", "typecheck", "integration", "e2e", "focused"]),
  command: z.string(),
  exitCode: z.number(),
  durationMs: z.number(),
  timedOut: z.boolean(),
  passed: z.boolean(),
  stdoutTail: text,
  stderrTail: text,
});
const validation = z.object({
  objective: z.string(),
  effectiveMaxRounds: z.number(),
  verificationProfile: z.enum(["focused", "ci", "full"]),
  focusedTestCommands: list,
  baselineDiffDigest: z.string(),
  baselineChangedFiles: list,
  baselineGitHead: z.string(),
  snapshotPaths: list,
  reusedPlanRunId: z.string().nullable(),
  acceptanceContract: list,
  agentConfiguration: z.record(z.string(), z.string()),
  validationSummary: text,
});
const research = z.object({
  summary: text,
  currentFacts: list,
  currentPublicApi: list,
  currentInternalArchitecture: list,
  harnessesAndErrors: list,
  raceAndDurabilitySurfaces: list,
  realContractProbeOpportunities: list,
  relevantFiles: list,
  constraints: list,
  proposals: list,
  risks: list,
  validationGuidance: list,
  residualRisks: list,
});
const plan = z.object({
  summary: text,
  slices: z.array(z.object({
    id: z.string(),
    goal: z.string(),
    files: list,
    acceptance: list,
    proof: list,
  })).default([]),
  expectedFiles: list,
  publicApiContract: list,
  internalEffectKernel: list,
  architectureInvariants: list,
  harnessMatrix: list,
  durabilityMatrix: list,
  productionParityContracts: list,
  acceptanceCriteria: list,
  advisoryUnitCommands: list,
  advisoryIntegrationCommands: list,
  advisoryE2eCommands: list,
  deferredWork: list,
  residualRisks: list,
});
const implementation = z.object({
  summary: text,
  changedFiles: list,
  diffSummary: text,
  commandsRun: list,
  acceptanceCoverage: list,
  deferredWork: list,
  residualRisks: list,
});
const evidence = z.object({
  phase: z.string(),
  round: z.number(),
  iterationId: z.string(),
  capturedAt: z.string(),
  diffDigest: z.string(),
  beforeCheckDiffDigest: z.string(),
  snapshotPaths: list,
  changedFiles: list,
  newChangedFiles: list,
  statusSummary: text,
  baselineGitHead: z.string(),
  currentGitHead: z.string(),
  checks: z.array(check).default([]),
  checksMutatedTrackedFiles: z.boolean(),
  scopeViolations: list,
  allRequiredChecksPassed: z.boolean(),
  summary: text,
});
const review = z.object({
  reviewer: z.enum(["sol", "fable"]),
  iterationId: z.string(),
  reviewedDiffDigest: z.string(),
  lgtm: z.boolean(),
  summary: text,
  issues: z.array(issue).default([]),
  acceptanceChecked: list,
  requiredChecks: list,
  residualRisks: list,
});
const improvement = z.object({
  summary: text,
  sourceIterationId: text,
  addressedIssueIds: list,
  changedFiles: list,
  commandsRun: list,
  unresolvedIssues: list,
  residualRisks: list,
});
const snapshotVerification = z.object({
  iterationId: z.string(),
  expectedDiffDigest: z.string(),
  actualDiffDigest: z.string(),
  unchanged: z.boolean(),
  changedFiles: list,
  summary: text,
});
const consensus = z.object({
  summary: text,
  iterationId: text,
  diffDigest: text,
  round: z.number(),
  approved: z.boolean(),
  solCurrent: z.boolean(),
  fableCurrent: z.boolean(),
  checksPassed: z.boolean(),
  snapshotUnchanged: z.boolean(),
  artifactsComplete: z.boolean(),
  unionIssues: z.array(issue).default([]),
  failureReasons: list,
});
const readiness = z.object({
  summary: text,
  iterationId: text,
  diffDigest: text,
  round: z.number(),
  approved: z.boolean(),
  solCurrent: z.boolean(),
  checksPassed: z.boolean(),
  snapshotUnchanged: z.boolean(),
  artifactsComplete: z.boolean(),
  issues: z.array(issue).default([]),
  failureReasons: list,
});
const finalResult = z.object({
  status: z.literal("succeeded"),
  summary: text,
  changedFiles: list,
  checks: z.array(check).default([]),
  consensusRounds: z.number(),
  finalIterationId: text,
  finalDiffDigest: text,
  solApproval: z.boolean(),
  fableApproval: z.boolean(),
  residualRisks: list,
});

const {
  Workflow,
  Task,
  Sequence,
  Branch,
  Loop,
  Parallel,
  smithers,
  outputs,
} = createSmithers({
  input,
  validation,
  research,
  plan,
  implementation,
  evidence,
  review,
  improvement,
  snapshotVerification,
  consensus,
  readiness,
  finalResult,
});

const lunaResearch: AgentLike = new CodexAgent({
  model: "gpt-5.6-luna",
  config: { model_reasoning_effort: "medium" },
  yolo: false,
  sandbox: "read-only",
  skipGitRepoCheck: true,
});
const lunaImplementation: AgentLike = new CodexAgent({
  model: "gpt-5.6-luna",
  config: { model_reasoning_effort: "medium" },
  yolo: false,
  fullAuto: true,
  sandbox: "workspace-write",
  skipGitRepoCheck: true,
});
const sol: AgentLike = new CodexAgent({
  model: "gpt-5.6-sol",
  config: { model_reasoning_effort: "xhigh" },
  yolo: false,
  sandbox: "read-only",
  skipGitRepoCheck: true,
});
const fable: AgentLike = new ClaudeCodeAgent({
  model: "claude-fable-5",
  yolo: false,
  permissionMode: "plan",
  env: {
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
  },
});

type CheckKind = z.infer<typeof check>["kind"];
type CheckResult = z.infer<typeof check>;
type Validation = z.infer<typeof validation>;

function tail(value: string): string {
  return value.length <= OUTPUT_TAIL ? value : value.slice(-OUTPUT_TAIL);
}

function run(command: string, args: string[], maxBuffer = 256 * 1024 * 1024): string {
  return execFileSync(command, args, {
    cwd: ROOT,
    env: { ...globalThis.process.env },
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runJj(args: string[], maxBuffer = 256 * 1024 * 1024): string {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return run("jj", args, maxBuffer);
    } catch (error) {
      lastError = error;
      const details = `${String(error)}\n${String((error as { stderr?: unknown })?.stderr ?? "")}`;
      if (!/index\.lock|packed-refs\.lock|packed-ref file|Failed to import refs from underlying Git repo|Could not acquire lock|Failed to reset Git HEAD state/i.test(details)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(1_000, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

function gitHead(): string {
  return run("git", ["rev-parse", "HEAD"]).trim();
}

function snapshot(baselineGitHead: string) {
  const paths = ["--", ...SNAPSHOT_PATHS];
  // Hash the complete target tree rather than the working-copy diff. This identity is stable if
  // the exact same files are committed while checks are running, and jj's normal working-copy
  // snapshot includes both tracked and newly-created files in the selected paths.
  const fullContentDiff = runJj([
    "diff",
    "--from",
    "root()",
    "--to",
    "@",
    "--git",
    "--color=never",
    ...paths,
  ]);
  // Reviewer context remains relative to the HEAD captured by validation. Consequently a target
  // change committed after validation is still listed instead of disappearing from `jj diff -r @`.
  const summary = runJj([
    "diff",
    "--from",
    baselineGitHead,
    "--to",
    "@",
    "--summary",
    "--color=never",
    ...paths,
  ]);
  const changedFiles = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
    .sort();
  return {
    status: summary.trim()
      ? `Target-scoped changes since validation baseline ${baselineGitHead}:\n${summary.trim()}`
      : `No target-scoped changes since validation baseline ${baselineGitHead}.`,
    changedFiles,
    diffDigest: createHash("sha256").update(fullContentDiff).digest("hex"),
  };
}

function targetChangedBetweenHeads(baselineHead: string, currentHead: string): boolean {
  if (baselineHead === currentHead) return false;
  try {
    execFileSync("git", ["diff", "--quiet", baselineHead, currentHead, "--", ...SNAPSHOT_PATHS], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return false;
  } catch (error: any) {
    if (error?.status === 1) return true;
    throw error;
  }
}

function requireExecutable(name: string): void {
  try {
    run("sh", ["-lc", `command -v ${name}`], 1024 * 1024);
  } catch {
    throw new Error(`Required agent CLI is unavailable: ${name}`);
  }
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function loadPriorFablePlan(runId: string): z.infer<typeof plan> {
  const raw = run(process.execPath, [
    "apps/cli/src/index.js",
    "output",
    runId,
    "plan",
    "--iteration",
    "0",
    "--json",
  ]);
  const jsonLine = raw.split(/\r?\n/).reverse().find((line) => line.trim().startsWith("{"));
  if (!jsonLine) throw new Error(`Prior Fable plan ${runId} did not return a JSON output row.`);
  const row = JSON.parse(jsonLine) as Record<string, unknown>;
  const strings = (key: string) => parseJsonColumn<string[]>(row[key], []);
  const loaded = {
    summary: String(row.summary ?? ""),
    slices: parseJsonColumn<z.infer<typeof plan>["slices"]>(row.slices, []),
    expectedFiles: strings("expected_files"),
    publicApiContract: strings("public_api_contract"),
    internalEffectKernel: strings("internal_effect_kernel"),
    architectureInvariants: strings("architecture_invariants"),
    harnessMatrix: strings("harness_matrix"),
    durabilityMatrix: strings("durability_matrix"),
    productionParityContracts: strings("production_parity_contracts"),
    acceptanceCriteria: strings("acceptance_criteria"),
    advisoryUnitCommands: strings("advisory_unit_commands"),
    advisoryIntegrationCommands: strings("advisory_integration_commands"),
    advisoryE2eCommands: strings("advisory_e2e_commands"),
    deferredWork: strings("deferred_work"),
    residualRisks: strings("residual_risks"),
  };
  if (!loaded.summary || loaded.slices.length === 0 || loaded.acceptanceCriteria.length === 0) {
    throw new Error(`Prior Fable plan ${runId} is incomplete; refusing to substitute a synthetic plan.`);
  }
  return loaded;
}

async function runCheck(kind: CheckKind, command: string): Promise<CheckResult> {
  const startedAt = Date.now();
  let timedOut = false;
  try {
    const child = spawnChild("bash", ["-c", command], {
      cwd: ROOT,
      env: { ...globalThis.process.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let fatalWindow = "";
    const fatalSignatures = [
      /ELIFECYCLE\s+(?:Test|Command) failed\b/,
      /# Unhandled error between tests/,
      /\bBun has crashed\b/,
      /panic\(main thread\)/,
      /Trace\/BPT trap/,
    ];
    let fatalSignature: string | null = null;
    const append = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const value = String(chunk);
      if (stream === "stdout") stdout = tail(stdout + value);
      else stderr = tail(stderr + value);
      fatalWindow = (fatalWindow + value).slice(-32_000);
      fatalSignature ??= fatalSignatures.find((pattern) => pattern.test(fatalWindow))?.source ?? null;
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalProcessGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        globalThis.process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process may have exited between the close check and signal delivery.
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup("SIGTERM");
      killTimer = setTimeout(() => signalProcessGroup("SIGKILL"), CHECK_KILL_GRACE_MS);
    }, CHECK_TIMEOUT_MS);
    let code: number | null;
    let signal: NodeJS.Signals | null;
    try {
      ({ code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (closedCode, closedSignal) => resolve({ code: closedCode, signal: closedSignal }));
      }));
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    }
    const exitCode = code ?? (signal ? -1 : 0);
    const passed = exitCode === 0 && signal === null && !timedOut && fatalSignature === null;
    const evidenceNote = fatalSignature
      ? `\n[smithers evidence] rejected zero exit because output matched fatal signature: ${fatalSignature}`
      : signal
        ? `\n[smithers evidence] process terminated by ${signal}`
        : "";
    return {
      kind,
      command,
      exitCode,
      durationMs: Date.now() - startedAt,
      timedOut,
      passed,
      stdoutTail: stdout,
      stderrTail: tail(stderr + evidenceNote),
    };
  } catch (error) {
    return {
      kind,
      command,
      exitCode: -1,
      durationMs: Date.now() - startedAt,
      timedOut,
      passed: false,
      stdoutTail: "",
      stderrTail: error instanceof Error ? error.message : String(error),
    };
  }
}

function verificationCommands(
  profile: Validation["verificationProfile"],
  focused: string[],
): Array<{ kind: CheckKind; command: string }> {
  const commands: Array<{ kind: CheckKind; command: string }> = [
    { kind: "unit", command: "pnpm -C packages/testing test" },
    { kind: "typecheck", command: "pnpm -C packages/testing typecheck" },
  ];
  if (profile === "ci" || profile === "full") {
    commands.push(
      { kind: "typecheck", command: "pnpm typecheck" },
      { kind: "integration", command: "pnpm test" },
    );
  }
  if (profile === "full") {
    commands.push(
      { kind: "typecheck", command: "pnpm -C e2e typecheck" },
      { kind: "e2e", command: "bun test e2e/testing-framework" },
      { kind: "e2e", command: "pnpm -C e2e test:faults" },
      { kind: "e2e", command: "pnpm -C e2e test" },
    );
  }
  for (const command of focused) commands.push({ kind: "focused", command });
  return [...new Map(commands.map((entry) => [entry.command, entry])).values()];
}

function scopeViolations(
  current: ReturnType<typeof snapshot>,
  beforeCheckDiffDigest: string,
): string[] {
  const violations: string[] = [];
  if (beforeCheckDiffDigest !== current.diffDigest) {
    violations.push("verification commands changed target-scoped content; test evidence is not snapshot-stable");
  }
  return violations;
}

async function captureEvidence(args: {
  runId: string;
  phase: string;
  round: number;
  baseline: Validation;
}): Promise<z.infer<typeof evidence>> {
  const before = snapshot(args.baseline.baselineGitHead);
  const checks: CheckResult[] = [];
  for (const entry of verificationCommands(args.baseline.verificationProfile, args.baseline.focusedTestCommands)) {
    checks.push(await runCheck(entry.kind, entry.command));
  }
  const after = snapshot(args.baseline.baselineGitHead);
  const violations = scopeViolations(after, before.diffDigest);
  const baselineFiles = new Set(args.baseline.baselineChangedFiles);
  const newChangedFiles = after.changedFiles.filter((file) => !baselineFiles.has(file));
  const allRequiredChecksPassed = checks.length > 0 && checks.every((result) => result.passed) && violations.length === 0;
  const iterationId = `${args.runId}:${args.phase}:${args.round}:${after.diffDigest.slice(0, 16)}`;
  return {
    phase: args.phase,
    round: args.round,
    iterationId,
    capturedAt: new Date().toISOString(),
    diffDigest: after.diffDigest,
    beforeCheckDiffDigest: before.diffDigest,
    snapshotPaths: [...SNAPSHOT_PATHS],
    changedFiles: after.changedFiles,
    newChangedFiles,
    statusSummary: after.status,
    baselineGitHead: args.baseline.baselineGitHead,
    currentGitHead: gitHead(),
    checks,
    checksMutatedTrackedFiles: before.diffDigest !== after.diffDigest,
    scopeViolations: violations,
    allRequiredChecksPassed,
    summary: allRequiredChecksPassed
      ? `All ${checks.length} required checks passed for ${iterationId}.`
      : `Evidence rejected for ${iterationId}; inspect failed checks and scope violations.`,
  };
}

function issueUnion(...reviews: Array<z.infer<typeof review> | undefined>): z.infer<typeof issue>[] {
  const byId = new Map<string, z.infer<typeof issue>>();
  for (const finding of reviews.flatMap((entry) => entry?.issues ?? [])) {
    byId.set(finding.id, finding);
  }
  return [...byId.values()];
}

export default smithers((ctx) => {
  const objective = ctx.input.objective?.trim() || DEFAULT_OBJECTIVE;
  const maxRounds = Math.min(8, Math.max(1, ctx.input.maxRounds ?? 8));
  const verificationProfile = ctx.input.verificationProfile ?? "full";
  const focusedTestCommands = (ctx.input.focusedTestCommands ?? [])
    .map((command) => command.trim())
    .filter((command) => command.length > 0 && command.length <= 1_000 && !command.includes("\n") && !command.includes("\0"));
  const reusePlanRunId = ctx.input.reusePlanRunId?.trim() || null;
  if (reusePlanRunId && !/^run-[A-Za-z0-9._-]+$/.test(reusePlanRunId)) {
    throw new Error("reusePlanRunId must be a Smithers run id.");
  }

  const baseline = ctx.outputMaybe(outputs.validation, { nodeId: "validate-input-and-agents" });
  const research = ctx.outputMaybe(outputs.research, { nodeId: "research" });
  const acceptedPlan = ctx.outputMaybe(outputs.plan, { nodeId: "plan" });
  const initialEvidence = ctx.outputMaybe(outputs.evidence, { nodeId: "capture-initial-evidence" });
  const initialReview = ctx.outputMaybe(outputs.review, { nodeId: "initial-sol-review" });
  const initialReviewCurrent = Boolean(
    initialEvidence &&
    initialReview &&
    initialReview.reviewer === "sol" &&
    initialReview.iterationId === initialEvidence.iterationId &&
    initialReview.reviewedDiffDigest === initialEvidence.diffDigest,
  );
  const initialReviewHasBlockingIssues = Boolean(
    initialReview?.issues.some((finding) => finding.severity === "critical" || finding.severity === "major"),
  );
  const initialNeedsFix = Boolean(
    initialEvidence &&
    initialReview &&
    (!initialEvidence.allRequiredChecksPassed || !initialReview.lgtm || !initialReviewCurrent || initialReviewHasBlockingIssues),
  );

  const consensusEvidence = ctx.latest(outputs.evidence, "capture-consensus-iteration");
  const consensusSolReview = ctx.latest(outputs.review, "consensus-sol-review");
  const consensusFableReview = ctx.latest(outputs.review, "consensus-fable-review");
  const latestAssessment = ctx.latest(outputs.consensus, "assess-consensus");
  const consensusApproved = latestAssessment?.approved === true;
  const consensusNeedsImprovement = latestAssessment?.approved === false;
  const nextConsensusRound = (ctx.outputs.consensus?.length ?? 0) + 1;

  const readinessEvidence = ctx.latest(outputs.evidence, "capture-sol-readiness");
  const readinessSolReview = ctx.latest(outputs.review, "sol-readiness-review");
  const latestReadiness = ctx.latest(outputs.readiness, "assess-sol-readiness");
  const previousReadinessImprovement = ctx.latest(outputs.improvement, "sol-readiness-luna-improvement");
  const solReady = latestReadiness?.approved === true;
  const solNeedsImprovement = latestReadiness?.approved === false;
  const nextReadinessRound = (ctx.outputs.readiness?.length ?? 0) + 1;

  return (
    <Workflow name="implement-testing-framework-e2e">
      <Sequence>
        <Task id="validate-input-and-agents" output={outputs.validation} noRetry>
          {() => {
            requireExecutable("codex");
            requireExecutable("claude");
            const baselineGitHead = gitHead();
            const starting = snapshot(baselineGitHead);
            return {
              objective,
              effectiveMaxRounds: maxRounds,
              verificationProfile,
              focusedTestCommands,
              baselineDiffDigest: starting.diffDigest,
              baselineChangedFiles: starting.changedFiles,
              baselineGitHead,
              snapshotPaths: [...SNAPSHOT_PATHS],
              reusedPlanRunId: reusePlanRunId,
              acceptanceContract: DEFAULT_OBJECTIVE.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("-")),
              agentConfiguration: {
                research: "Codex Luna, medium, read-only",
                planning: reusePlanRunId
                  ? `Exact durable Claude Fable 5 plan reused from ${reusePlanRunId}`
                  : "Claude Fable 5 subscription, plan/read-only, API credentials cleared",
                implementation: "Codex Luna, medium, workspace-write",
                review: "Codex Sol, xhigh, read-only + Claude Fable 5, plan/read-only",
              },
              validationSummary: "Required CLIs found; baseline, scope, verification profile, and explicit no-fallback agents captured.",
            };
          }}
        </Task>

        <Task id="research" output={outputs.research} agent={lunaResearch} retries={AGENT_RETRIES} timeoutMs={LONG} heartbeatTimeoutMs={HEARTBEAT}>
          <ResearchPrompt objective={objective} contract={DEFAULT_OBJECTIVE} baseline={promptJson(baseline)} />
        </Task>

        <Branch
          if={Boolean(reusePlanRunId)}
          then={
            <Task id="plan" output={outputs.plan} noRetry>
              {() => loadPriorFablePlan(reusePlanRunId!)}
            </Task>
          }
          else={
            <Task id="plan" output={outputs.plan} agent={fable} retries={AGENT_RETRIES} timeoutMs={LONG} heartbeatTimeoutMs={HEARTBEAT}>
              <PlanPrompt objective={objective} contract={DEFAULT_OBJECTIVE} research={promptJson(research)} />
            </Task>
          }
        />

        <Task id="implement" output={outputs.implementation} agent={lunaImplementation} retries={AGENT_RETRIES} timeoutMs={LONG} heartbeatTimeoutMs={HEARTBEAT}>
          <ImplementPrompt
            objective={objective}
            contract={DEFAULT_OBJECTIVE}
            research={promptJson(research)}
            plan={promptJson(acceptedPlan)}
            baseline={promptJson(baseline)}
          />
        </Task>

        <Task id="capture-initial-evidence" output={outputs.evidence} noRetry>
          {async () => captureEvidence({ runId: ctx.runId, phase: "initial", round: 0, baseline: baseline! })}
        </Task>

        <Task id="initial-sol-review" output={outputs.review} agent={sol} retries={AGENT_RETRIES} timeoutMs={LONG} heartbeatTimeoutMs={HEARTBEAT}>
          <InitialSolReviewPrompt
            objective={objective}
            contract={DEFAULT_OBJECTIVE}
            evidence={promptJson(initialEvidence)}
            plan={promptJson(acceptedPlan)}
          />
        </Task>

        <Branch
          if={initialNeedsFix}
          then={
            <Sequence>
              <Task id="initial-luna-fix" output={outputs.improvement} agent={lunaImplementation} retries={AGENT_RETRIES} timeoutMs={LONG} heartbeatTimeoutMs={HEARTBEAT}>
                <InitialFixPrompt
                  objective={objective}
                  contract={DEFAULT_OBJECTIVE}
                  evidence={promptJson(initialEvidence)}
                  review={promptJson(initialReview)}
                  plan={promptJson(acceptedPlan)}
                />
              </Task>
            </Sequence>
          }
          else={null}
        />

        <Loop id="sol-readiness" maxIterations={maxRounds} until={solReady} onMaxReached="fail">
          <Sequence>
            <Task id="capture-sol-readiness" output={outputs.evidence} noRetry>
              {async () => captureEvidence({ runId: ctx.runId, phase: "sol-readiness", round: nextReadinessRound, baseline: baseline! })}
            </Task>

            <Task id="sol-readiness-review" output={outputs.review} agent={sol} retries={AGENT_RETRIES} timeoutMs={LONG} heartbeatTimeoutMs={HEARTBEAT}>
              <ConsensusSolReviewPrompt
                objective={objective}
                contract={DEFAULT_OBJECTIVE}
                evidence={promptJson(readinessEvidence)}
                plan={promptJson(acceptedPlan)}
              />
            </Task>

            <Task id="verify-sol-readiness-snapshot" output={outputs.snapshotVerification} noRetry>
              {() => {
                const expected = ctx.latest(outputs.evidence, "capture-sol-readiness");
                if (!expected) throw new Error("Sol readiness snapshot verification requires captured evidence.");
                const current = snapshot(expected.baselineGitHead);
                const currentGitHead = gitHead();
                const unchanged = Boolean(
                  expected.diffDigest === current.diffDigest &&
                  !targetChangedBetweenHeads(expected.currentGitHead, currentGitHead),
                );
                return {
                  iterationId: expected.iterationId,
                  expectedDiffDigest: expected.diffDigest,
                  actualDiffDigest: current.diffDigest,
                  unchanged,
                  changedFiles: current.changedFiles,
                  summary: unchanged
                    ? "The working-copy snapshot stayed unchanged during the Sol readiness review."
                    : "The working copy changed during the Sol readiness review; its findings are stale.",
                };
              }}
            </Task>

            <Task id="assess-sol-readiness" output={outputs.readiness} noRetry>
              {() => {
                const currentEvidence = ctx.latest(outputs.evidence, "capture-sol-readiness");
                const currentSol = ctx.latest(outputs.review, "sol-readiness-review");
                const currentSnapshot = ctx.latest(outputs.snapshotVerification, "verify-sol-readiness-snapshot");
                const reasons: string[] = [];
                const solCurrent = Boolean(
                  currentEvidence &&
                  currentSol?.reviewer === "sol" &&
                  currentSol.iterationId === currentEvidence.iterationId &&
                  currentSol.reviewedDiffDigest === currentEvidence.diffDigest,
                );
                const checksPassed = currentEvidence?.allRequiredChecksPassed === true;
                const snapshotUnchanged = Boolean(
                  currentEvidence &&
                  currentSnapshot?.unchanged &&
                  currentSnapshot.iterationId === currentEvidence.iterationId &&
                  currentSnapshot.actualDiffDigest === currentEvidence.diffDigest,
                );
                const artifactsComplete = Boolean(currentEvidence && currentSol && currentSnapshot && currentEvidence.checks.length > 0);
                const hasBlockingIssues = Boolean(currentSol?.issues.some((finding) => finding.severity === "critical" || finding.severity === "major"));
                if (!checksPassed) reasons.push("deterministic verification checks or scope checks failed");
                if (!solCurrent) reasons.push("Sol review does not identify the current iteration and diff digest");
                if (!currentSol?.lgtm) reasons.push("Sol requested changes");
                if (hasBlockingIssues) reasons.push("Sol reported critical or major issues");
                if (!snapshotUnchanged) reasons.push("the working-copy diff changed during review");
                if (!artifactsComplete) reasons.push("required readiness evidence or review artifacts are missing");
                const approved = reasons.length === 0;
                return {
                  summary: approved
                    ? "Sol approved an unchanged snapshot with every deterministic gate green; proceed to scarce dual review."
                    : "Sol readiness rejected; Luna must repair the current findings before Fable is invoked.",
                  iterationId: currentEvidence?.iterationId ?? "",
                  diffDigest: currentEvidence?.diffDigest ?? "",
                  round: currentEvidence?.round ?? nextReadinessRound,
                  approved,
                  solCurrent,
                  checksPassed,
                  snapshotUnchanged,
                  artifactsComplete,
                  issues: currentSol?.issues ?? [],
                  failureReasons: reasons,
                };
              }}
            </Task>

            <Branch
              if={solNeedsImprovement && nextReadinessRound <= maxRounds}
              then={
                <Task id="sol-readiness-luna-improvement" output={outputs.improvement} agent={lunaImplementation} retries={AGENT_RETRIES} timeoutMs={LONG} heartbeatTimeoutMs={HEARTBEAT}>
                  <ConsensusImprovementPrompt
                    objective={objective}
                    contract={DEFAULT_OBJECTIVE}
                    evidence={promptJson(readinessEvidence)}
                    solReview={promptJson(readinessSolReview)}
                    fableReview={promptJson(null)}
                    consensus={promptJson(latestReadiness)}
                    previousImprovement={promptJson(previousReadinessImprovement)}
                    plan={promptJson(acceptedPlan)}
                  />
                </Task>
              }
              else={null}
            />
          </Sequence>
        </Loop>

        <Loop id="final-consensus" maxIterations={maxRounds} until={consensusApproved} onMaxReached="fail">
          <Sequence>
            <Task id="capture-consensus-iteration" output={outputs.evidence} noRetry>
              {async () => captureEvidence({ runId: ctx.runId, phase: "consensus", round: nextConsensusRound, baseline: baseline! })}
            </Task>

            <Parallel maxConcurrency={2}>
              <Task id="consensus-sol-review" output={outputs.review} agent={sol} retries={AGENT_RETRIES} timeoutMs={LONG} heartbeatTimeoutMs={HEARTBEAT}>
                <ConsensusSolReviewPrompt
                  objective={objective}
                  contract={DEFAULT_OBJECTIVE}
                  evidence={promptJson(consensusEvidence)}
                  plan={promptJson(acceptedPlan)}
                />
              </Task>
              <Task id="consensus-fable-review" output={outputs.review} agent={fable} retries={AGENT_RETRIES} timeoutMs={LONG} heartbeatTimeoutMs={HEARTBEAT}>
                <ConsensusFableReviewPrompt
                  objective={objective}
                  contract={DEFAULT_OBJECTIVE}
                  evidence={promptJson(consensusEvidence)}
                  plan={promptJson(acceptedPlan)}
                />
              </Task>
            </Parallel>

            <Task id="verify-review-snapshot" output={outputs.snapshotVerification} noRetry>
              {() => {
                const expected = ctx.latest(outputs.evidence, "capture-consensus-iteration");
                if (!expected) throw new Error("Consensus snapshot verification requires captured evidence.");
                const current = snapshot(expected.baselineGitHead);
                const currentGitHead = gitHead();
                const unchanged = Boolean(
                  expected.diffDigest === current.diffDigest &&
                  !targetChangedBetweenHeads(expected.currentGitHead, currentGitHead),
                );
                return {
                  iterationId: expected.iterationId,
                  expectedDiffDigest: expected.diffDigest,
                  actualDiffDigest: current.diffDigest,
                  unchanged,
                  changedFiles: current.changedFiles,
                  summary: unchanged
                    ? "The working-copy snapshot stayed unchanged while both reviewers inspected it."
                    : "The working copy changed during review; previous approvals are stale.",
                };
              }}
            </Task>

            <Task id="assess-consensus" output={outputs.consensus} noRetry>
              {() => {
                const currentEvidence = ctx.latest(outputs.evidence, "capture-consensus-iteration");
                const currentSol = ctx.latest(outputs.review, "consensus-sol-review");
                const currentFable = ctx.latest(outputs.review, "consensus-fable-review");
                const currentSnapshot = ctx.latest(outputs.snapshotVerification, "verify-review-snapshot");
                const reasons: string[] = [];
                const solCurrent = Boolean(
                  currentEvidence &&
                  currentSol?.reviewer === "sol" &&
                  currentSol.iterationId === currentEvidence.iterationId &&
                  currentSol.reviewedDiffDigest === currentEvidence.diffDigest,
                );
                const fableCurrent = Boolean(
                  currentEvidence &&
                  currentFable?.reviewer === "fable" &&
                  currentFable.iterationId === currentEvidence.iterationId &&
                  currentFable.reviewedDiffDigest === currentEvidence.diffDigest,
                );
                const checksPassed = currentEvidence?.allRequiredChecksPassed === true;
                const snapshotUnchanged = Boolean(
                  currentEvidence &&
                  currentSnapshot?.unchanged &&
                  currentSnapshot.iterationId === currentEvidence.iterationId &&
                  currentSnapshot.actualDiffDigest === currentEvidence.diffDigest,
                );
                const artifactsComplete = Boolean(currentEvidence && currentSol && currentFable && currentSnapshot && currentEvidence.checks.length > 0);
                const solHasBlockingIssues = Boolean(currentSol?.issues.some((finding) => finding.severity === "critical" || finding.severity === "major"));
                const fableHasBlockingIssues = Boolean(currentFable?.issues.some((finding) => finding.severity === "critical" || finding.severity === "major"));
                if (!checksPassed) reasons.push("deterministic verification checks or scope checks failed");
                if (!solCurrent) reasons.push("Sol review does not identify the current iteration and diff digest");
                if (!fableCurrent) reasons.push("Fable review does not identify the current iteration and diff digest");
                if (!currentSol?.lgtm) reasons.push("Sol requested changes");
                if (!currentFable?.lgtm) reasons.push("Fable requested changes");
                if (solHasBlockingIssues) reasons.push("Sol reported critical or major issues");
                if (fableHasBlockingIssues) reasons.push("Fable reported critical or major issues");
                if (!snapshotUnchanged) reasons.push("the working-copy diff changed during review");
                if (!artifactsComplete) reasons.push("required evidence or review artifacts are missing");
                const approved = reasons.length === 0;
                return {
                  summary: approved
                    ? "Sol and Fable independently approved the same unchanged, fully tested diff."
                    : "Consensus rejected; Luna must address the union of current findings before a fresh review.",
                  iterationId: currentEvidence?.iterationId ?? "",
                  diffDigest: currentEvidence?.diffDigest ?? "",
                  round: currentEvidence?.round ?? nextConsensusRound,
                  approved,
                  solCurrent,
                  fableCurrent,
                  checksPassed,
                  snapshotUnchanged,
                  artifactsComplete,
                  unionIssues: issueUnion(currentSol, currentFable),
                  failureReasons: reasons,
                };
              }}
            </Task>

            <Branch
              if={consensusNeedsImprovement && nextConsensusRound <= maxRounds}
              then={
                <Sequence>
                  <Task id="consensus-luna-improvement" output={outputs.improvement} agent={lunaImplementation} retries={AGENT_RETRIES} timeoutMs={LONG} heartbeatTimeoutMs={HEARTBEAT}>
                    <ConsensusImprovementPrompt
                      objective={objective}
                      contract={DEFAULT_OBJECTIVE}
                      evidence={promptJson(consensusEvidence)}
                      solReview={promptJson(consensusSolReview)}
                      fableReview={promptJson(consensusFableReview)}
                      consensus={promptJson(latestAssessment)}
                      previousImprovement={promptJson(ctx.latest(outputs.improvement, "consensus-luna-improvement"))}
                      plan={promptJson(acceptedPlan)}
                    />
                  </Task>
                </Sequence>
              }
              else={null}
            />
          </Sequence>
        </Loop>

        <Task id="final-verify-and-summarize" output={outputs.finalResult} noRetry>
          {() => {
            const assessment = ctx.latest(outputs.consensus, "assess-consensus");
            const finalEvidence = ctx.latest(outputs.evidence, "capture-consensus-iteration");
            if (
              !assessment?.approved ||
              !assessment.solCurrent ||
              !assessment.fableCurrent ||
              !assessment.checksPassed ||
              !assessment.snapshotUnchanged ||
              !assessment.artifactsComplete ||
              !finalEvidence
            ) {
              throw new Error("Finalization attempted without deterministic dual-review consensus.");
            }
            if (assessment.iterationId !== finalEvidence.iterationId || assessment.diffDigest !== finalEvidence.diffDigest) {
              throw new Error("Final consensus assessment does not match the latest evidence iteration and diff digest.");
            }
            const finalSnapshot = snapshot(finalEvidence.baselineGitHead);
            if (assessment.diffDigest !== finalSnapshot.diffDigest || finalEvidence.diffDigest !== finalSnapshot.diffDigest) {
              throw new Error("The working-copy diff changed after consensus; final approval is stale.");
            }
            const currentGitHead = gitHead();
            if (targetChangedBetweenHeads(finalEvidence.currentGitHead, currentGitHead)) {
              throw new Error("Target-scoped committed files changed after consensus; final approval is stale.");
            }
            return {
              status: "succeeded" as const,
              summary: "Implementation passed deterministic checks and fresh same-diff review from Codex Sol and Claude Fable.",
              changedFiles: finalSnapshot.changedFiles,
              checks: finalEvidence.checks,
              consensusRounds: ctx.outputs.consensus?.length ?? 0,
              finalIterationId: finalEvidence.iterationId,
              finalDiffDigest: finalEvidence.diffDigest,
              solApproval: assessment.solCurrent,
              fableApproval: assessment.fableCurrent,
              residualRisks: [
                ...(consensusSolReview?.residualRisks ?? []),
                ...(consensusFableReview?.residualRisks ?? []),
              ],
            };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
