import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTEXT = join(ROOT, ".context", "orchbench");
const RESULTS = join(CONTEXT, "results");
const VALIDATED = join(CONTEXT, "validated");
const INVALIDATED = join(CONTEXT, "invalidated");
const SAMPLE = join(ROOT, "benchmarks", "orchbench", "persuasion-gap-sample.json");

type Sample = {
  study: string;
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
};

const conditions = ["solo-sol", "plan-impl-review", "solo-fable", "fable-plan-impl-review"] as const;
type Condition = (typeof conditions)[number];

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const runPrefix = arg("--run-prefix", "orchb-pg");
const outJson = resolve(arg("--json", join(RESULTS, "persuasion-gap-analysis.json")));
const outMarkdown = resolve(arg("--markdown", join(RESULTS, "persuasion-gap-analysis.md")));

const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as Sample;
const selection: Record<string, string[]> = {};
const unfilled: Record<string, number> = {};
for (const [language, candidates] of Object.entries(sample.candidates)) {
  selection[language] = candidates
    .filter((slug) => existsSync(join(VALIDATED, slug)))
    .slice(0, sample.tasksPerLanguage);
  unfilled[language] = sample.tasksPerLanguage - selection[language].length;
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

const resultFor = (slug: string, pattern: Condition): Result | undefined =>
  allResults
    .filter(
      (result) =>
        result.slug === slug &&
        result.pattern === pattern &&
        result.runId.startsWith(runPrefix) &&
        result.status === "RunFinished" &&
        result.quotaPoisoned === false &&
        result.tainted === false,
    )
    .sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0];

const rows = tasks.map((slug) => ({
  slug,
  language: Object.entries(selection).find(([, slugs]) => slugs.includes(slug))?.[0] ?? "unknown",
  results: Object.fromEntries(conditions.map((condition) => [condition, resultFor(slug, condition)])) as Record<
    Condition,
    Result | undefined
  >,
}));

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
    ci95: [boot[Math.floor(boot.length * 0.025)]!, boot[Math.floor(boot.length * 0.975)]!],
    permutationP: (extreme + 1) / (permutations + 1),
    wins,
    ties: values.length - wins - losses,
    losses,
  };
};

const projectOf = (slug: string) => slug.split("-")[0]!;
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
    ci95: [boot[Math.floor(boot.length * 0.025)]!, boot[Math.floor(boot.length * 0.975)]!],
    permutationP: (extreme + 1) / (permutations + 1),
  };
};

const pairedDifference = (pipeline: Condition, solo: Condition) =>
  rows.flatMap((row) => {
    const pipelineResult = row.results[pipeline];
    const soloResult = row.results[solo];
    return pipelineResult && soloResult ? [pipelineResult.reward - soloResult.reward] : [];
  });

const solPenalty = pairedDifference("plan-impl-review", "solo-sol");
const fablePenalty = pairedDifference("fable-plan-impl-review", "solo-fable");
const interaction = rows.flatMap((row) => {
  const solPipeline = row.results["plan-impl-review"];
  const solSolo = row.results["solo-sol"];
  const fablePipeline = row.results["fable-plan-impl-review"];
  const fableSolo = row.results["solo-fable"];
  return solPipeline && solSolo && fablePipeline && fableSolo
    ? [fablePipeline.reward - fableSolo.reward - (solPipeline.reward - solSolo.reward)]
    : [];
});
const reviewDelta = (condition: "plan-impl-review" | "fable-plan-impl-review") =>
  rows.flatMap((row) => {
    const value = row.results[condition]?.reviewDelta;
    return typeof value === "number" ? [value] : [];
  });
const pairedDifferenceClustered = (pipeline: Condition, solo: Condition) =>
  rows.flatMap((row) => {
    const pipelineResult = row.results[pipeline];
    const soloResult = row.results[solo];
    return pipelineResult && soloResult
      ? [{ project: projectOf(row.slug), value: pipelineResult.reward - soloResult.reward }]
      : [];
  });
const reviewDeltaClustered = (condition: "plan-impl-review" | "fable-plan-impl-review") =>
  rows.flatMap((row) => {
    const value = row.results[condition]?.reviewDelta;
    return typeof value === "number" ? [{ project: projectOf(row.slug), value }] : [];
  });

const byCondition = Object.fromEntries(
  conditions.map((condition) => {
    const results = rows.flatMap((row) => (row.results[condition] ? [row.results[condition]!] : []));
    return [
      condition,
      {
        n: results.length,
        meanReward: results.length ? mean(results.map((result) => result.reward)) : null,
        resolved: results.filter((result) => Math.abs(result.reward - 1) < 1e-12).length,
        meanCostUsd: results.length ? mean(results.map((result) => result.costUsd)) : null,
        meanWallS: results.length ? mean(results.map((result) => result.modelWallS ?? result.wallS)) : null,
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

const analysis = {
  study: sample.study,
  generatedAt: new Date().toISOString(),
  runPrefix,
  selection,
  unfilled,
  tasks,
  validation,
  byCondition,
  byLanguage,
  hypotheses: {
    h1SolDelegationPenalty: inference(solPenalty),
    h1FableDelegationPenalty: inference(fablePenalty),
    h2TeacherInteraction: inference(interaction),
    h3SolReviewDelta: inference(reviewDelta("plan-impl-review")),
    h3FableReviewDelta: inference(reviewDelta("fable-plan-impl-review")),
  },
  projectClusteredSensitivity: {
    h1SolDelegationPenalty: clusteredInference(pairedDifferenceClustered("plan-impl-review", "solo-sol")),
    h1FableDelegationPenalty: clusteredInference(pairedDifferenceClustered("fable-plan-impl-review", "solo-fable")),
    h2TeacherInteraction: clusteredInference(
      rows.flatMap((row) => {
        const solPipeline = row.results["plan-impl-review"];
        const solSolo = row.results["solo-sol"];
        const fablePipeline = row.results["fable-plan-impl-review"];
        const fableSolo = row.results["solo-fable"];
        return solPipeline && solSolo && fablePipeline && fableSolo
          ? [
              {
                project: projectOf(row.slug),
                value: fablePipeline.reward - fableSolo.reward - (solPipeline.reward - solSolo.reward),
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
const hypothesisRows = Object.entries(analysis.hypotheses)
  .map(
    ([name, value]) =>
      `| ${name} | ${value?.n ?? 0} | ${fmt(value?.mean)} | ${value ? `${fmt(value.ci95[0])} to ${fmt(value.ci95[1])}` : "—"} | ${fmt(value?.permutationP, 4)} | ${value ? `${value.wins}/${value.ties}/${value.losses}` : "—"} |`,
  )
  .join("\n");
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
      meanCostUsd: number | null;
      meanWallS: number | null;
    };
    return `| ${condition} | ${value.n} | ${fmt(value.meanReward)} | ${value.resolved} | ${fmt(value.meanCostUsd, 2)} | ${fmt(value.meanWallS === null ? null : value.meanWallS / 60, 1)} |`;
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
    const delegated = result("plan-impl-review");
    const fableDelegated = result("fable-plan-impl-review");
    return `| ${row.slug} | ${row.language} | ${fmt(result("solo-sol")?.reward)} | ${fmt(delegated?.implementationReward)} → ${fmt(delegated?.reward)} | ${fmt(result("solo-fable")?.reward)} | ${fmt(fableDelegated?.implementationReward)} → ${fmt(fableDelegated?.reward)} |`;
  })
  .join("\n");
const invalidRows = Object.entries(validation)
  .filter(([, decision]) => decision.status === "invalidated")
  .map(
    ([slug, decision]) =>
      `| ${slug} | ${decision.language} | ${decision.rank} | ${decision.detail?.replaceAll("|", "\\|") ?? "—"} |`,
  )
  .join("\n");
const markdown = `# Persuasion Gap analysis\n\nGenerated ${analysis.generatedAt}. Run prefix: \`${runPrefix}\`.\n\n## Conditions\n\n| Condition | n | Mean reward | Resolved | Mean cost $ | Mean wall min |\n|---|---:|---:|---:|---:|---:|\n${conditionRows}\n\n## Paired hypotheses\n\nPositive win/tie/loss means the named contrast is positive.\n\n| Contrast | n | Mean | 95% paired bootstrap CI | permutation p | W/T/L |\n|---|---:|---:|---:|---:|---:|\n${hypothesisRows}\n\n## Project-clustered sensitivity\n\n| Contrast | n | Projects | Mean | 95% cluster bootstrap CI | cluster sign-flip p |\n|---|---:|---:|---:|---:|---:|\n${clusteredRows}\n\n## Language-stratified descriptive means\n\nEach cell is mean reward (n).\n\n| Language | solo-sol | Sol→Luna→Sol | solo-fable | Fable→Luna→Fable |\n|---|---:|---:|---:|---:|\n${languageRows}\n\n## Task-level scores\n\nDelegated cells show Luna checkpoint → final reviewed score.\n\n| Task | Language | solo-sol | Sol→Luna→Sol | solo-fable | Fable→Luna→Fable |\n|---|---|---:|---:|---:|---:|\n${taskRows}\n\n## Selection\n\n${Object.entries(
  selection,
)
  .map(([language, slugs]) => `- ${language}: ${slugs.join(", ") || "not yet filled"}`)
  .join(
    "\n",
  )}\n\n## Fairness exclusions\n\n| Task | Language | Frozen rank | Reason |\n|---|---|---:|---|\n${invalidRows || "| None | — | — | — |"}\n`;

writeFileSync(outJson, JSON.stringify(analysis, null, 2));
writeFileSync(outMarkdown, markdown);
console.log(markdown);
