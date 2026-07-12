#!/usr/bin/env bun
/**
 * Daily SOTA model research: ask a web-searching agent whether any provider
 * shipped a new model with an exact usable id since the registry's updatedAt,
 * and if so rewrite docs/data/sota-models.json and every surface generated or
 * pinned from it.
 *
 * Run manually from a credential-controlled developer environment via
 * `pnpm sota:research`. Scheduled maintenance intentionally excludes
 * credentialed, web-enabled research. The script only mutates the working
 * tree. Exit code 0 means the tree now reflects the latest research (possibly
 * unchanged).
 *
 * The agent proposes a full replacement registry as strict JSON. We never
 * trust it blindly: the proposal must pass the same validation as the
 * generator, bump version by exactly 1, and keep the policy rules (exact usable
 * ids, no floating aliases, one holder per badge).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listAccounts } from "@smithers-orchestrator/accounts";
import { ClaudeCodeAgent, CodexAgent, KimiAgent, type AgentLike } from "smithers-orchestrator";
import { validateRegistry } from "./generate-sota.ts";

const ROOT = resolve(import.meta.dir, "..");
const REGISTRY_PATH = resolve(ROOT, "docs/data/sota-models.json");

/** Directories whose pinned model ids get mechanically rewritten on a bump. */
const SWEEP_DIRS = [
  "README.md",
  ".smithers",
  "docs",
  "apps/cli",
  "apps/init-site",
  "apps/review/action/src",
  "apps/review/src",
  "apps/smithers/src/agents",
];
const SWEEP_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mdx", ".md"]);
const SWEEP_EXCLUDE = [
  /\/node_modules\//,
  /\/dist\//,
  /apps\/cli\/ui-dist\//,
  /docs\/data\/sota-models\.json$/,
  /docs\/reference\/sota-models\.mdx$/, // regenerated
  /docs\/llms.*\.txt$/, // regenerated
  /\.smithers\/specs\//, // historical design docs stay as written
];

type Registry = {
  version: number;
  updatedAt: string;
  policy: string[];
  models: Array<{
    id: string;
    slot: string | null;
    status: string;
    replacedBy?: string;
    [key: string]: unknown;
  }>;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildPrompt(registry: Registry): string {
  return [
    `Today is ${today()}. You maintain the SOTA model registry for smithers, an agent orchestrator.`,
    `The registry was last confirmed on ${registry.updatedAt}. Research, with web search against official provider sources (Anthropic, OpenAI, Google/DeepMind, Moonshot AI, plus any major new frontier-lab entrant), whether any NEW usable model has shipped since then that changes what the registry should recommend. This includes a research preview only when provider documentation confirms an exact model id and real availability.`,
    "",
    "Registry policy (binding):",
    ...registry.policy.map((rule) => `- ${rule}`),
    "",
    "Verification bar: only report a model when its exact API/CLI model id and real availability are confirmed by the provider's own documentation. Marketing names and previews without a usable id do not count.",
    "",
    "The current registry JSON:",
    "```json",
    JSON.stringify(registry, null, 2),
    "```",
    "",
    "Respond with ONLY a JSON object as your final message, no prose after it:",
    '- If nothing changed: {"changed": false, "reason": "<one line per provider on what you checked>"}',
    '- If the registry should change: {"changed": true, "reason": "<what shipped and which badges/roles/slots move>", "registry": <the FULL new registry object>}',
    "",
    "Rules for a changed registry:",
    `- version must be exactly ${registry.version + 1}; updatedAt must be ${today()}.`,
    "- Keep unchanged entries byte-identical. Keep the same badge and role vocabularies.",
    "- A new best model takes the badge and the slot from the model it beats; the beaten model drops to status current.",
    "- A replaced default gets status deprecated with replacedBy pointing at its successor. Never delete entries.",
    "- Descriptions match the existing voice: concrete, one to three sentences, no hype, no em-dashes.",
  ].join("\n");
}

/** Pull the last verdict-shaped JSON object out of agent stdout. Scans each
 * `{` from the last one backwards; the first candidate that parses and carries
 * a `changed` key wins. */
export function extractJson(stdout: string): Record<string, unknown> | null {
  const end = stdout.lastIndexOf("}");
  if (end < 0) return null;
  let start = stdout.lastIndexOf("{", end);
  while (start >= 0) {
    const candidate = stdout.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && "changed" in parsed) return parsed;
    } catch {
      /* keep scanning backwards */
    }
    // lastIndexOf(_, -1) clamps to 0 and would re-find index 0 forever, so stop
    // once the leftmost brace has been tried.
    if (start === 0) break;
    start = stdout.lastIndexOf("{", start - 1);
  }
  return null;
}

async function runResearchAgent(prompt: string): Promise<string> {
  const commonCodex = {
    cwd: ROOT,
    model: "gpt-5.6-luna",
    config: ["tools.web_search=true", "model_reasoning_effort=medium"],
    sandbox: "read-only" as const,
    fullAuto: true,
    skipGitRepoCheck: true,
    timeoutMs: 30 * 60 * 1000,
  };
  let accounts: ReturnType<typeof listAccounts> = [];
  try {
    accounts = listAccounts(process.env);
  } catch {
    // A malformed registry must not prevent the ambient Codex attempt or the
    // explicit non-Codex fallbacks below.
  }
  const codexAccounts = accounts.filter((account) => account.provider === "codex" || account.provider === "openai-api");
  const attempts: Array<{ label: string; agent: AgentLike }> = [
    { label: "ambient Codex Luna", agent: new CodexAgent(commonCodex) },
    ...codexAccounts.map((account) => ({
      label: `registered Codex account ${account.label}`,
      agent: new CodexAgent({
        ...commonCodex,
        ...(account.configDir ? { configDir: account.configDir } : {}),
        ...(account.apiKey ? { apiKey: account.apiKey } : {}),
      }),
    })),
    // Provider fallbacks stay last and run only after every Codex credential.
    {
      label: "Claude fallback",
      agent: new ClaudeCodeAgent({
        cwd: ROOT,
        model: "claude-fable-5",
        permissionMode: "bypassPermissions",
        dangerouslySkipPermissions: true,
        timeoutMs: 30 * 60 * 1000,
      }),
    },
    {
      label: "Kimi fallback",
      agent: new KimiAgent({
        cwd: ROOT,
        model: "kimi-k2.7-code",
        finalMessageOnly: true,
        quiet: true,
        timeoutMs: 30 * 60 * 1000,
      }),
    },
  ];

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const result = await attempt.agent.generate({ prompt });
      const text = typeof result === "string" ? result : result?.text;
      if (typeof text === "string" && text.trim()) return text;
      failures.push(`${attempt.label}: empty response`);
    } catch (error) {
      failures.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`all SOTA research agents failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function* walk(path: string): Generator<string> {
  if (SWEEP_EXCLUDE.some((re) => re.test(path))) return;
  if (!statSync(path).isDirectory()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path)) yield* walk(join(path, entry));
}

/**
 * Old id → new id replacements implied by the bump: every newly deprecated id
 * maps to its replacedBy, and a slot moving to a new model maps the old slot
 * holder's id to the new one (that is how seeded workflows pinning a default
 * follow the registry).
 */
export function computeReplacements(oldRegistry: Registry, newRegistry: Registry): Map<string, string> {
  const replacements = new Map<string, string>();
  const oldById = new Map(oldRegistry.models.map((m) => [m.id, m]));
  for (const model of newRegistry.models) {
    const before = oldById.get(model.id);
    if (model.status === "deprecated" && model.replacedBy && before?.status !== "deprecated") {
      replacements.set(model.id, model.replacedBy);
    }
  }
  const oldSlots = new Map(oldRegistry.models.filter((m) => m.slot).map((m) => [m.slot as string, m.id]));
  for (const model of newRegistry.models) {
    if (!model.slot) continue;
    const previousId = oldSlots.get(model.slot);
    if (previousId && previousId !== model.id && !replacements.has(previousId)) {
      replacements.set(previousId, model.id);
    }
  }
  return replacements;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sweepReplacements(replacements: Map<string, string>): string[] {
  if (replacements.size === 0) return [];
  const sortedReplacements = [...replacements].sort(([a], [b]) => b.length - a.length);
  const changed: string[] = [];
  for (const dir of SWEEP_DIRS) {
    for (const path of walk(resolve(ROOT, dir))) {
      if (![...SWEEP_EXTENSIONS].some((ext) => path.endsWith(ext))) continue;
      const before = readFileSync(path, "utf8");
      let after = before;
      for (const [oldId, newId] of sortedReplacements) {
        after = after.replace(
          new RegExp(`(^|[^A-Za-z0-9._:/-])${escapeRegExp(oldId)}(?=$|[^A-Za-z0-9._:/-])`, "g"),
          (_match, prefix) => `${prefix}${newId}`,
        );
      }
      if (after !== before) {
        writeFileSync(path, after);
        changed.push(path.slice(ROOT.length + 1));
      }
    }
  }
  return changed;
}

if (import.meta.main) {
  const registry: Registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  console.log(`Researching model landscape (registry v${registry.version}, ${registry.updatedAt})...`);
  const stdout = await runResearchAgent(buildPrompt(registry));
  const verdict = extractJson(stdout);
  if (!verdict) {
    console.error(stdout.slice(-2000));
    throw new Error("research agent returned no parseable verdict JSON");
  }

  if (!verdict.changed) {
    console.log(`No new SOTA models. ${verdict.reason ?? ""}`);
    process.exit(0);
  }

  const proposed = verdict.registry as Registry;
  validateRegistry(proposed as never);
  if (proposed.version !== registry.version + 1) {
    throw new Error(`proposed version ${proposed.version}, expected ${registry.version + 1}`);
  }

  writeFileSync(REGISTRY_PATH, `${JSON.stringify(proposed, null, 2)}\n`);
  const replacements = computeReplacements(registry, proposed);
  const swept = sweepReplacements(replacements);
  run("bun", ["scripts/generate-sota.ts"]);
  run("pnpm", ["docs:llms"]);
  run("pnpm", ["generate:init-pack"]);

  const summary = [
    `SOTA model registry v${proposed.version} (${proposed.updatedAt})`,
    "",
    String(verdict.reason ?? ""),
    "",
    replacements.size
      ? `Mechanical id rewrites: ${[...replacements].map(([a, b]) => `${a} → ${b}`).join(", ")}`
      : "No id rewrites.",
    swept.length ? `Swept files:\n${swept.map((f) => `- ${f}`).join("\n")}` : "",
    "",
    "Generated surfaces refreshed: docs page, CLI module, llms bundles, init pack, review defaults, and the Agents registry page.",
    "Reviewer checklist: verify the researched ids against provider docs; confirm Sol/Terra/Luna role assignments on CLI, init, review, and Agents surfaces; check apps/review and packages/scorers price tables for any new model.",
  ].join("\n");
  const summaryPath = process.env.SOTA_SUMMARY_PATH
    ?? join(mkdtempSync(join(tmpdir(), "smithers-sota-research-")), "summary.md");
  writeFileSync(summaryPath, `${summary}\n`, { mode: 0o600 });
  console.log(summary);
}
