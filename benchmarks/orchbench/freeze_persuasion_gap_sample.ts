import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTEXT = join(ROOT, ".context", "orchbench");
const SAMPLE = join(ROOT, "benchmarks", "orchbench", "persuasion-gap-sample.json");
const OUT = join(ROOT, "benchmarks", "orchbench", "persuasion-gap-selected.json");
const VERIFY = join(ROOT, "benchmarks", "roadmapbench", "harness", "verify_validation_receipt.py");

type Frame = {
  study: string;
  datasetRevision: string;
  targetTasks: number;
  targetPerLanguage: number;
  minimumPerLanguage: number;
  overflowLanguageOrder: string[];
  tasksPerLanguage: number;
  candidates: Record<string, string[]>;
};

const frame = JSON.parse(readFileSync(SAMPLE, "utf8")) as Frame;
type SelectedTask = {
  ordinal: number;
  language: string;
  slug: string;
  project: string;
  candidateRank: number;
  validationReceiptSha256: string;
  imagePinnedRef: string;
};
const tasks: SelectedTask[] = [];
const selectedByLanguage = new Map<string, SelectedTask[]>();
const nextCandidate = new Map<string, number>();
const initialCounts = new Map<string, number>();
const overflowSelections = new Map<string, string[]>();
const decisions: Array<{
  language: string;
  slug: string;
  candidateRank: number;
  status: "pass" | "invalid";
  decisionReceiptSha256: string;
  reason: string;
}> = [];

function validatedTask(language: string, slug: string, candidateRank: number): SelectedTask | null {
  const valid = join(CONTEXT, "validated", slug);
  const invalid = join(CONTEXT, "invalidated", slug);
  if (existsSync(valid) && existsSync(invalid)) throw new Error(`contradictory validation decisions: ${slug}`);
  if (!existsSync(valid)) {
    if (!existsSync(invalid)) {
      throw new Error(`selection is not terminal at ${language} rank ${candidateRank}: ${slug}`);
    }
    const verification = spawnSync("python3", [VERIFY, join(ROOT, ".context", "roadmapbench", "data", slug), invalid], {
      encoding: "utf8",
      env: { ...process.env, RMB_SCORER_NETWORK: "bridge" },
    });
    if (verification.status !== 0) throw new Error(`invalid decision receipt failed verification: ${slug}`);
    const receipt = JSON.parse(readFileSync(invalid, "utf8")) as Record<string, unknown>;
    if (receipt.decision !== "invalid" || receipt.taskId !== slug) throw new Error(`malformed invalid decision: ${slug}`);
    decisions.push({
      language,
      slug,
      candidateRank,
      status: "invalid",
      decisionReceiptSha256: createHash("sha256").update(readFileSync(invalid)).digest("hex"),
      reason: `noop=${String(receipt.noopReward)} oracle=${String(receipt.oracleReward)}`,
    });
    return null;
  }
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(readFileSync(valid, "utf8"));
  } catch {
    throw new Error(`legacy or malformed validation marker: ${slug}`);
  }
  if (receipt.schemaVersion !== 1 || receipt.taskId !== slug || typeof receipt.imagePinnedRef !== "string") {
    throw new Error(`invalid validation receipt: ${slug}`);
  }
  if (receipt.decision !== undefined && receipt.decision !== "pass") throw new Error(`non-passing receipt in validated/: ${slug}`);
  const verification = spawnSync("python3", [VERIFY, join(ROOT, ".context", "roadmapbench", "data", slug), valid], {
    encoding: "utf8",
    env: { ...process.env, RMB_SCORER_NETWORK: "bridge" },
  });
  if (verification.status !== 0) throw new Error(`passing receipt failed verification: ${slug}`);
  decisions.push({
    language,
    slug,
    candidateRank,
    status: "pass",
    decisionReceiptSha256: createHash("sha256").update(readFileSync(valid)).digest("hex"),
    reason: `noop=${String(receipt.noopReward)} oracle=${String(receipt.oracleReward)}`,
  });
  return {
    ordinal: -1,
    language,
    slug,
    project: slug.split("-")[0]!,
    candidateRank,
    validationReceiptSha256: createHash("sha256").update(readFileSync(valid)).digest("hex"),
    imagePinnedRef: receipt.imagePinnedRef,
  };
}

for (const [language, candidates] of Object.entries(frame.candidates)) {
  const selected: SelectedTask[] = [];
  let index = 0;
  for (; index < candidates.length && selected.length < frame.targetPerLanguage; index += 1) {
    const task = validatedTask(language, candidates[index]!, index + 1);
    if (task) selected.push(task);
  }
  if (selected.length < frame.minimumPerLanguage) {
    throw new Error(`${language} has ${selected.length}/${frame.minimumPerLanguage} minimum tasks`);
  }
  selectedByLanguage.set(language, selected);
  initialCounts.set(language, selected.length);
  overflowSelections.set(language, []);
  nextCandidate.set(language, index);
}

let selectedCount = [...selectedByLanguage.values()].reduce((sum, selected) => sum + selected.length, 0);
while (selectedCount < frame.targetTasks) {
  let addedThisCycle = false;
  for (const language of frame.overflowLanguageOrder) {
    if (selectedCount === frame.targetTasks) break;
    const candidates = frame.candidates[language];
    const selected = selectedByLanguage.get(language);
    if (!candidates || !selected) throw new Error(`invalid overflow language: ${language}`);
    let index = nextCandidate.get(language) ?? 0;
    while (index < candidates.length) {
      const task = validatedTask(language, candidates[index]!, index + 1);
      index += 1;
      nextCandidate.set(language, index);
      if (!task) continue;
      selected.push(task);
      overflowSelections.get(language)!.push(task.slug);
      selectedCount += 1;
      addedThisCycle = true;
      break;
    }
  }
  if (!addedThisCycle) throw new Error(`only ${selectedCount}/${frame.targetTasks} tasks passed validation`);
}

for (const language of Object.keys(frame.candidates)) {
  for (const task of selectedByLanguage.get(language) ?? []) {
    task.ordinal = tasks.length;
    tasks.push(task);
  }
}

const frozen = {
  schemaVersion: 1,
  study: frame.study,
  datasetRevision: frame.datasetRevision,
  targetTasks: frame.targetTasks,
  targetPerLanguage: frame.targetPerLanguage,
  minimumPerLanguage: frame.minimumPerLanguage,
  overflowLanguageOrder: frame.overflowLanguageOrder,
  languageSelection: Object.fromEntries(
    Object.keys(frame.candidates).map((language) => [
      language,
      {
        initialCount: initialCounts.get(language) ?? 0,
        deficit: frame.targetPerLanguage - (initialCounts.get(language) ?? 0),
        overflowSelections: overflowSelections.get(language) ?? [],
        finalCount: selectedByLanguage.get(language)?.length ?? 0,
      },
    ]),
  ),
  decisions,
  conditionOrder: [
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
  ],
  tasks,
};
const encoded = JSON.stringify(frozen, null, 2) + "\n";
if (existsSync(OUT)) {
  if (readFileSync(OUT, "utf8") !== encoded) throw new Error("current receipts would change the frozen sample");
  console.log(`verified frozen ${tasks.length}-task sample in ${OUT}`);
} else {
  writeFileSync(OUT, encoded);
  console.log(`froze ${tasks.length} tasks in ${OUT}`);
}
