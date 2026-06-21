#!/usr/bin/env bun
/**
 * Generate the llms-*.txt artifacts from the canonical MDX docs.
 *
 *   docs/llms-core.txt           — the everyday context (~30K tokens target)
 *   docs/llms-memory.txt         — opt-in fragment: cross-run memory
 *   docs/llms-openapi.txt        — opt-in fragment: OpenAPI tools
 *   docs/llms-observability.txt  — opt-in fragment: server, gateway, otel
 *   docs/llms-effect.txt         — opt-in fragment: low-level Effect-ts surface
 *   docs/llms.txt                — index pointing at all of the above
 *
 * Each fragment is a concatenation of MDX bodies (frontmatter stripped).
 * Pages are listed in the manifests below. To change the contents of a
 * fragment, edit the manifest — the script is otherwise stateless.
 *
 * Run: bun scripts/generate-llms.ts
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DOCS = resolve(import.meta.dir, "../docs");
// The `smithers` agent skill bundles a copy of the full docs so an installed
// skill is self-contained. Keep it generated here so it never drifts from docs.
const SKILL_DIR = resolve(import.meta.dir, "../skills/smithers");
// The CLI package carries the docs commands' default, version-matched output so
// `bunx smithers-orchestrator@x docs-full` does not depend on the latest website.
const CLI_DOCS_DIR = resolve(import.meta.dir, "../apps/cli/docs");

// -----------------------------------------------------------------------------
// Manifests
// -----------------------------------------------------------------------------

const CORE_PAGES = [
  // Hero. The site root (index.mdx) is a custom marketing splash (JSX), not
  // prose, so introduction.mdx leads the agent-facing bundle instead.
  "introduction.mdx",
  "installation.mdx",
  "quickstart.mdx",
  "starters.mdx",
  // The two anchor pages
  "tour.mdx",
  "how-it-works.mdx",
  "guides/context-engineering.mdx",
  "guides/agent-operating-playbook.mdx",
  // JSX surface (single page now — installation + quickstart are stubs)
  "jsx/overview.mdx",
  // CLI catalog
  "cli/overview.mdx",
  "cli/quickstart.mdx",
  // Components reference (every component, compressed)
  "components/workflow.mdx",
  "components/task.mdx",
  "components/sequence.mdx",
  "components/parallel.mdx",
  "components/branch.mdx",
  "components/loop.mdx",
  "components/approval.mdx",
  "components/approval-gate.mdx",
  "components/escalation-chain.mdx",
  "components/decision-table.mdx",
  "components/human-task.mdx",
  "components/signal.mdx",
  "components/wait-for-event.mdx",
  "components/timer.mdx",
  "components/saga.mdx",
  "components/try-catch-finally.mdx",
  "components/sandbox.mdx",
  "components/subflow.mdx",
  "components/continue-as-new.mdx",
  "components/super-smithers.mdx",
  "components/aspects.mdx",
  "components/worktree.mdx",
  "components/review-loop.mdx",
  "components/optimizer.mdx",
  "components/content-pipeline.mdx",
  "components/drift-detector.mdx",
  "components/scan-fix-verify.mdx",
  "components/poller.mdx",
  "components/runbook.mdx",
  "components/supervisor.mdx",
  "components/merge-queue.mdx",
  "components/check-suite.mdx",
  "components/classify-and-route.mdx",
  "components/gather-and-synthesize.mdx",
  "components/panel.mdx",
  "components/debate.mdx",
  "components/kanban.mdx",
  // Recipes and reference
  "recipes.mdx",
  "guides/common-footguns.mdx",
  "reference/types.mdx",
  "reference/errors.mdx",
  "reference/package-configuration.mdx",
  "reference/vcs-helpers.mdx",
  // Runtime API (small, useful in core). Events moved to its own opt-in
  // fragment because the SmithersEvent union is too detailed for everyday
  // schema noise for everyday use.
  "runtime/run-workflow.mdx",
  "runtime/render-frame.mdx",
  "runtime/revert.mdx",
  "runtime/run-state.mdx",
  // TUI is a discrete product surface, not a recipe
  "guides/tui.mdx",
  "guides/workflow-optimization.mdx",
];

const MEMORY_PAGES = [
  "concepts/memory.mdx",
  "guides/memory-quickstart.mdx",
];

const OPENAPI_PAGES = [
  "concepts/openapi-tools.mdx",
  "guides/openapi-tools-quickstart.mdx",
];

const OBSERVABILITY_PAGES = [
  "integrations/server.mdx",
  "integrations/serve.mdx",
  "integrations/gateway.mdx",
  "integrations/mcp-server.mdx",
];

const EVENT_PAGES = [
  "runtime/events.mdx",
  "reference/event-types.mdx",
];

const EFFECT_PAGES = [
  "effect/overview.mdx",
];

const INTEGRATIONS_PAGES = [
  "integrations/integrations.mdx",
  "integrations/cli-agents.mdx",
  "integrations/sdk-agents.mdx",
  "integrations/mcp-toolset.mdx",
  "integrations/tools.mdx",
  "integrations/common-tools.mdx",
  "integrations/community-connectors.mdx",
  "integrations/ecosystem.mdx",
  "integrations/pi-integration.mdx",
];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type Frontmatter = { title?: string; description?: string };

function parseFrontmatter(src: string): { fm: Frontmatter; body: string } {
  if (!src.startsWith("---\n")) return { fm: {}, body: src };
  const end = src.indexOf("\n---\n", 4);
  if (end < 0) return { fm: {}, body: src };
  const yaml = src.slice(4, end);
  const body = src.slice(end + 5).replace(/^\n+/, "");
  const fm: Frontmatter = {};
  for (const line of yaml.split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
    (fm as any)[m[1]] = v;
  }
  return { fm, body };
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function renderPage(relPath: string): string {
  const abs = resolve(DOCS, relPath);
  if (!exists(abs)) {
    throw new Error(`Missing docs page in llms manifest: ${relPath}`);
  }
  const src = readFileSync(abs, "utf8");
  const { fm, body } = parseFrontmatter(src);
  const title = fm.title ?? relPath.replace(/\.mdx?$/, "");
  const desc = fm.description ? `> ${fm.description}\n\n` : "";
  // Composite component pages embed verbatim package source (the "## Source"
  // CodeGroup). It lives in the repo already and would bloat the bundles, so
  // drop the generated region from the agent-facing docs.
  const prose = body.replace(
    /\n*\{\/\* GENERATED:COMPONENT-SOURCE START[\s\S]*?GENERATED:COMPONENT-SOURCE END \*\/\}\n*/g,
    "\n",
  );
  return `## ${title}\n\n${desc}${prose.trimEnd()}\n\n---\n\n`;
}

function renderManifest(name: string, pages: string[], header: string): string {
  let out = `# ${name}\n\n${header}\n\n---\n\n`;
  for (const p of pages) out += renderPage(p);
  // Trim trailing separator
  return out.replace(/\n\n---\n\n$/, "\n");
}

// -----------------------------------------------------------------------------
// Build
// -----------------------------------------------------------------------------

const HEADERS = {
  core: [
    "> Smithers — durable AI workflow orchestration as a JSX runtime.",
    "> Repo: github.com/smithersai/smithers · Package: smithers-orchestrator (npm)",
    "",
    "This file is the agent-facing core Smithers documentation. It is for Claude, Codex, and other AI harnesses operating Smithers for a human. Read top to bottom for the runtime, agent operating playbook, JSX surface, CLI, and components.",
    "",
    "Human-facing docs live on the website under the For Humans Guide. Humans ask their agent for outcomes; agents consume these llms files and operate Smithers.",
    "",
    "Opt-in topics cover features most users do not need. They are also sections of the full bundle at /llms-full.txt (only /llms.txt and /llms-full.txt are served on the docs site):",
    "  - Memory (cross-run state)",
    "  - OpenAPI tools",
    "  - Observability + HTTP server",
    "  - Effect-ts authoring API",
    "  - Integrations + CLI agents",
    "  - Event types (full union)",
    "",
    "Changelogs are not included; see /docs/changelogs/ on the docs site.",
  ].join("\n"),
  memory: "> Smithers cross-run memory: working memory, message history, semantic recall, processors.",
  openapi: "> Smithers OpenAPI tools: turn an OpenAPI spec into AI SDK tools, with auth, filters, and observability.",
  observability: "> Smithers observability surface: HTTP server, gateway, MCP, OpenTelemetry, metrics.",
  effect: "> Smithers Effect-ts authoring API: build workflows as Effect values without JSX or React.",
  integrations: "> Smithers integrations: agent runtimes (Claude Code, Codex, Gemini, Pi), tool surfaces, ecosystem partners.",
  events: "> Smithers event surface: how to subscribe, the event categories, and the full SmithersEvent discriminated union.",
};

const builds: Array<{ file: string; pages: string[]; header: string; name: string }> = [
  { file: "llms-core.txt", pages: CORE_PAGES, header: HEADERS.core, name: "Smithers" },
  { file: "llms-memory.txt", pages: MEMORY_PAGES, header: HEADERS.memory, name: "Smithers Memory" },
  { file: "llms-openapi.txt", pages: OPENAPI_PAGES, header: HEADERS.openapi, name: "Smithers OpenAPI Tools" },
  { file: "llms-observability.txt", pages: OBSERVABILITY_PAGES, header: HEADERS.observability, name: "Smithers Observability" },
  { file: "llms-effect.txt", pages: EFFECT_PAGES, header: HEADERS.effect, name: "Smithers Effect API" },
  { file: "llms-integrations.txt", pages: INTEGRATIONS_PAGES, header: HEADERS.integrations, name: "Smithers Integrations" },
  { file: "llms-events.txt", pages: EVENT_PAGES, header: HEADERS.events, name: "Smithers Events" },
];

let totalBytes = 0;
const fragmentBodies: string[] = [];
for (const b of builds) {
  console.log(`\n→ ${b.file}`);
  const content = renderManifest(b.name, b.pages, b.header);
  writeFileSync(resolve(DOCS, b.file), content);
  const bytes = content.length;
  totalBytes += bytes;
  fragmentBodies.push(content);
  console.log(`  ${bytes.toLocaleString()} bytes (~${Math.round(bytes / 4).toLocaleString()} tokens)`);
}

// -----------------------------------------------------------------------------
// llms-full.txt — concatenation of every fragment.
//
// This is the conventional "full file" most consumers fetch from the docs site.
// llms-core.txt is the trimmed everyday version; llms-full.txt is the kitchen
// sink for tools that want a single artifact.
// -----------------------------------------------------------------------------

{
  const fullHeader = [
    "# Smithers — full documentation",
    "",
    "> Durable AI workflow orchestration as a JSX runtime.",
    "> Repo: github.com/smithersai/smithers · Package: smithers-orchestrator (npm)",
    "",
    "This is the complete agent-facing Smithers documentation in one file. It is the concatenation of every fragment listed in /llms.txt.",
    "",
    "Audience split: humans should read the For Humans Guide on the docs site and talk to their coding agent. Agents should read this file, operate Smithers for the human, verify the run, and report evidence back.",
    "",
    "The everyday agent surface (runtime, JSX, CLI, components, recipes, types, errors) is the first section below; the opt-in topics follow. Only /llms.txt and /llms-full.txt are served on the docs site, so read this file rather than fetching per-topic fragment URLs.",
    "",
    "Sections included in this file:",
    "  1. Core: runtime, JSX, CLI, components, recipes, types",
    "  2. Memory: cross-run memory",
    "  3. OpenAPI tools: tool generation from a spec",
    "  4. Observability: HTTP server, gateway, MCP, OpenTelemetry",
    "  5. Effect: low-level Effect-ts integration",
    "  6. Integrations: agent runtimes, IDE, CI, ecosystem",
    "  7. Events: full SmithersEvent discriminated union",
    "",
    "Changelogs are not included; see /docs/changelogs/ on the docs site.",
    "",
    "===============================================================================",
    "",
  ].join("\n");
  const fullContent = fullHeader + fragmentBodies.join("\n\n===============================================================================\n\n");
  writeFileSync(resolve(DOCS, "llms-full.txt"), fullContent);
  const bytes = fullContent.length;
  console.log(`\n→ llms-full.txt (full concat)`);
  console.log(`  ${bytes.toLocaleString()} bytes (~${Math.round(bytes / 4).toLocaleString()} tokens)`);

  // Mirror the full bundle into the `smithers` agent skill so it ships
  // self-contained (the SKILL.md on-ramp points agents at this file).
  mkdirSync(SKILL_DIR, { recursive: true });
  writeFileSync(resolve(SKILL_DIR, "llms-full.txt"), fullContent);
  console.log(`\n→ skills/smithers/llms-full.txt (bundled copy)`);

  mkdirSync(CLI_DOCS_DIR, { recursive: true });
  writeFileSync(resolve(CLI_DOCS_DIR, "llms-full.txt"), fullContent);
  console.log(`\n→ apps/cli/docs/llms-full.txt (packaged CLI copy)`);

  // Bundle the curated `smithers` SKILL.md alongside the docs so `smithers init`
  // can install the skill from the published tarball (no network, no curl).
  const skillMd = readFileSync(resolve(SKILL_DIR, "SKILL.md"), "utf8");
  writeFileSync(resolve(CLI_DOCS_DIR, "SKILL.md"), skillMd);
  console.log(`\n→ apps/cli/docs/SKILL.md (packaged CLI copy)`);
}

// -----------------------------------------------------------------------------
// llms.txt index
// -----------------------------------------------------------------------------

const indexContent = `# Smithers

Durable AI workflow orchestration as a JSX runtime.

## Audience split

- Human docs: the website's For Humans Guide. Humans use Smithers by talking to
  their coding agent and reading prompt/examples-oriented pages.
- Agent docs: these llms files plus the website's For Agents reference. Agents
  consume this material, run Smithers commands themselves, watch runs, verify
  with backpressure, and report evidence back to the human.

## Documentation

The complete agent bundle is served at [/llms-full.txt](/llms-full.txt). Read it top to
bottom; it contains every topic below in one document. Per-topic fragments are build
artifacts and are not served separately: only /llms.txt and /llms-full.txt resolve on the
docs site.

- Core: runtime, agent operating playbook, JSX surface, CLI, components, recipes, types, errors
- Memory: cross-run memory (facts, history, recall)
- OpenAPI tools: generate AI SDK tools from OpenAPI specs
- Observability: HTTP server, gateway, MCP, OpenTelemetry
- Effect: Effect-ts authoring API (no JSX)
- Integrations: agent runtimes, tools, ecosystem
- Events: full SmithersEvent discriminated union

## Agent operating directive

The human talks to an AI harness; the AI runs Smithers. Do not ask the human to
run commands directly. Translate human outcomes into durable Smithers work,
watch the run, verify with backpressure, and report evidence back in plain
English.

Examples:

- "Build this product idea start to finish" -> interview first, write product and
  engineering specs, add an approval gate, then run implementation milestones.
- "Do not stop until this is production-ready" -> encode tests, reviewer approval,
  evals, and artifact reporting as the finish line.
- "Prove this third-party service works" -> run assumption tests or service probes
  before building product code on top of it.
- "Show me it works" -> capture screenshots, GIFs, video, eval reports, logs,
  traces, and an HTML or Markdown report.
- "What happened to the run?" -> inspect why, events, node output, scores, and
  logs yourself; summarize the blocker and options.
- "Can I watch it?" -> offer the Smithers UI or Gateway-backed custom UI when a
  visual run state would help.

## Pointers

- npm: smithers-orchestrator
- github: github.com/smithersai/smithers
- changelogs: docs/changelogs/ on the site (not duplicated in llms files)
`;

writeFileSync(resolve(DOCS, "llms.txt"), indexContent);
console.log(`\n→ llms.txt (index)`);
console.log(`  ${indexContent.length.toLocaleString()} bytes`);

mkdirSync(CLI_DOCS_DIR, { recursive: true });
writeFileSync(resolve(CLI_DOCS_DIR, "llms.txt"), indexContent);
console.log(`\n→ apps/cli/docs/llms.txt (packaged CLI copy)`);
console.log(`  ${indexContent.length.toLocaleString()} bytes`);

console.log(`\nTotal: ${totalBytes.toLocaleString()} bytes (~${Math.round(totalBytes / 4).toLocaleString()} tokens) across all fragments.`);
