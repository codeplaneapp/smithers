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

const ROLES = [
  "orchestrator",
  "planning",
  "review",
  "smart",
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
  models: SotaModel[];
};

export function validateRegistry(registry: SotaRegistry): void {
  if (!Number.isInteger(registry.version) || registry.version < 1) {
    throw new Error(`registry version must be a positive integer, got ${registry.version}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(registry.updatedAt)) {
    throw new Error(`registry updatedAt must be YYYY-MM-DD, got ${registry.updatedAt}`);
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

function renderMdx(registry: SotaRegistry): string {
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
      "provider for new GA models and opens a PR here when the state of the art moves; `smithers update` picks the " +
      "changes up on your machine, and re-running `smithers init` refreshes installed workflows to the new defaults.",
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
    "The fable-sandwich tiers (see the [workflow optimization guide](/guides/workflow-optimization)) resolve to these ids:",
  );
  lines.push("");
  lines.push("| Role | Default model |");
  lines.push("| --- | --- |");
  const defaults = roleDefaults(registry);
  for (const role of ROLES) {
    if (defaults[role]) lines.push(`| ${role} | \`${defaults[role]}\` |`);
  }
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
  lines.push("// default. Code refers to stable slots (fable, codex, gemini, ...) so a model");
  lines.push("// bump is a registry edit, not a code change. See docs/reference/sota-models.mdx.");
  lines.push("");
  lines.push(`export const SOTA_REGISTRY_VERSION = ${registry.version};`);
  lines.push("");
  lines.push(`export const SOTA_REGISTRY_UPDATED_AT = ${JSON.stringify(registry.updatedAt)};`);
  lines.push("");
  lines.push("/** Stable handle → current best model id for that seat. */");
  lines.push(`export const SOTA_SLOTS = Object.freeze(${JSON.stringify(slots, null, 2)});`);
  lines.push("");
  lines.push("/** Fable-sandwich role → current best model id. */");
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
  return { mdx: renderMdx(registry), cliModule: renderCliModule(registry) };
}

if (import.meta.main) {
  const { mdx, cliModule } = generateSota();
  writeFileSync(MDX_PATH, mdx);
  writeFileSync(CLI_MODULE_PATH, cliModule);
  console.log(`Wrote ${MDX_PATH}`);
  console.log(`Wrote ${CLI_MODULE_PATH}`);
}
