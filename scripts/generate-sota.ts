#!/usr/bin/env bun
/**
 * Render the SOTA model registry (docs/data/sota-models.json) into its two
 * generated surfaces:
 *
 *   1. docs/reference/sota-models.mdx        — the human/agent docs page
 *   2. apps/cli/src/sota-models.generated.js — the CLI's model-id constants
 *
 * The JSON is the single source of truth. Edit it, run `pnpm sota:gen`, and
 * commit all three files together; `pnpm check:sota` fails CI on drift.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const REGISTRY_PATH = resolve(ROOT, "docs/data/sota-models.json");
const BENCHMARKS_PATH = resolve(ROOT, "docs/data/sota-benchmarks.json");
const MDX_PATH = resolve(ROOT, "docs/reference/sota-models.mdx");
const CLI_MODULE_PATH = resolve(ROOT, "apps/cli/src/sota-models.generated.js");

const BADGE_LABELS: Record<string, string> = {
  "best-orchestrator": "Best orchestrator",
  "smartest-reviewer": "Smartest reviewer",
  "smartest-coder": "Smartest coder",
  "best-ui": "Best at UI",
  "fastest-coding": "Fastest coding",
  "fast-and-cheap": "Fast & cheap",
  "best-open-source": "Best open source",
  "best-value-coding": "Best value coding",
};

const REQUIRED_ROUTING_SLOTS = ["luna", "terra", "sol", "opus", "fable"] as const;

const ROLES = [
  "orchestrator",
  "planning",
  "review",
  "smart",
  "midTier",
  "smartTool",
  "validate",
  "implement",
  "cheapFast",
  "ui",
  "realtime",
  "research",
] as const;

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  moonshot: "Moonshot AI",
};

type SotaModel = {
  id: string;
  slot: string | null;
  provider: string;
  name: string;
  status: "sota" | "current" | "deprecated";
  released?: string;
  replacedBy?: string;
  engines: string[];
  badges: string[];
  roles: string[];
  description: string;
};

type SotaRegistry = {
  version: number;
  updatedAt: string;
  policy: string[];
  routing: {
    slots: Record<string, string>;
    intro: string;
    workflowDefault: string;
    fableGuidance: string;
    oneshot: string;
    situations: Array<{ start: string; when: string; escalate: string }>;
  };
  models: SotaModel[];
};

type BenchmarkRow = {
  models?: string[];
  label?: string;
  harness: string;
  score: string;
  n?: number;
  subset: string;
  status: "result" | "reference" | "pending";
  note?: string;
};

type Benchmark = {
  id: string;
  name: string;
  url: string;
  dataset: string;
  metric: string;
  inRepo: string;
  headline: string;
  rows: BenchmarkRow[];
};

type BenchmarkRegistry = {
  version: number;
  updatedAt: string;
  note?: string;
  benchmarks: Benchmark[];
};

export function validateRegistry(registry: SotaRegistry): void {
  if (!Number.isInteger(registry.version) || registry.version < 1) {
    throw new Error(`registry version must be a positive integer, got ${registry.version}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(registry.updatedAt)) {
    throw new Error(`registry updatedAt must be YYYY-MM-DD, got ${registry.updatedAt}`);
  }
  if (!registry.routing || typeof registry.routing !== "object") throw new Error("registry routing is required");
  for (const name of REQUIRED_ROUTING_SLOTS) {
    if (typeof registry.routing.slots?.[name] !== "string" || !registry.routing.slots[name].trim()) {
      throw new Error(`routing slot ${name} is required`);
    }
  }
  for (const [name, text] of Object.entries({
    intro: registry.routing.intro,
    workflowDefault: registry.routing.workflowDefault,
    fableGuidance: registry.routing.fableGuidance,
    oneshot: registry.routing.oneshot,
  })) {
    if (typeof text !== "string" || !text.trim()) throw new Error(`routing ${name} must be non-empty text`);
  }
  if (!Array.isArray(registry.routing.situations) || registry.routing.situations.length === 0) {
    throw new Error("routing situations are required");
  }
  for (const [index, situation] of registry.routing.situations.entries()) {
    if (
      typeof situation?.start !== "string" ||
      !situation.start.trim() ||
      typeof situation?.when !== "string" ||
      !situation.when.trim() ||
      typeof situation?.escalate !== "string" ||
      !situation.escalate.trim()
    )
      throw new Error(`routing situation ${index} must have non-empty start, when, and escalate text`);
  }
  const ids = new Set<string>();
  const slots = new Set<string>();
  const badges = new Set<string>();
  for (const model of registry.models) {
    if (!model.id || ids.has(model.id)) throw new Error(`duplicate or empty model id: ${model.id}`);
    ids.add(model.id);
    if (/latest/i.test(model.id) && model.status !== "deprecated") {
      throw new Error(`floating alias ${model.id} must be deprecated, not ${model.status}`);
    }
    if (model.slot) {
      if (slots.has(model.slot)) throw new Error(`duplicate slot: ${model.slot}`);
      if (model.status === "deprecated") throw new Error(`deprecated model ${model.id} cannot hold slot ${model.slot}`);
      slots.add(model.slot);
    }
    if (!["sota", "current", "deprecated"].includes(model.status)) {
      throw new Error(`bad status on ${model.id}: ${model.status}`);
    }
    for (const badge of model.badges) {
      if (!BADGE_LABELS[badge]) throw new Error(`unknown badge on ${model.id}: ${badge}`);
      if (badges.has(badge)) throw new Error(`badge ${badge} is held by two models`);
      if (model.status === "deprecated") throw new Error(`deprecated model ${model.id} cannot hold badge ${badge}`);
      badges.add(badge);
    }
    for (const role of model.roles) {
      if (!(ROLES as readonly string[]).includes(role)) throw new Error(`unknown role on ${model.id}: ${role}`);
    }
    if (model.status === "deprecated" && !model.replacedBy) {
      throw new Error(`deprecated model ${model.id} needs replacedBy`);
    }
    if (!model.description?.trim()) throw new Error(`model ${model.id} needs a description`);
  }
  for (const [name, slot] of Object.entries(registry.routing.slots)) {
    if (!slots.has(slot)) throw new Error(`routing slot ${name} references unknown slot ${slot}`);
    const model = registry.models.find((m) => m.slot === slot);
    if (!model || model.status === "deprecated") throw new Error(`routing slot ${name} must reference an active model`);
  }
  for (const situation of registry.routing.situations) {
    if (!registry.routing.slots[situation.start]) {
      throw new Error(`routing situation references unknown routing slot ${situation.start}`);
    }
  }
  for (const model of registry.models) {
    if (model.replacedBy) {
      const target = registry.models.find((m) => m.id === model.replacedBy);
      if (!target) throw new Error(`${model.id} replacedBy unknown id ${model.replacedBy}`);
      if (target.status === "deprecated") throw new Error(`${model.id} replacedBy deprecated id ${model.replacedBy}`);
    }
  }
}

function active(registry: SotaRegistry): SotaModel[] {
  return registry.models.filter((m) => m.status !== "deprecated");
}

function deprecated(registry: SotaRegistry): SotaModel[] {
  return registry.models.filter((m) => m.status === "deprecated");
}

/** Best model per role: sota entries win over current, then registry order. */
export function roleDefaults(registry: SotaRegistry): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const role of ROLES) {
    const candidates = active(registry).filter((m) => m.roles.includes(role));
    candidates.sort((a, b) => Number(b.status === "sota") - Number(a.status === "sota"));
    if (candidates[0]) defaults[role] = candidates[0].id;
  }
  return defaults;
}

/**
 * A benchmark row renders only if every model it names is a current (non-deprecated)
 * entry in the registry. Rows that name a deprecated or absent model (e.g. an older
 * Claude Opus 4.6 or GPT-5.2 leaderboard line) are dropped, so the page never quotes
 * a result for a model the roster no longer lists. Reference baselines that name no
 * specific model (they carry a `label`) always render.
 */
export function visibleRows(registry: SotaRegistry, benchmark: Benchmark): BenchmarkRow[] {
  const currentIds = new Set(active(registry).map((m) => m.id));
  return benchmark.rows.filter((row) => !row.models || row.models.every((id) => currentIds.has(id)));
}

function renderBenchmarks(registry: SotaRegistry, benchmarks: Benchmark[]): string[] {
  const nameOf = new Map(registry.models.map((m) => [m.id, m.name]));
  const lines: string[] = [];
  lines.push("## Benchmarks");
  lines.push("");
  lines.push(
    "Independent of the roster above: how these models actually score. smithers ships two benchmark harnesses in-repo: " +
      "[`benchmarks/roadmapbench`](https://github.com/smithersai/smithers/tree/main/benchmarks/roadmapbench) " +
      "(RoadmapBench, a real audited run) and " +
      "[`benchmarks/site`](https://github.com/smithersai/smithers/tree/main/benchmarks/site) " +
      "(the benchmarks.smithers.sh leaderboard, sourced from `benchmarks/results.json`). Only results for models that " +
      "still appear in the registry above are shown; rows for older models (e.g. Claude Opus 4.6, GPT-5.2) are dropped " +
      "automatically. `pending` rows are honest placeholders: the smithers fleet run has not completed at full scale yet.",
  );
  lines.push("");
  lines.push(
    "{/* Generated from docs/data/sota-benchmarks.json. Rows naming a deprecated or unlisted model are filtered out. */}",
  );
  for (const benchmark of benchmarks) {
    const rows = visibleRows(registry, benchmark);
    if (!rows.length) continue;
    lines.push("");
    lines.push(`### ${benchmark.name}`);
    lines.push("");
    const facts = [
      `[${benchmark.dataset}](${benchmark.url})`,
      `metric: ${benchmark.metric}`,
      `harness: \`${benchmark.inRepo}\``,
    ];
    lines.push(facts.join(" · "));
    lines.push("");
    lines.push(benchmark.headline);
    lines.push("");
    lines.push("| Models | Harness | Score | Sample | Notes |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const row of rows) {
      const who = row.models ? row.models.map((id) => nameOf.get(id) ?? id).join(" + ") : (row.label ?? "-");
      const sample = row.n ? `${row.subset} · n=${row.n}` : row.subset;
      const score = row.status === "result" ? `**${row.score}**` : row.score;
      lines.push(`| ${who} | ${row.harness} | ${score} | ${sample} | ${row.note ?? ""} |`);
    }
  }
  lines.push("");
  return lines;
}

function renderMdx(registry: SotaRegistry, benchmarks: Benchmark[]): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push('title: "SOTA models"');
  lines.push(
    `description: "The state-of-the-art model roster smithers configures: descriptions, badges, and role defaults. Registry v${registry.version}, updated ${registry.updatedAt}."`,
  );
  lines.push("---");
  lines.push("");
  lines.push("{/* GENERATED FILE. Edit docs/data/sota-models.json, then run `pnpm sota:gen`. */}");
  lines.push("");
  lines.push(
    `**Registry v${registry.version}** · updated **${registry.updatedAt}**. This page is generated from ` +
      "[`docs/data/sota-models.json`](https://github.com/smithersai/smithers/blob/main/docs/data/sota-models.json), " +
      "the single source of truth for which models smithers configures by default. A daily research job checks every " +
      "provider for new GA models and opens a PR here when the state of the art moves; `bunx smthrs update` " +
      "picks the changes up on your machine, and re-running `bunx smthrs init` refreshes installed " +
      "workflows to the new defaults.",
  );
  lines.push("");
  lines.push("## Badges");
  lines.push("");
  lines.push("Each badge names the single best model for that job right now.");
  lines.push("");
  lines.push("| Badge | Model | ID |");
  lines.push("| --- | --- | --- |");
  for (const model of active(registry)) {
    for (const badge of model.badges) {
      lines.push(`| ${BADGE_LABELS[badge]} | ${model.name} | \`${model.id}\` |`);
    }
  }
  lines.push("");
  lines.push("## Role defaults");
  lines.push("");
  lines.push(
    "The workflow role seats resolve to these ids (Claude builds and gates; Codex reviews and validates); see [Recipes](/recipes) for practical workflow patterns:",
  );
  lines.push("");
  lines.push("| Role | Default model |");
  lines.push("| --- | --- |");
  const defaults = roleDefaults(registry);
  for (const role of ROLES) {
    if (defaults[role]) lines.push(`| ${role} | \`${defaults[role]}\` |`);
  }
  lines.push("");
  lines.push("### How to choose a tier");
  lines.push("");
  lines.push(
    `The role table is a starting policy, not a claim that every task belongs to one model. ${registry.routing.intro}`,
  );
  lines.push("");
  lines.push("| Situation | Start with | Escalate when |");
  lines.push("| --- | --- | --- |");
  for (const situation of registry.routing.situations) {
    const slot = registry.routing.slots[situation.start];
    const model = registry.models.find((candidate) => candidate.slot === slot);
    if (!model) throw new Error(`missing routing model for ${situation.start}`);
    lines.push(`| ${situation.when} | \`${model.id}\` | ${situation.escalate} |`);
  }
  lines.push("");
  lines.push(registry.routing.workflowDefault);
  lines.push("");
  lines.push("```tsx");
  const routingId = (name: string): string => {
    const slot = registry.routing.slots[name];
    const model = registry.models.find((candidate) => candidate.slot === slot);
    if (!model) throw new Error(`missing routing model for ${name}`);
    return model.id;
  };
  lines.push(`const orchestrator = new ClaudeCodeAgent({ model: "${routingId("opus")}" });`);
  lines.push(`const planner = new ClaudeCodeAgent({ model: "${routingId("fable")}" });`);
  lines.push(`const implementer = new CodexAgent({ model: "${routingId("terra")}" });`);
  lines.push(
    `const trivialFixer = new CodexAgent({ model: "${routingId("luna")}", config: { model_reasoning_effort: "medium" } });`,
  );
  lines.push(`const validator = new CodexAgent({ model: "${routingId("terra")}" });`);
  lines.push(`const reviewer = new CodexAgent({ model: "${routingId("sol")}" });`);
  lines.push(`const fableFallback = new ClaudeCodeAgent({ model: "${routingId("fable")}" });`);
  lines.push("const smartFallbackChain = [reviewer, fableFallback];");
  lines.push("```");
  lines.push("");
  lines.push("### Oneshot task routing");
  lines.push("");
  lines.push(registry.routing.oneshot);
  lines.push("");
  lines.push(
    `${registry.routing.fableGuidance} See [Anthropic's Fable 5 announcement](https://www.anthropic.com/news/claude-fable-5-mythos-5) and [July redeployment update](https://www.anthropic.com/news/redeploying-fable-5).`,
  );
  const providers = [...new Set(active(registry).map((m) => m.provider))];
  for (const provider of providers) {
    lines.push("");
    lines.push(`## ${PROVIDER_LABELS[provider] ?? provider}`);
    for (const model of active(registry).filter((m) => m.provider === provider)) {
      lines.push("");
      lines.push(`### ${model.name} (\`${model.id}\`)`);
      lines.push("");
      const facts: string[] = [];
      if (model.badges.length) facts.push(`**${model.badges.map((b) => BADGE_LABELS[b]).join("** · **")}**`);
      facts.push(model.status === "sota" ? "state of the art" : "current");
      if (model.released) facts.push(`released ${model.released}`);
      facts.push(`engines: ${model.engines.map((e) => `\`${e}\``).join(", ")}`);
      if (model.roles.length) facts.push(`roles: ${model.roles.join(", ")}`);
      lines.push(facts.join(" · "));
      lines.push("");
      lines.push(model.description);
    }
  }
  lines.push("");
  lines.push(...renderBenchmarks(registry, benchmarks));
  lines.push("## Deprecated ids");
  lines.push("");
  lines.push("Rewrite these on sight; the daily research job does the same sweep mechanically.");
  lines.push("");
  lines.push("| Deprecated | Use instead |");
  lines.push("| --- | --- |");
  for (const model of deprecated(registry)) {
    lines.push(`| \`${model.id}\` | \`${model.replacedBy}\` |`);
  }
  lines.push("");
  lines.push("## Update policy");
  lines.push("");
  for (const rule of registry.policy) {
    lines.push(`- ${rule}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderCliModule(registry: SotaRegistry): string {
  const slots: Record<string, string> = {};
  for (const model of active(registry)) {
    if (model.slot) slots[model.slot] = model.id;
  }
  const replacements: Record<string, string> = {};
  for (const model of deprecated(registry)) {
    if (model.replacedBy) replacements[model.id] = model.replacedBy;
  }
  const lines: string[] = [];
  lines.push("// GENERATED FILE. Edit docs/data/sota-models.json, then run `pnpm sota:gen`.");
  lines.push("//");
  lines.push("// The SOTA model registry: which concrete model ids smithers configures by");
  lines.push("// default. Code refers to stable slots (codexSol, codexTerra, codex, ...) so a model");
  lines.push("// bump is a registry edit, not a code change. See docs/reference/sota-models.mdx.");
  lines.push("");
  lines.push(`export const SOTA_REGISTRY_VERSION = ${registry.version};`);
  lines.push("");
  lines.push(`export const SOTA_REGISTRY_UPDATED_AT = ${JSON.stringify(registry.updatedAt)};`);
  lines.push("");
  lines.push("/** Stable handle → current best model id for that seat. */");
  lines.push(`export const SOTA_SLOTS = Object.freeze(${JSON.stringify(slots, null, 2)});`);
  lines.push("");
  lines.push("/** Workflow role → current best model id. */");
  lines.push(`export const SOTA_ROLE_MODELS = Object.freeze(${JSON.stringify(roleDefaults(registry), null, 2)});`);
  lines.push("");
  lines.push("/** Deprecated id → the id sweeps rewrite it to. */");
  lines.push(`export const SOTA_DEPRECATED_MODELS = Object.freeze(${JSON.stringify(replacements, null, 2)});`);
  lines.push("");
  lines.push("/** The full registry entries (active and deprecated). */");
  lines.push(`export const SOTA_MODELS = Object.freeze(${JSON.stringify(registry.models, null, 2)});`);
  lines.push("");
  return lines.join("\n");
}

export function generateSota(): { mdx: string; cliModule: string } {
  const registry: SotaRegistry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  validateRegistry(registry);
  const benchmarks: BenchmarkRegistry = JSON.parse(readFileSync(BENCHMARKS_PATH, "utf8"));
  return { mdx: renderMdx(registry, benchmarks.benchmarks), cliModule: renderCliModule(registry) };
}

if (import.meta.main) {
  const { mdx, cliModule } = generateSota();
  writeFileSync(MDX_PATH, mdx);
  writeFileSync(CLI_MODULE_PATH, cliModule);
  console.log(`Wrote ${MDX_PATH}`);
  console.log(`Wrote ${CLI_MODULE_PATH}`);
}
