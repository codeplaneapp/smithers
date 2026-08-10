import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTEXT = join(ROOT, ".context", "orchbench");
const RESULTS = join(CONTEXT, "results");
const VALIDATED = join(CONTEXT, "validated");
const INVALIDATED = join(CONTEXT, "invalidated");
const SAMPLE = join(ROOT, "benchmarks", "orchbench", "persuasion-gap-sample.json");
const SELECTED = join(ROOT, "benchmarks", "orchbench", "persuasion-gap-selected.json");

type Sample = {
  study: string;
  datasetRevision: string;
  pilotExcluded: string[];
  targetTasks: number;
  targetPerLanguage: number;
  minimumPerLanguage: number;
  overflowLanguageOrder: string[];
  tasksPerLanguage: number;
  candidates: Record<string, string[]>;
};

type Result = {
  runId: string;
  slug: string;
  pattern: string;
  status: string;
  reward: number;
  implementationReward: number | null;
  reviewDelta: number | null;
  quotaPoisoned: boolean;
  tainted: boolean | null;
  costUsd: number;
  wallS: number;
  modelWallS?: number;
  collectedAt: string;
  smoke?: boolean;
  balancedOrder?: boolean;
  stages?: Record<string, { durS: number; attempts: number; terminal?: string }>;
  rewardMeta?: Record<string, unknown>;
  implementationRewardMeta?: Record<string, unknown> | null;
  stageExecution?: Record<string, { models: string[]; agents: string[] }>;
  auditError?: string | null;
  resultSchemaVersion?: number;
  workflowHash?: string | null;
  protocolHash?: string | null;
  taskOrdinal?: number | null;
  plannedPatternOrder?: string[] | null;
  patternPosition?: number | null;
  launchStartedAt?: string | null;
  validationReceiptSha256?: string | null;
  selectedSampleSha256?: string | null;
  timingClean?: boolean;
};

const conditions = [
  "solo-sol",
  "sol-sol-sol",
  "sol-terra-sol",
  "plan-impl-review",
  "plan-impl-review-blind",
  "sol-work-sol-review",
  "sol-work-fable-review",
  "solo-fable",
  "fable-fable-fable",
  "fable-plan-impl-review",
  "fable-plan-impl-review-blind",
] as const;
type Condition = (typeof conditions)[number];
type PipelineCondition =
  | "sol-sol-sol"
  | "sol-terra-sol"
  | "plan-impl-review"
  | "plan-impl-review-blind"
  | "sol-work-sol-review"
  | "sol-work-fable-review"
  | "fable-fable-fable"
  | "fable-plan-impl-review"
  | "fable-plan-impl-review-blind";

const pipelineConditions = new Set<Condition>([
  "sol-sol-sol",
  "sol-terra-sol",
  "plan-impl-review",
  "plan-impl-review-blind",
  "sol-work-sol-review",
  "sol-work-fable-review",
  "fable-fable-fable",
  "fable-plan-impl-review",
  "fable-plan-impl-review-blind",
]);

const finiteReward = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const finiteDifference = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;

const expectedModels: Record<Condition, Record<string, string>> = {
  "solo-sol": { solo: "gpt-5.6-sol" },
  "sol-sol-sol": { plan: "gpt-5.6-sol", implement: "gpt-5.6-sol", review: "gpt-5.6-sol" },
  "sol-terra-sol": { plan: "gpt-5.6-sol", implement: "gpt-5.6-terra", review: "gpt-5.6-sol" },
  "plan-impl-review": { plan: "gpt-5.6-sol", implement: "gpt-5.6-luna", review: "gpt-5.6-sol" },
  "plan-impl-review-blind": { plan: "gpt-5.6-sol", implement: "gpt-5.6-luna", review: "gpt-5.6-sol" },
  "sol-work-sol-review": { work: "gpt-5.6-sol", review: "gpt-5.6-sol" },
  "sol-work-fable-review": { work: "gpt-5.6-sol", review: "claude-fable-5" },
  "solo-fable": { solo: "claude-fable-5" },
  "fable-fable-fable": { plan: "claude-fable-5", implement: "claude-fable-5", review: "claude-fable-5" },
  "fable-plan-impl-review": { plan: "claude-fable-5", implement: "gpt-5.6-luna", review: "claude-fable-5" },
  "fable-plan-impl-review-blind": { plan: "claude-fable-5", implement: "gpt-5.6-luna", review: "claude-fable-5" },
};

const integrityError = (result: Result, pattern: Condition): string | null => {
  if (result.resultSchemaVersion !== 2) return "unexpected result schema";
  if (result.auditError !== null) return "audit did not complete cleanly";
  if (!result.workflowHash || !result.protocolHash || !result.validationReceiptSha256 || !result.selectedSampleSha256) {
    return "missing protocol hashes";
  }
  if (!finiteReward(result.reward)) return "invalid final reward";
  if (!finiteReward(result.rewardMeta?.reward) || Math.abs(result.rewardMeta.reward - result.reward) > 1e-12) {
    return "missing or mismatched final reward metadata";
  }
  if (pipelineConditions.has(pattern)) {
    if (!finiteReward(result.implementationReward)) return "invalid implementation checkpoint reward";
    if (
      !finiteReward(result.implementationRewardMeta?.reward) ||
      Math.abs(result.implementationRewardMeta.reward - result.implementationReward) > 1e-12
    ) {
      return "missing or mismatched checkpoint reward metadata";
    }
    if (!finiteDifference(result.reviewDelta) || Math.abs(result.reviewDelta - (result.reward - result.implementationReward)) > 1e-12) {
      return "missing or inconsistent review delta";
    }
  }
  const expected = pattern.startsWith("solo-")
    ? ["solo"]
    : pattern.startsWith("sol-work-")
      ? ["work", "implementation-score", "review"]
      : ["plan", "implement", "implementation-score", "review"];
  const malformed = expected.filter(
    (stage) =>
      !result.stages?.[stage] ||
      result.stages[stage].attempts !== 1 ||
      (result.stages[stage] as { terminal?: string }).terminal !== "NodeFinished",
  );
  if (malformed.length > 0) return `missing or repeated stages: ${malformed.join(", ")}`;
  const unexpected = Object.keys(result.stages ?? {}).filter((stage) => !expected.includes(stage));
  if (unexpected.length > 0) return `unexpected stages: ${unexpected.join(", ")}`;
  const agentIds: string[] = [];
  for (const [stage, expectedModel] of Object.entries(expectedModels[pattern])) {
    const execution = result.stageExecution?.[stage];
    if (!execution || execution.models.length !== 1 || execution.models[0] !== expectedModel) {
      return `unexpected model identity for ${stage}`;
    }
    if (execution.agents.length !== 1 || execution.agents[0] === "unknown") {
      return `missing or ambiguous agent identity for ${stage}`;
    }
    agentIds.push(execution.agents[0]);
  }
  if (new Set(agentIds).size !== agentIds.length) return "agent instance was reused across stages";
  return null;
};

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const runPrefix = arg("--run-prefix", "orchb-pg");
const allowIncomplete = args.includes("--allow-incomplete");
const outJson = resolve(arg("--json", join(RESULTS, "persuasion-gap-analysis.json")));
const outMarkdown = resolve(arg("--markdown", join(RESULTS, "persuasion-gap-analysis.md")));

const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as Sample;
let selection: Record<string, string[]> = {};
let selectedSampleHash: string | null = null;
const projectBySlug = new Map<string, string>();
const unfilled: Record<string, number> = {};
for (const [language, candidates] of Object.entries(sample.candidates)) {
  selection[language] = [];
  for (const slug of candidates) {
    if (existsSync(join(VALIDATED, slug))) {
      selection[language].push(slug);
      if (selection[language].length === sample.tasksPerLanguage) break;
    } else if (!existsSync(join(INVALIDATED, slug))) {
      // A later passing marker cannot leapfrog an unresolved earlier rank.
      // Stop until this candidate receives a terminal fairness decision.
      break;
    }
  }
  unfilled[language] = sample.tasksPerLanguage - selection[language].length;
}
if (runPrefix === "orchb-pg-confirm-") {
  if (!existsSync(SELECTED)) throw new Error("confirmatory analysis requires the frozen selected-sample artifact");
  const frozen = JSON.parse(readFileSync(SELECTED, "utf8")) as {
    schemaVersion: number;
    datasetRevision: string;
    targetTasks: number;
    targetPerLanguage: number;
    minimumPerLanguage: number;
    overflowLanguageOrder: string[];
    conditionOrder: string[];
    languageSelection: Record<string, { finalCount: number }>;
    decisions: Array<{
      language: string;
      slug: string;
      candidateRank: number;
      status: "pass" | "invalid";
      decisionReceiptSha256: string;
    }>;
    tasks: Array<{ ordinal: number; language: string; slug: string; project: string; candidateRank: number; validationReceiptSha256: string }>;
  };
  if (frozen.schemaVersion !== 1 || JSON.stringify(frozen.conditionOrder) !== JSON.stringify(conditions)) {
    throw new Error("frozen sample has an incompatible schema or condition order");
  }
  if (frozen.tasks.length !== 30 || frozen.tasks.some((task, index) => task.ordinal !== index)) {
    throw new Error("frozen sample does not contain canonical ordinals for 30 tasks");
  }
  if (
    frozen.datasetRevision !== sample.datasetRevision ||
    frozen.targetTasks !== sample.targetTasks ||
    frozen.targetPerLanguage !== sample.targetPerLanguage ||
    frozen.minimumPerLanguage !== sample.minimumPerLanguage ||
    JSON.stringify(frozen.overflowLanguageOrder) !== JSON.stringify(sample.overflowLanguageOrder)
  ) throw new Error("frozen sampling metadata differs from the preregistered frame");
  const frozenSlugs = frozen.tasks.map((task) => task.slug);
  if (new Set(frozenSlugs).size !== 30 || frozenSlugs.some((slug) => sample.pilotExcluded.includes(slug))) {
    throw new Error("frozen sample contains duplicate or pilot tasks");
  }
  const languageCounts = Object.fromEntries(Object.keys(sample.candidates).map((language) => [language, 0]));
  for (const task of frozen.tasks) {
    if (!(task.language in languageCounts) || sample.candidates[task.language]?.[task.candidateRank - 1] !== task.slug) {
      throw new Error(`frozen candidate membership/rank mismatch: ${task.slug}`);
    }
    languageCounts[task.language] += 1;
    const receipt = join(VALIDATED, task.slug);
    if (!existsSync(receipt)) throw new Error(`missing frozen validation receipt: ${task.slug}`);
    const hash = createHash("sha256").update(readFileSync(receipt)).digest("hex");
    if (hash !== task.validationReceiptSha256) throw new Error(`validation receipt changed: ${task.slug}`);
  }
  if (Object.values(languageCounts).some((count) => count < sample.minimumPerLanguage)) {
    throw new Error("frozen sample violates the language floor");
  }
  if (
    JSON.stringify(Object.keys(frozen.languageSelection).toSorted()) !==
      JSON.stringify(Object.keys(languageCounts).toSorted()) ||
    Object.entries(languageCounts).some(([language, count]) => frozen.languageSelection[language]?.finalCount !== count)
  ) throw new Error("frozen language-selection summary mismatch");
  const decisionKeys = new Set<string>();
  const passingDecisions = new Set<string>();
  for (const decision of frozen.decisions) {
    const candidates = sample.candidates[decision.language];
    if (!candidates || candidates[decision.candidateRank - 1] !== decision.slug) {
      throw new Error(`frozen decision membership/rank mismatch: ${decision.slug}`);
    }
    const key = `${decision.language}:${decision.candidateRank}`;
    if (decisionKeys.has(key)) throw new Error(`duplicate frozen decision: ${key}`);
    decisionKeys.add(key);
    const receipt = join(decision.status === "pass" ? VALIDATED : INVALIDATED, decision.slug);
    if (!existsSync(receipt)) throw new Error(`missing frozen decision receipt: ${decision.slug}`);
    const hash = createHash("sha256").update(readFileSync(receipt)).digest("hex");
    if (hash !== decision.decisionReceiptSha256) throw new Error(`decision receipt changed: ${decision.slug}`);
    if (decision.status === "pass") passingDecisions.add(decision.slug);
  }
  if (frozenSlugs.some((slug) => !passingDecisions.has(slug))) {
    throw new Error("selected task is absent from the frozen passing-decision ledger");
  }
  selectedSampleHash = createHash("sha256").update(readFileSync(SELECTED)).digest("hex");
  selection = {};
  for (const task of frozen.tasks) {
    (selection[task.language] ??= []).push(task.slug);
    projectBySlug.set(task.slug, task.project);
  }
  for (const language of Object.keys(unfilled)) unfilled[language] = 0;
}
const tasks = Object.values(selection).flat();
const validation = Object.fromEntries(
  Object.entries(sample.candidates).flatMap(([language, candidates]) =>
    candidates.map((slug, index) => {
      const validPath = join(VALIDATED, slug);
      const invalidPath = join(INVALIDATED, slug);
      const status = existsSync(validPath) ? "validated" : existsSync(invalidPath) ? "invalidated" : "pending";
      const detail =
        status === "pending" ? null : readFileSync(status === "validated" ? validPath : invalidPath, "utf8").trim();
      return [slug, { language, rank: index + 1, status, detail }];
    }),
  ),
);

const allResults: Result[] = readdirSync(RESULTS)
  .filter((name) => name.endsWith(".json") && !name.startsWith("persuasion-gap-analysis"))
  .flatMap((name) => {
    try {
      return [JSON.parse(readFileSync(join(RESULTS, name), "utf8")) as Result];
    } catch {
      return [];
    }
  });
if (selectedSampleHash) {
  for (const result of allResults.filter((result) => result.runId.startsWith(runPrefix) && !result.smoke)) {
    if (result.selectedSampleSha256 !== selectedSampleHash) throw new Error(`selected-sample hash mismatch: ${result.runId}`);
  }
}

const resultFor = (slug: string, pattern: Condition): Result | undefined => {
  const attempts = allResults.filter(
    (result) => result.slug === slug && result.pattern === pattern && result.runId.startsWith(runPrefix),
  );
  if (attempts.some((result) => result.smoke !== false)) {
    throw new Error(`smoke or legacy-unmarked result matched confirmatory prefix for ${slug}/${pattern}`);
  }
  if (attempts.some((result) => result.balancedOrder !== true)) {
    throw new Error(`unbalanced result matched confirmatory prefix for ${slug}/${pattern}`);
  }
  for (const result of attempts) {
    if (result.status !== "RunFinished" || result.quotaPoisoned !== false || result.tainted !== false) continue;
    const error = integrityError(result, pattern);
    if (error) throw new Error(`${error} for ${slug}/${pattern} (${result.runId})`);
  }
  if (attempts.length > 2) throw new Error(`more than one prespecified retry for ${slug}/${pattern}`);
  const expectedBase = `${runPrefix}${pattern}-${slug}`;
  const allowedIds = new Set([expectedBase, `${expectedBase}-retry1`]);
  if (attempts.some((result) => !allowedIds.has(result.runId))) {
    throw new Error(`noncanonical run id for ${slug}/${pattern}`);
  }
  const base = attempts.find((result) => result.runId === expectedBase);
  if (attempts.some((result) => result.runId.endsWith("-retry1")) && !base) {
    throw new Error(`retry exists without retained base attempt for ${slug}/${pattern}`);
  }
  if (
    base?.status === "RunFinished" &&
    base.quotaPoisoned === false &&
    base.tainted === false &&
    base.auditError === null &&
    attempts.some((result) => result.runId.endsWith("-retry1"))
  ) {
    throw new Error(`retry exists after a clean base attempt for ${slug}/${pattern}`);
  }
  const taskOrdinal = tasks.indexOf(slug);
  const plannedOrder = conditions.map((_, index) => conditions[(index + taskOrdinal) % conditions.length]!);
  for (const result of attempts) {
    if (
      result.taskOrdinal !== taskOrdinal ||
      result.patternPosition !== plannedOrder.indexOf(pattern) ||
      JSON.stringify(result.plannedPatternOrder) !== JSON.stringify(plannedOrder) ||
      !result.launchStartedAt ||
      !Number.isFinite(Date.parse(result.launchStartedAt))
    ) {
      throw new Error(`unverifiable balanced order for ${slug}/${pattern} (${result.runId})`);
    }
  }
  const clean = attempts.filter(
    (result) => result.status === "RunFinished" && result.quotaPoisoned === false && result.tainted === false,
  );
  if (clean.length > 1) throw new Error(`multiple clean attempts for ${slug}/${pattern}`);
  return clean[0];
};

if (allResults.some((result) => result.runId.startsWith(runPrefix)) && Object.values(unfilled).some((n) => n > 0)) {
  throw new Error("confirmatory results exist before the frozen 30-task fairness sample is complete");
}

const rows = tasks.map((slug) => ({
  slug,
  language: Object.entries(selection).find(([, slugs]) => slugs.includes(slug))?.[0] ?? "unknown",
  results: Object.fromEntries(conditions.map((condition) => [condition, resultFor(slug, condition)])) as Record<
    Condition,
    Result | undefined
  >,
}));

const missingCells = rows.flatMap((row) =>
  conditions.filter((condition) => !row.results[condition]).map((condition) => `${row.slug}/${condition}`),
);
if (!allowIncomplete && allResults.some((result) => result.runId.startsWith(runPrefix)) && missingCells.length > 0) {
  throw new Error(`confirmatory analysis is incomplete: ${missingCells.length}/330 clean cells are missing`);
}

const cleanResults = rows.flatMap((row) => Object.values(row.results).filter((result): result is Result => !!result));
for (const field of ["workflowHash", "protocolHash"] as const) {
  const values = new Set(cleanResults.map((result) => result[field]));
  if (values.size > 1) throw new Error(`confirmatory cells have multiple ${field} values`);
}
for (const [taskOrdinal, slug] of tasks.entries()) {
  const plannedOrder = conditions.map((_, index) => conditions[(index + taskOrdinal) % conditions.length]!);
  const baseAttempts = allResults.filter((result) =>
    plannedOrder.some((pattern) => result.runId === `${runPrefix}${pattern}-${slug}`),
  );
  if (baseAttempts.length !== conditions.length) {
    throw new Error(`missing retained base attempt(s) for ${slug}: ${baseAttempts.length}/${conditions.length}`);
  }
  const actualOrder = baseAttempts
    .toSorted((left, right) => Date.parse(left.launchStartedAt ?? "") - Date.parse(right.launchStartedAt ?? ""))
    .map((result) => result.pattern);
  if (JSON.stringify(actualOrder) !== JSON.stringify(plannedOrder)) {
    throw new Error(`actual first-attempt launch order differs from plan for ${slug}`);
  }
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

let randomState = 0x70657273;
const random = () => {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 0x1_0000_0000;
};

const inference = (values: number[]) => {
  if (values.length === 0) return null;
  randomState = 0x70657273;
  const observed = mean(values);
  const boot = Array.from({ length: 20_000 }, () =>
    mean(Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]!)),
  ).sort((a, b) => a - b);
  let extreme = 0;
  const permutations = 200_000;
  for (let iteration = 0; iteration < permutations; iteration += 1) {
    const permuted = mean(values.map((value) => (random() < 0.5 ? value : -value)));
    if (Math.abs(permuted) >= Math.abs(observed) - 1e-12) extreme += 1;
  }
  const wins = values.filter((value) => value > 1e-12).length;
  const losses = values.filter((value) => value < -1e-12).length;
  return {
    n: values.length,
    mean: observed,
    ci95: [boot[Math.floor((boot.length - 1) * 0.025)]!, boot[Math.floor((boot.length - 1) * 0.975)]!],
    permutationP: (extreme + 1) / (permutations + 1),
    wins,
    ties: values.length - wins - losses,
    losses,
  };
};

const holmAdjust = (tests: Record<string, ReturnType<typeof inference>>) => {
  const ranked = Object.entries(tests)
    .filter((entry): entry is [string, NonNullable<ReturnType<typeof inference>>] => entry[1] !== null)
    .sort((a, b) => a[1].permutationP - b[1].permutationP);
  let previous = 0;
  return Object.fromEntries(
    ranked.map(([name, result], index) => {
      const adjusted = Math.min(1, Math.max(previous, result.permutationP * (ranked.length - index)));
      previous = adjusted;
      return [name, adjusted];
    }),
  );
};

const projectOf = (slug: string) => projectBySlug.get(slug) ?? slug.split("-")[0]!;
const clusteredInference = (values: { project: string; value: number }[]) => {
  if (values.length === 0) return null;
  const grouped = new Map<string, number[]>();
  for (const { project, value } of values) grouped.set(project, [...(grouped.get(project) ?? []), value]);
  const groups = [...grouped.values()];
  const observed = mean(values.map(({ value }) => value));
  randomState = 0x636c7573;
  const boot = Array.from({ length: 20_000 }, () => {
    const sampled = Array.from({ length: groups.length }, () => groups[Math.floor(random() * groups.length)]!).flat();
    return mean(sampled);
  }).sort((a, b) => a - b);
  let extreme = 0;
  const permutations = 200_000;
  for (let iteration = 0; iteration < permutations; iteration += 1) {
    const permuted = mean(
      groups.flatMap((group) => {
        const sign = random() < 0.5 ? 1 : -1;
        return group.map((value) => sign * value);
      }),
    );
    if (Math.abs(permuted) >= Math.abs(observed) - 1e-12) extreme += 1;
  }
  return {
    n: values.length,
    projects: groups.length,
    mean: observed,
    ci95: [boot[Math.floor((boot.length - 1) * 0.025)]!, boot[Math.floor((boot.length - 1) * 0.975)]!],
    permutationP: (extreme + 1) / (permutations + 1),
  };
};

const pairedDifference = (left: Condition, right: Condition) =>
  rows.flatMap((row) => {
    const leftResult = row.results[left];
    const rightResult = row.results[right];
    return leftResult && rightResult ? [leftResult.reward - rightResult.reward] : [];
  });

const solStudentEffect = pairedDifference("plan-impl-review", "sol-sol-sol");
const fableStudentEffect = pairedDifference("fable-plan-impl-review", "fable-fable-fable");
const interaction = rows.flatMap((row) => {
  const solLuna = row.results["plan-impl-review"];
  const solSol = row.results["sol-sol-sol"];
  const fableLuna = row.results["fable-plan-impl-review"];
  const fableFable = row.results["fable-fable-fable"];
  return solLuna && solSol && fableLuna && fableFable
    ? [fableLuna.reward - fableFable.reward - (solLuna.reward - solSol.reward)]
    : [];
});
const reviewDelta = (condition: PipelineCondition) =>
  rows.flatMap((row) => {
    const value = row.results[condition]?.reviewDelta;
    return typeof value === "number" ? [value] : [];
  });
const checkpointDifference = (left: PipelineCondition, right: PipelineCondition) =>
  rows.flatMap((row) => {
    const leftValue = row.results[left]?.implementationReward;
    const rightValue = row.results[right]?.implementationReward;
    return typeof leftValue === "number" && typeof rightValue === "number" ? [leftValue - rightValue] : [];
  });
const reviewDeltaDifference = (left: PipelineCondition, right: PipelineCondition) =>
  rows.flatMap((row) => {
    const leftValue = row.results[left]?.reviewDelta;
    const rightValue = row.results[right]?.reviewDelta;
    return typeof leftValue === "number" && typeof rightValue === "number" ? [leftValue - rightValue] : [];
  });
const fractionGapClosed = (condition: PipelineCondition) =>
  rows.flatMap((row) => {
    const result = row.results[condition];
    if (!result || typeof result.implementationReward !== "number" || result.implementationReward >= 1) return [];
    return [(result.reward - result.implementationReward) / (1 - result.implementationReward)];
  });
const gapClosureSummary = (condition: PipelineCondition) => {
  const checkpoints = rows.flatMap((row) => {
    const result = row.results[condition];
    return result && typeof result.implementationReward === "number" ? [result.implementationReward] : [];
  });
  const fractions = fractionGapClosed(condition);
  return {
    eligible: fractions.length,
    ceilingCases: checkpoints.filter((checkpoint) => checkpoint >= 1).length,
    meanFractionGapClosed: fractions.length ? mean(fractions) : null,
  };
};
const pairedDifferenceClustered = (left: Condition, right: Condition) =>
  rows.flatMap((row) => {
    const leftResult = row.results[left];
    const rightResult = row.results[right];
    return leftResult && rightResult
      ? [{ project: projectOf(row.slug), value: leftResult.reward - rightResult.reward }]
      : [];
  });
const reviewDeltaClustered = (condition: PipelineCondition) =>
  rows.flatMap((row) => {
    const value = row.results[condition]?.reviewDelta;
    return typeof value === "number" ? [{ project: projectOf(row.slug), value }] : [];
  });

const byCondition = Object.fromEntries(
  conditions.map((condition) => {
    const results = rows.flatMap((row) => (row.results[condition] ? [row.results[condition]!] : []));
    const timingResults = results.filter((result) => result.timingClean === true);
    return [
      condition,
      {
        n: results.length,
        meanReward: results.length ? mean(results.map((result) => result.reward)) : null,
        resolved: results.filter((result) => Math.abs(result.reward - 1) < 1e-12).length,
        resolvedRate: results.length
          ? results.filter((result) => Math.abs(result.reward - 1) < 1e-12).length / results.length
          : null,
        meanCostUsd: results.length ? mean(results.map((result) => result.costUsd)) : null,
        timingN: timingResults.length,
        meanWallS: timingResults.length ? mean(timingResults.map((result) => result.modelWallS ?? result.wallS)) : null,
      },
    ];
  }),
);

const byLanguage = Object.fromEntries(
  Object.keys(selection).map((language) => [
    language,
    Object.fromEntries(
      conditions.map((condition) => {
        const rewards = rows
          .filter((row) => row.language === language)
          .flatMap((row) => (row.results[condition] ? [row.results[condition]!.reward] : []));
        return [condition, { n: rewards.length, meanReward: rewards.length ? mean(rewards) : null }];
      }),
    ),
  ]),
);

const primaryHypotheses = {
  h1SolStudentReplacement: inference(solStudentEffect),
  h4ReportVisibility: inference(pairedDifference("plan-impl-review", "plan-impl-review-blind")),
};
const secondaryHypotheses = {
  h1SolTerraStudentReplacement: inference(pairedDifference("sol-terra-sol", "sol-sol-sol")),
  h1SolLunaMinusTerra: inference(pairedDifference("plan-impl-review", "sol-terra-sol")),
  h1FableStudentReplacement: inference(fableStudentEffect),
  h2TeacherInteraction: inference(interaction),
  h3SolReviewDelta: inference(reviewDelta("plan-impl-review")),
  h3FableReviewDelta: inference(reviewDelta("fable-plan-impl-review")),
  h4FableReportVisibility: inference(pairedDifference("fable-plan-impl-review", "fable-plan-impl-review-blind")),
};

const analysis = {
  study: sample.study,
  generatedAt: new Date().toISOString(),
  inferenceConfig: { randomSeed: "0x70657273", bootstrapIterations: 20_000, permutationIterations: 200_000 },
  runPrefix,
  selection,
  unfilled,
  tasks,
  validation,
  missingCells,
  attemptLedger: Object.fromEntries(
    Object.entries(
      allResults
        .filter((result) => result.runId.startsWith(runPrefix))
        .reduce<Record<string, number>>((counts, result) => {
          const key =
            result.status !== "RunFinished"
              ? result.status
              : result.quotaPoisoned
                ? "quota-poisoned"
                : result.auditError
                  ? "audit-error"
                  : result.tainted !== false
                    ? "tainted-or-unaudited"
                    : result.timingClean === false
                      ? "clean-reward/timing-contended"
                      : "clean";
          counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        }, {}),
    ).sort(),
  ),
  modelTimeline: Object.fromEntries(
    [...new Set(cleanResults.flatMap((result) => Object.values(result.stageExecution ?? {}).flatMap((x) => x.models)))]
      .sort()
      .map((model) => {
        const dates = cleanResults
          .filter((result) =>
            Object.values(result.stageExecution ?? {}).some((execution) => execution.models.includes(model)),
          )
          .map((result) => result.collectedAt)
          .sort();
        return [model, { firstCollectedAt: dates[0], lastCollectedAt: dates.at(-1), cells: dates.length }];
      }),
  ),
  byCondition,
  byLanguage,
  primaryHypotheses,
  primaryHolmAdjustedP: holmAdjust(primaryHypotheses),
  secondaryHypotheses,
  mechanismContrasts: {
    solLunaMinusSolCheckpoint: inference(checkpointDifference("plan-impl-review", "sol-sol-sol")),
    solTerraMinusSolCheckpoint: inference(checkpointDifference("sol-terra-sol", "sol-sol-sol")),
    solLunaMinusTerraCheckpoint: inference(checkpointDifference("plan-impl-review", "sol-terra-sol")),
    fableLunaMinusFableCheckpoint: inference(checkpointDifference("fable-plan-impl-review", "fable-fable-fable")),
    solWeakMinusStrongReviewDelta: inference(reviewDeltaDifference("plan-impl-review", "sol-sol-sol")),
    solTerraMinusStrongReviewDelta: inference(reviewDeltaDifference("sol-terra-sol", "sol-sol-sol")),
    solTerraReviewDelta: inference(reviewDelta("sol-terra-sol")),
    solCombinedWorkSolReviewDelta: inference(reviewDelta("sol-work-sol-review")),
    solCombinedWorkFableReviewDelta: inference(reviewDelta("sol-work-fable-review")),
    solVisibleMinusBlindReviewDelta: inference(reviewDeltaDifference("plan-impl-review", "plan-impl-review-blind")),
    solVisibleMinusBlindCheckpoint: inference(checkpointDifference("plan-impl-review", "plan-impl-review-blind")),
    solVisibleFractionGapClosed: inference(fractionGapClosed("plan-impl-review")),
    solBlindFractionGapClosed: inference(fractionGapClosed("plan-impl-review-blind")),
    fableWeakMinusStrongReviewDelta: inference(reviewDeltaDifference("fable-plan-impl-review", "fable-fable-fable")),
    fableVisibleMinusBlindReviewDelta: inference(reviewDeltaDifference("fable-plan-impl-review", "fable-plan-impl-review-blind")),
    fableVisibleMinusBlindCheckpoint: inference(checkpointDifference("fable-plan-impl-review", "fable-plan-impl-review-blind")),
    fableVisibleFractionGapClosed: inference(fractionGapClosed("fable-plan-impl-review")),
    fableBlindFractionGapClosed: inference(fractionGapClosed("fable-plan-impl-review-blind")),
  },
  gapClosureDiagnostics: Object.fromEntries(
    ["plan-impl-review", "plan-impl-review-blind", "fable-plan-impl-review", "fable-plan-impl-review-blind"].map((condition) => [
      condition,
      gapClosureSummary(condition as PipelineCondition),
    ]),
  ),
  operationalContrasts: {
    solAllTeacherMinusSolo: inference(pairedDifference("sol-sol-sol", "solo-sol")),
    solTerraMinusSolo: inference(pairedDifference("sol-terra-sol", "solo-sol")),
    solDelegatedMinusSolo: inference(pairedDifference("plan-impl-review", "solo-sol")),
    solBlindDelegatedMinusSolo: inference(pairedDifference("plan-impl-review-blind", "solo-sol")),
    solCombinedWorkSolReviewMinusSolo: inference(pairedDifference("sol-work-sol-review", "solo-sol")),
    solCombinedWorkSolReviewMinusSplit: inference(pairedDifference("sol-work-sol-review", "sol-sol-sol")),
    fableMinusSolReviewerOnCombinedWork: inference(pairedDifference("sol-work-fable-review", "sol-work-sol-review")),
    fableAllTeacherMinusSolo: inference(pairedDifference("fable-fable-fable", "solo-fable")),
    fableDelegatedMinusSolo: inference(pairedDifference("fable-plan-impl-review", "solo-fable")),
    fableBlindDelegatedMinusSolo: inference(pairedDifference("fable-plan-impl-review-blind", "solo-fable")),
  },
  projectClusteredSensitivity: {
    h1SolStudentReplacement: clusteredInference(pairedDifferenceClustered("plan-impl-review", "sol-sol-sol")),
    h4ReportVisibility: clusteredInference(pairedDifferenceClustered("plan-impl-review", "plan-impl-review-blind")),
    h4FableReportVisibility: clusteredInference(
      pairedDifferenceClustered("fable-plan-impl-review", "fable-plan-impl-review-blind"),
    ),
    h1SolTerraStudentReplacement: clusteredInference(pairedDifferenceClustered("sol-terra-sol", "sol-sol-sol")),
    h1SolLunaMinusTerra: clusteredInference(pairedDifferenceClustered("plan-impl-review", "sol-terra-sol")),
    h1FableStudentReplacement: clusteredInference(
      pairedDifferenceClustered("fable-plan-impl-review", "fable-fable-fable"),
    ),
    h2TeacherInteraction: clusteredInference(
      rows.flatMap((row) => {
        const solLuna = row.results["plan-impl-review"];
        const solSol = row.results["sol-sol-sol"];
        const fableLuna = row.results["fable-plan-impl-review"];
        const fableFable = row.results["fable-fable-fable"];
        return solLuna && solSol && fableLuna && fableFable
          ? [
              {
                project: projectOf(row.slug),
                value: fableLuna.reward - fableFable.reward - (solLuna.reward - solSol.reward),
              },
            ]
          : [];
      }),
    ),
    h3SolReviewDelta: clusteredInference(reviewDeltaClustered("plan-impl-review")),
    h3FableReviewDelta: clusteredInference(reviewDeltaClustered("fable-plan-impl-review")),
  },
  rows,
};

const fmt = (value: number | null | undefined, digits = 3) => (typeof value === "number" ? value.toFixed(digits) : "—");
const contrastRows = (contrasts: Record<string, ReturnType<typeof inference>>) =>
  Object.entries(contrasts)
    .map(
      ([name, value]) =>
        `| ${name} | ${value?.n ?? 0} | ${fmt(value?.mean)} | ${value ? `${fmt(value.ci95[0])} to ${fmt(value.ci95[1])}` : "—"} | ${fmt(value?.permutationP, 4)} | ${value ? `${value.wins}/${value.ties}/${value.losses}` : "—"} |`,
    )
    .join("\n");
const hypothesisRows = Object.entries(analysis.primaryHypotheses)
  .map(
    ([name, value]) =>
      `| ${name} (Holm p=${fmt(analysis.primaryHolmAdjustedP[name], 4)}) | ${value?.n ?? 0} | ${fmt(value?.mean)} | ${value ? `${fmt(value.ci95[0])} to ${fmt(value.ci95[1])}` : "—"} | ${fmt(value?.permutationP, 4)} | ${value ? `${value.wins}/${value.ties}/${value.losses}` : "—"} |`,
  )
  .join("\n");
const secondaryRows = contrastRows(analysis.secondaryHypotheses);
const mechanismRows = contrastRows(analysis.mechanismContrasts);
const gapClosureRows = Object.entries(analysis.gapClosureDiagnostics)
  .map(
    ([condition, value]) =>
      `| ${condition} | ${value.eligible} | ${value.ceilingCases} | ${fmt(value.meanFractionGapClosed)} |`,
  )
  .join("\n");
const operationalRows = contrastRows(analysis.operationalContrasts);
const clusteredRows = Object.entries(analysis.projectClusteredSensitivity)
  .map(
    ([name, value]) =>
      `| ${name} | ${value?.n ?? 0} | ${value?.projects ?? 0} | ${fmt(value?.mean)} | ${value ? `${fmt(value.ci95[0])} to ${fmt(value.ci95[1])}` : "—"} | ${fmt(value?.permutationP, 4)} |`,
  )
  .join("\n");
const conditionRows = conditions
  .map((condition) => {
    const value = byCondition[condition] as {
      n: number;
      meanReward: number | null;
      resolved: number;
      resolvedRate: number | null;
      timingN: number;
      meanCostUsd: number | null;
      meanWallS: number | null;
    };
    return `| ${condition} | ${value.n} | ${fmt(value.meanReward)} | ${value.resolved}/${value.n} (${fmt(value.resolvedRate)}) | ${fmt(value.meanCostUsd, 2)} | ${fmt(value.meanWallS === null ? null : value.meanWallS / 60, 1)} (n=${value.timingN}) |`;
  })
  .join("\n");
const languageRows = Object.entries(byLanguage)
  .map(([language, values]) => {
    const cells = values as Record<Condition, { n: number; meanReward: number | null }>;
    return `| ${language} | ${conditions.map((condition) => `${fmt(cells[condition].meanReward)} (${cells[condition].n})`).join(" | ")} |`;
  })
  .join("\n");
const taskRows = rows
  .map((row) => {
    const result = (condition: Condition) => row.results[condition];
    const pipeline = (condition: PipelineCondition) => {
      const value = result(condition);
      return `${fmt(value?.implementationReward)} → ${fmt(value?.reward)}`;
    };
    return `| ${row.slug} | ${row.language} | ${fmt(result("solo-sol")?.reward)} | ${pipeline("sol-sol-sol")} | ${pipeline("sol-terra-sol")} | ${pipeline("plan-impl-review")} | ${pipeline("plan-impl-review-blind")} | ${pipeline("sol-work-sol-review")} | ${pipeline("sol-work-fable-review")} | ${fmt(result("solo-fable")?.reward)} | ${pipeline("fable-fable-fable")} | ${pipeline("fable-plan-impl-review")} | ${pipeline("fable-plan-impl-review-blind")} |`;
  })
  .join("\n");
const invalidRows = Object.entries(validation)
  .filter(([, decision]) => decision.status === "invalidated")
  .map(
    ([slug, decision]) =>
      `| ${slug} | ${decision.language} | ${decision.rank} | ${decision.detail?.replaceAll("|", "\\|") ?? "—"} |`,
  )
  .join("\n");
const markdown = `# Persuasion Gap analysis\n\nGenerated ${analysis.generatedAt}. Run prefix: \`${runPrefix}\`.\n\n## Conditions\n\n| Condition | n | Mean reward | Resolved | Mean cost $ | Mean wall min |\n|---|---:|---:|---:|---:|---:|\n${conditionRows}\n\n## Primary paired hypotheses\n\nH1 tests the middle-model substitution; H4 tests whether showing the implementer's report changes reviewed quality. Positive win/tie/loss means the named contrast is positive.\n\n| Contrast | n | Mean | 95% paired bootstrap CI | permutation p | W/T/L |\n|---|---:|---:|---:|---:|---:|\n${hypothesisRows}\n\n## Secondary paired hypotheses\n\nThese contrasts are exploratory and are not included in the primary-family Holm correction.\n\n| Contrast | n | Mean | 95% paired bootstrap CI | permutation p | W/T/L |\n|---|---:|---:|---:|---:|---:|\n${secondaryRows}\n\n## Mechanism contrasts\n\nRaw review deltas are accompanied by fraction-of-available-gap-closed because the score ceiling mechanically limits improvement from stronger checkpoints.\n\n| Contrast | n | Mean | 95% paired bootstrap CI | permutation p | W/T/L |\n|---|---:|---:|---:|---:|---:|\n${mechanismRows}\n\nCheckpoint=1 cells have no available gap and are excluded from the ratio, then counted explicitly.\n\n| Condition | Ratio-eligible | Checkpoint=1 | Mean fraction gap closed |\n|---|---:|---:|---:|\n${gapClosureRows}\n\n## Operational and workflow controls\n\nThese preserve practical end-to-end comparisons and test the plan/implementation context break and reviewer family.\n\n| Contrast | n | Mean | 95% paired bootstrap CI | permutation p | W/T/L |\n|---|---:|---:|---:|---:|---:|\n${operationalRows}\n\n## Project-clustered sensitivity\n\n| Contrast | n | Projects | Mean | 95% cluster bootstrap CI | cluster sign-flip p |\n|---|---:|---:|---:|---:|---:|\n${clusteredRows}\n\n## Language-stratified descriptive means\n\nEach cell is mean reward (n).\n\n| Language | solo Sol | Sol→Sol→Sol | Sol→Terra→Sol | Sol→Luna→Sol | Sol→Luna→Sol blind | Sol(work)→Sol | Sol(work)→Fable | solo Fable | Fable→Fable→Fable | Fable→Luna→Fable | Fable→Luna→Fable blind |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${languageRows}\n\n## Task-level scores\n\nPipeline cells show implementation checkpoint → final reviewed score.\n\n| Task | Language | solo Sol | Sol→Sol→Sol | Sol→Terra→Sol | Sol→Luna→Sol | Sol→Luna→Sol blind | Sol(work)→Sol | Sol(work)→Fable | solo Fable | Fable→Fable→Fable | Fable→Luna→Fable | Fable→Luna→Fable blind |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${taskRows}\n\n## Selection\n\n${Object.entries(
  selection,
)
  .map(([language, slugs]) => `- ${language}: ${slugs.join(", ") || "not yet filled"}`)
  .join(
    "\n",
  )}\n\n## Fairness exclusions\n\n| Task | Language | Frozen rank | Reason |\n|---|---|---:|---|\n${invalidRows || "| None | — | — | — |"}\n`;

writeFileSync(outJson, JSON.stringify(analysis, null, 2));
writeFileSync(outMarkdown, markdown);
console.log(markdown);
