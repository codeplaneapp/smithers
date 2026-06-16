// Turn the coverage-map task bank (+ any hand-curated tasks) into per-suite
// cases.jsonl, fanning each task across the model matrix. This is the multiplier
// that scales coverage × models toward ~1000 evals.
//
//   bun evals/harness/generate-cases.ts            # (re)generate every suite
//   bun evals/harness/generate-cases.ts --dry      # report counts, write nothing
//
// Sources (same task schema, merged + deduped by id):
//   evals/_inventory/task-bank.jsonl       — auto (the 14-way sweep)
//   evals/_inventory/curated-tasks.jsonl   — hand-written high-confidence tasks
//
// Per-suite hand-written CASE lines in evals/suites/<suite>/curated.jsonl are
// prepended verbatim (and win id collisions).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SOTA_MODELS, WEAK_MODELS } from "../agents.js";
import { repoRoot } from "../lib/paths.js";

const ROOT = repoRoot();
const SUITES = join(ROOT, "evals", "suites");

type Task = {
  id: string;
  feature?: string;
  area?: string;
  kind?: string; // knowledge | authoring | ops | db-query | build-complex
  tier?: string; // weak | sota
  verify?: string; // deterministic | judge | fixture
  task: string;
  canonicalAnswer?: string;
  mustNot?: string[]; // optional forbidden tokens (curated tasks)
  notes?: string;
  source?: string; // coverage-map | real-usage | curated
};

function readJsonl(path: string): Task[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Task);
}

const KNOWLEDGE_CLI_AREAS = new Set([
  "cli", "workflow-execution", "workflow-monitoring", "workflow-discovery", "run-control",
  "agent-interaction", "diagnostics", "project-setup", "testing-evaluation", "approvals",
  "configuration",
]);
const APPROVAL_TAGS = new Set([
  "<Approval", "<ApprovalGate", "<HumanTask", "<Signal", "<WaitForEvent", "<Timer",
]);

/** Route a task to a suite, or null to defer it (no deterministic verify yet). */
function routeSuite(t: Task): string | null {
  const area = t.area ?? "";
  const kind = t.kind ?? "";
  if (t.verify === "fixture") return null; // needs a seeded run DB — fixture wave
  // Real-usage tasks (mined from actual sessions) get their own high-signal suite,
  // regardless of kind, as long as they are verifiable (judge or have an answer).
  if (t.source === "real-usage" && t.verify !== "fixture") return "real-usage";
  if (kind === "ops" || kind === "db-query") return null; // needs live state — fixture wave

  if (kind === "knowledge") {
    if (t.verify !== "judge" && !((t.canonicalAnswer ?? "").trim())) return null; // nothing to assert on
    if (KNOWLEDGE_CLI_AREAS.has(area)) return "knowledge-cli";
    if (area.startsWith("components") || area === "patterns" || area === "control-flow" || area === "output-handling" || area === "capabilities") return "knowledge-components";
    if (area === "runtime-concepts" || area === "concepts" || area === "durability-model" || area === "knowledge") return "knowledge-concepts";
    if (area === "time-travel") return "knowledge-time-travel";
    if (area === "scorers" || area === "evals") return "knowledge-scorers-evals";
    if (area === "memory") return "knowledge-memory";
    if (area === "examples") return "knowledge-examples";
    if (area === "observability" || area === "devtools") return "knowledge-observability";
    if (area === "mcp" || area === "integrations" || area === "human-inbox" || area === "scheduling" || area === "scheduling-cron-poller") return "knowledge-integrations";
    if (area === "gateway-http-api") return "knowledge-gateway";
    if (area === "aspects-budgets") return "knowledge-concepts";
    if (area === "sandbox-runtimes" || area === "components-advanced") return "knowledge-components";
    if (area === "time-travel-deep") return "knowledge-time-travel";
    if (area === "openapi-tools-deep") return "knowledge-tools";
    return "knowledge-cli";
  }

  if (kind === "authoring" || kind === "build-complex") {
    if (t.tier === "sota" || kind === "build-complex") return "build-complex";
    if (area === "patterns") return "authoring-patterns";
    if (area === "scorers" || area === "evals") return "authoring-scorers-evals";
    if (area === "memory") return "authoring-memory";
    if (area.startsWith("agent")) return "authoring-agents";
    if (area === "openapi-tools" || area === "built-in-tools" || area === "tool-context" || area === "openapi-tools-deep") return "authoring-tools";
    if (area === "sandboxing" || area === "vcs" || area === "sandbox-runtimes") return "authoring-sandbox-vcs";
    if (area === "scheduling-cron-poller" || area === "components-advanced") return "authoring-patterns";
    if (area === "aspects-budgets" || area === "time-travel-deep") return "authoring-workflows";
    if (area === "workflow-integration" || area === "examples" || area === "optimize" || area === "gateway-http-api") return "authoring-misc";
    // components-control-flow + authoring + control-flow + output-handling + configuration + capabilities
    const tags = extractTags(t.canonicalAnswer);
    if (tags.some((tag) => APPROVAL_TAGS.has(tag))) return "authoring-approvals";
    return "authoring-workflows";
  }
  return null;
}

/** `<Approval ...` / `<Loop ...` → ["<Approval","<Loop"] (unique, max 5). Up to 5
 * so a complex multi-feature workflow is verified on ALL its required components
 * (a real complexity test), not just the first two. */
function extractTags(answer?: string): string[] {
  const out: string[] = [];
  const re = /<([A-Z][A-Za-z0-9]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer ?? "")) !== null) {
    const tag = `<${m[1]}`;
    if (!out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 5);
}

type VerifySpec = { kind: string; must?: string[]; mustNot?: string[]; answer?: string; rubric?: string };

function verifyOf(t: Task): VerifySpec | null {
  // judge wins regardless of kind (a knowledge task can be judge-graded).
  if (t.verify === "judge") {
    return { kind: "judge", rubric: t.notes || t.task };
  }
  if (t.kind === "knowledge") {
    const ans = (t.canonicalAnswer ?? "").trim();
    if (!ans) return null;
    // A multi-value answer (a comma/"and"-separated list of short items, e.g.
    // "run:read, run:write, ...") → require each value to appear. Checked before
    // the sentence heuristic so long lists don't get punted to a judge.
    if (/,/.test(ans)) {
      const parts = ans
        .split(/,|\band\b/)
        .map((s) => s.replace(/^[[\]"'\s]+|[[\]"'\s]+$/g, ""))
        .filter(Boolean);
      const allShort = parts.length >= 2 && parts.every((p) => p.split(/\s+/).length <= 4);
      if (allShort) {
        const spec: VerifySpec = { kind: "contains", must: parts };
        if (t.mustNot?.length) spec.mustNot = t.mustNot;
        return spec;
      }
    }
    const words = ans.split(/\s+/).length;
    // A sentence-like answer (an explanation) can't be matched verbatim — grade
    // it with a judge against the canonical answer as the rubric. Only short
    // keyword/identifier answers use deterministic equals/contains.
    const looksLikeSentence = /[.!?]\s/.test(ans) || ans.length > 60 || words > 8;
    if (looksLikeSentence) return { kind: "judge", rubric: `A correct answer should convey: ${ans}` };
    const short = !ans.includes("\n") && words <= 4;
    const spec: VerifySpec = short ? { kind: "equals", answer: ans } : { kind: "contains", must: [ans] };
    if (t.mustNot?.length) spec.mustNot = t.mustNot;
    return spec;
  }
  // authoring deterministic
  const tags = extractTags(t.canonicalAnswer);
  if (tags.length === 0) {
    // No component tree to render (memory store API, openapi tool() calls, config
    // code, prose answers). A render-only graph check would false-fail or be
    // meaninglessly weak — judge the code against its intended behavior instead.
    const rubric = t.notes || (t.canonicalAnswer ? `Correct code should accomplish the task; reference: ${t.canonicalAnswer}` : t.task);
    return { kind: "judge", rubric };
  }
  // A real component-tree workflow: render it and require the key component tags.
  const spec: VerifySpec = { kind: "graph", must: tags };
  if (t.mustNot?.length) spec.mustNot = t.mustNot;
  return spec;
}

/** Spread models so we don't always lead with haiku: rotate the window by index. */
function fanModels(pool: readonly string[], count: number, index: number): string[] {
  const n = Math.min(count, pool.length);
  return Array.from({ length: n }, (_, i) => pool[(index + i) % pool.length]);
}

function fanCount(t: Task): number {
  if (t.tier === "sota" || t.kind === "build-complex") return SOTA_MODELS.length; // both sota
  if (t.kind === "knowledge") return 3; // cheap → broader model spread
  return 2; // authoring
}

export function main() {
  const dry = process.argv.includes("--dry");
  const tasks = [...readJsonl(join(ROOT, "evals/_inventory/task-bank.jsonl")), ...readJsonl(join(ROOT, "evals/_inventory/curated-tasks.jsonl"))];
  // dedup tasks by id (curated wins)
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);
  const deduped = [...byId.values()];

  const bySuite = new Map<string, string[]>();
  const deferred: Task[] = [];
  let idx = 0;
  for (const t of deduped) {
    const suite = routeSuite(t);
    const verify = suite ? verifyOf(t) : null;
    if (!suite || !verify) {
      deferred.push(t);
      continue;
    }
    const sota = t.tier === "sota" || t.kind === "build-complex";
    const pool = sota ? SOTA_MODELS : WEAK_MODELS;
    const models = fanModels(pool, fanCount(t), idx++);
    for (const model of models) {
      const id = `${t.id}--${model}`;
      const line = JSON.stringify({
        id,
        input: {
          taskId: t.id,
          area: t.area ?? "unknown",
          feature: t.feature ?? "unknown",
          model,
          task: t.task,
          verify,
          judgeModel: "opus",
        },
        expected: { status: "finished", outputContains: { verdict: [{ passed: true }] } },
        metadata: { area: t.area ?? "unknown", feature: t.feature ?? "unknown", tier: sota ? "sota" : "weak", source: t.source ?? "coverage-map", kind: t.kind, verify: t.verify },
      });
      (bySuite.get(suite) ?? bySuite.set(suite, []).get(suite)!).push(line);
    }
  }

  // write per-suite cases.jsonl = curated case lines + generated, dedup by case id
  let total = 0;
  const summary: Array<[string, number]> = [];
  for (const [suite, genLines] of [...bySuite.entries()].sort()) {
    const dir = join(SUITES, suite);
    const curatedPath = join(dir, "curated.jsonl");
    const curated = existsSync(curatedPath)
      ? readFileSync(curatedPath, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [];
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const line of [...curated, ...genLines]) {
      let id: string | undefined;
      try {
        id = JSON.parse(line).id;
      } catch {
        continue;
      }
      if (id && !seen.has(id)) {
        seen.add(id);
        merged.push(line);
      }
    }
    total += merged.length;
    summary.push([suite, merged.length]);
    if (!dry) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cases.jsonl"), `${merged.join("\n")}\n`);
      // ensure each suite has an eval.tsx
      const evalFile = join(dir, "eval.tsx");
      if (!existsSync(evalFile)) {
        writeFileSync(
          evalFile,
          `/** @jsxImportSource smithers-orchestrator */\n// ${suite} — generated suite. See evals/README.md.\nimport { createFluencyEval } from "../../lib/eval-kit";\n\nexport default createFluencyEval({ suite: "${suite}" });\n`,
        );
      }
    }
  }

  if (!dry) {
    writeFileSync(join(ROOT, "evals/_inventory/deferred-tasks.jsonl"), deferred.map((t) => JSON.stringify(t)).join("\n") + "\n");
  }

  console.log(`Generated ${total} cases across ${summary.length} suites${dry ? " (dry)" : ""}; deferred ${deferred.length} (fixture/ops/no-answer).`);
  for (const [s, n] of summary.sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${s}`);
}

// Exported for the issue→eval generator (new-eval.tsx).
export { routeSuite, verifyOf, type Task };

if (import.meta.main) main();
