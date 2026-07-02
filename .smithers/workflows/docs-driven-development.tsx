// smithers-display-name: Docs Driven Development
// smithers-description: Maintain a living product spec (features.json + WYSIWYG docs) and run an audit→triage→implement→review improvement loop over it.
/** @jsxImportSource smithers-orchestrator */
import { Approval, createSmithers, Loop, Sequence, Task } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod/v4";
import { providers } from "../agents";
import { dddRootOrCwd } from "../lib/ddd/dddRoot.ts";

// Repo root: walk up from cwd until .smithers/spec/features.json is found, so
// the workflow behaves the same whether launched from the repo root or from
// .smithers/. No absolute machine paths.
const ROOT = dddRootOrCwd();

const planner = providers.claude;
const trivialEditor = providers.claudeSonnet;
const codex = providers.codex;

// One changed-file shape, shared by the editor-submitted input ticket and the
// metaTicket node output so the two can never drift apart.
const changedFileSchema = z.object({
  path: z.string(),
  beforeMarkdown: z.string().default(""),
  afterMarkdown: z.string().default(""),
});

const inputSchema = z.object({
  maxAgents: z.preprocess((value) => value ?? undefined, z.number().int().min(1).max(1).default(1)),
  maxRounds: z.preprocess((value) => value ?? undefined, z.number().int().min(1).max(100000).default(100000)),
  implementationApproved: z.preprocess((value) => value ?? undefined, z.boolean().default(true)),
  requireImplementationApproval: z.preprocess((value) => value ?? undefined, z.boolean().default(false)),
  runImplementation: z.preprocess((value) => value ?? undefined, z.boolean().default(true)),
  useClaudeForPlanning: z.preprocess((value) => value ?? undefined, z.boolean().default(true)),
  metaTicket: z.object({
    title: z.string().default("Docs change triage"),
    source: z.string().default("manual"),
    docPath: z.string().default(".smithers/spec"),
    featureIds: z.array(z.string()).default([]),
    changedFiles: z.array(changedFileSchema).default([]),
    beforeMarkdown: z.string().default(""),
    afterMarkdown: z.string().default(""),
    changedAtIso: z.string().default(""),
  }).optional(),
});

const bootstrapSchema = z.object({
  scaffolded: z.boolean().default(false),
  docsBuildPassed: z.boolean().default(false),
  commandsRun: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const auditSchema = z.object({
  generatedSiteBuilds: z.boolean().default(false),
  featureIds: z.array(z.string()).default([]),
  broken: z.array(z.string()).default([]),
  partial: z.array(z.string()).default([]),
  missingE2E: z.array(z.string()).default([]),
  missingDocs: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});

const specSchema = z.object({
  status: z.enum(["ready", "partial", "blocked"]).default("partial"),
  updatedFiles: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const metaTicketSchema = z.object({
  created: z.boolean().default(false),
  title: z.string().default(""),
  source: z.string().default(""),
  docPath: z.string().default(""),
  featureIds: z.array(z.string()).default([]),
  changedFiles: z.array(changedFileSchema).default([]),
  beforeMarkdown: z.string().default(""),
  afterMarkdown: z.string().default(""),
  gitStatus: z.string().default(""),
  docsDiff: z.string().default(""),
  docsDiffArtifactPath: z.string().default(""),
  docsDiffTruncated: z.boolean().default(false),
  codeDiffFiles: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const triageSchema = z.object({
  selected: z.array(z.object({
    slot: z.number().int().min(1).max(1),
    featureId: z.string(),
    title: z.string(),
    agent: z.enum(["codex", "sonnet", "opus"]),
    taskType: z.enum(["fix", "feature", "e2e", "review", "issue"]),
    reason: z.string(),
    files: z.array(z.string()).default([]),
    tests: z.array(z.string()).default([]),
    acceptance: z.array(z.string()).default([]),
  })).default([]),
  summary: z.string().default(""),
});

const materializedTicketsSchema = z.object({
  created: z.number().int().min(0).default(0),
  directory: z.string().default(""),
  tickets: z.array(z.object({
    path: z.string(),
    kind: z.string().default("ticket"),
    featureId: z.string().default(""),
    featureTitle: z.string().default(""),
    content: z.string(),
    status: z.string().default("todo"),
    updatedAtMs: z.number().default(0),
  })).default([]),
  summary: z.string().default(""),
});

const workSchema = z.object({
  slot: z.number().int().min(1).max(8),
  featureId: z.string().default(""),
  status: z.enum(["done", "partial", "blocked", "skipped"]).default("skipped"),
  filesChanged: z.array(z.string()).default([]),
  testsRun: z.array(z.string()).default([]),
  issuesCreated: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const reviewSchema = z.object({
  approved: z.boolean().default(false),
  blockingFindings: z.array(z.string()).default([]),
  inefficiencies: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const summarySchema = z.object({
  status: z.enum(["done", "partial", "blocked"]).default("partial"),
  fixed: z.array(z.string()).default([]),
  remaining: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  bootstrap: bootstrapSchema,
  audit: auditSchema,
  spec: specSchema,
  metaTicket: metaTicketSchema,
  triage: triageSchema,
  materializedTickets: materializedTicketsSchema,
  work: workSchema,
  review: reviewSchema,
  summary: summarySchema,
});

const CONTEXT = `
This workflow is called docs-driven-development.

Goal:
- Maintain a living spec for SMITHERS (the durable agent control plane this repo builds: engine, scheduler, driver, gateway/server, CLI, agent adapters, memory, time-travel, sandbox/vcs, workflow UIs, observability, docs pipeline) — NOT a spec for this docs-driven-development workflow. This workflow is itself ONE feature within that larger product spec (the docs-driven-development entry in features.json). The spec renders INSIDE the workflow UI (.smithers/ui/docs-driven-development.tsx) from .smithers/spec/features.json (structured source of truth) plus derived per-feature spec docs and a product overview under .smithers/spec/content, edited with a Milkdown Crepe WYSIWYG editor.
- Track feature status, test cases, observability, debugging instructions, architecture docs, fixes, and commit diff hints.
- Audit the spec for broken, missing, partial, or untested features.
- Pick up to the configured maxAgents best next work items every round. Prefer fixing broken P0 features, then partial P0 proof gaps, then missing e2e tests, then high-impact reviews/issues, then new features.
- Use Codex as the main implementation agent. Use Sonnet for trivial bounded docs/code updates and Fable/Opus-class Claude for planning/review when Claude is available; if Claude is rate-limited, resume with useClaudeForPlanning=false so those slots route to Codex.
- This workflow is long-running by design. It should continue round after round until the product spec is fully honest, tested, reviewed, documented, and the only remaining triage items are explicitly low-value/no-op issues.

Architecture constraints:
- No fake success. If a feature cannot be proven, keep it partial/broken/missing-tests.
- Spec source for the smithers product: .smithers/spec/features.json (structured source of truth — the feature matrix). .smithers/spec/content/features/<id>.md are DERIVED from features.json by bun .smithers/lib/ddd/build.ts (regenerated each build — do not hand-edit; change features.json instead). .smithers/spec/content/overview.md is the editable product overview. The spec UI is .smithers/ui/docs-driven-development.tsx.
- Reproducible build/gate command: bun .smithers/lib/ddd/build.ts (run from the repo root). It validates features.json against the zod schema, regenerates the derived feature docs, and regenerates the UI content modules (.smithers/ui/ddd-*.generated.ts).
- maxAgents is capped at 1 until the graph renders matching implementation slots. This avoids triage materializing work that never runs.
- To avoid wasting context, start audits/reviews with "bun .smithers/lib/ddd/auditInputs.ts" and inspect only the listed files plus exact current-run outputs when needed. Do not recursively read .smithers/executions or .smithers/pg.
- To pick next work without re-auditing the repo, start triage with "bun .smithers/lib/ddd/triageCandidates.ts --max <N>". Use it as the bounded ranked candidate list, then inspect only the selected feature's exact files.
- To read a workflow output robustly, use "smithers output <runId> <nodeId>"; use "smithers inspect <runId>" for run-level state.
- Verify claims against the real repo: pnpm typecheck and pnpm -C packages/<pkg> test are the ground-truth gates. Do not print secrets or tokens.
`;

const META_TICKET_FIELD_LIMIT = 12_000;
const BOOTSTRAP_ARTIFACT = `${ROOT}/.smithers/docs-driven-development/bootstrap-latest.json`;

export function artifactPath(name: string) {
  const dir = `${ROOT}/.smithers/docs-driven-development/artifacts`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/${name}`;
}

export function boundedField(value: string, name: string) {
  if (value.length <= META_TICKET_FIELD_LIMIT) {
    return { value, artifactPath: "", truncated: false };
  }
  const path = artifactPath(`${name}-${Date.now()}.txt`);
  writeFileSync(path, value);
  return {
    value: `${value.slice(0, META_TICKET_FIELD_LIMIT)}\n...[truncated ${value.length - META_TICKET_FIELD_LIMIT} chars; full value: ${path}]`,
    artifactPath: path,
    truncated: true,
  };
}

export function writeJsonArtifact(path: string, value: unknown) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function cleanDiffForMetaTicket(value: string) {
  const ignored = (line: string) => {
    const lower = line.toLowerCase();
    return (
      lower.includes(".smithers/spec/content/features/") ||
      lower.includes(".smithers/ui/ddd-") ||
      lower.includes(".smithers/workflows/docs-driven-development.tsx") ||
      lower.includes(".smithers/ui/docs-driven-development.tsx") ||
      lower.includes(".smithers/lib/ddd/")
    );
  };
  const out: string[] = [];
  let skippingDiff = false;
  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      skippingDiff = ignored(line);
      if (!skippingDiff) out.push(line);
      continue;
    }
    if (skippingDiff) continue;
    if (!ignored(line)) out.push(line);
  }
  return out.join("\n").trim();
}

function runCommand(command: string, args: string[]) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
}

function tryRunCommand(command: string, args: string[]) {
  try {
    return runCommand(command, args);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function ticketSlug(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "ticket";
}

export function ticketPathFor(runId: string, item: any): string {
  return `docs-driven-development--${ticketSlug(runId)}--${String(item.slot ?? "0").padStart(2, "0")}-${ticketSlug(item.featureId ?? item.title)}`;
}

export function ticketMarkdownFor(runId: string, item: any): string {
  const list = (title: string, values: unknown) => {
    const items = Array.isArray(values) ? values.map(String).filter(Boolean) : [];
    return items.length ? `\n## ${title}\n\n${items.map((value) => `- ${value}`).join("\n")}\n` : "";
  };

  return [
    `# ${item.title || item.featureId || `Triage slot ${item.slot}`}`,
    "",
    `Status: todo`,
    `Run: ${runId}`,
    `Slot: ${item.slot ?? ""}`,
    `Feature: ${item.featureId ?? ""}`,
    item.featureTitle ? `Feature title: ${item.featureTitle}` : "",
    `Agent: ${item.agent ?? ""}`,
    `Task type: ${item.taskType ?? item.task_type ?? ""}`,
    "",
    "## Reason",
    "",
    String(item.reason ?? "No reason recorded."),
    list("Files", item.files),
    list("Tests", item.tests),
    list("Acceptance", item.acceptance),
  ].filter((line) => line !== "").join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function materializeTriageTickets(runId: string, triage: any) {
  const directory = `${ROOT}/.smithers/tickets`;
  mkdirSync(directory, { recursive: true });
  const now = Date.now();
  const selected = Array.isArray(triage?.selected) ? triage.selected : [];
  const featureTitles = featureTitleById();
  const tickets = selected.map((item: any) => {
    const featureId = String(item.featureId ?? item.feature_id ?? "");
    const featureTitle = String(item.featureTitle ?? item.feature_title ?? featureTitles.get(featureId) ?? "");
    const enriched = { ...item, featureId, featureTitle };
    const path = ticketPathFor(runId, enriched);
    const content = ticketMarkdownFor(runId, enriched);
    writeFileSync(`${directory}/${path}.md`, content);
    return { path, kind: "ticket", featureId, featureTitle, content, status: "todo", updatedAtMs: now };
  });
  return {
    created: tickets.length,
    directory,
    tickets,
    summary: tickets.length
      ? `Materialized ${tickets.length} triage ticket(s) into ${directory}.`
      : "No triage selections were available to materialize.",
  };
}

function featureTitleById(): Map<string, string> {
  try {
    const rows = JSON.parse(readFileSync(`${ROOT}/.smithers/spec/features.json`, "utf8")) as Array<{ id?: string; title?: string }>;
    return new Map(rows.map((row): [string, string] => [String(row.id ?? ""), String(row.title ?? "")]).filter(([id]) => id));
  } catch {
    return new Map();
  }
}

export function triageReady(ctx: any): boolean {
  return !!ctx.outputMaybe("triage", { nodeId: "triage" });
}

export function resolvedMaxAgents(value: unknown) {
  const numeric = Number(value ?? 1);
  if (!Number.isInteger(numeric)) return 1;
  return 1;
}

export function resolvedMaxRounds(value: unknown) {
  const numeric = Number(value);
  return numeric >= 1 ? numeric : 100000;
}

export function agentForSlot(ctx: any, slot: number) {
  const triage = ctx.outputMaybe("triage", { nodeId: "triage" });
  const selected = triage?.selected?.find((item: any) => item.slot === slot);
  if (selected?.agent === "opus") return ctx.input.useClaudeForPlanning ? planner : codex;
  if (selected?.agent === "sonnet") return ctx.input.useClaudeForPlanning ? trivialEditor : codex;
  return codex;
}

export function planningAgent(ctx: any) {
  return ctx.input.useClaudeForPlanning ? planner : codex;
}

export function auditAgent(ctx: any) {
  return ctx.input.useClaudeForPlanning ? trivialEditor : codex;
}

// The loop must NOT exit on a single round-summary "done" — a flaky/empty audit
// makes round-summary report done while features.json still has gaps (observed
// in the reference implementation: run finished with 38/52 features
// partial/broken/missing). features.json is the source of truth, so require it
// to actually be clean before declaring complete.
export function featuresStillIncomplete(): number {
  try {
    const features = JSON.parse(readFileSync(`${ROOT}/.smithers/spec/features.json`, "utf8")) as Array<{ status?: string }>;
    // Exactly the open statuses featuresSchema.ts can produce ("fixed" is the
    // only closed state).
    const open = new Set(["broken", "partial", "missing", "missing-tests"]);
    return features.filter((feature) => open.has(String(feature.status))).length;
  } catch {
    return -1; // unreadable → don't claim completion on a read error
  }
}

export function productComplete(ctx: any): boolean {
  const summary = ctx.outputMaybe("summary", { nodeId: "round-summary" });
  if (summary?.status !== "done") return false;
  const incomplete = featuresStillIncomplete();
  // Trust "done" only when features.json corroborates it (0 open features).
  return incomplete === 0;
}

function workSlotPrompt(ctx: any, slot: number) {
  return (deps: any) => {
    const selected = deps.triage?.selected?.find((item: any) => item.slot === slot);
    return selected
      ? `Implement or execute triage slot ${slot}. Return only JSON matching the work schema.

Selected item:
${JSON.stringify(selected, null, 2)}

Requirements:
- Operate in the smithers repo root. Sonnet/Opus selections use Claude when useClaudeForPlanning=true and automatically route to Codex when the run is resumed with useClaudeForPlanning=false.
- Make the feature status in .smithers/spec/features.json more true, not more optimistic.
- Update the spec if tests, observability, debug instructions, architecture, fixes, or diffs changed, then run bun .smithers/lib/ddd/build.ts and keep features.json valid.
- Run the selected tests where feasible and list exact commands (pnpm -C packages/<pkg> test, pnpm typecheck).
- If the selected item is docs-driven-development itself, do not recursively start another docs-driven-development workflow from inside work:${slot}; use the current run's upstream node outputs as proof and return partial if downstream round-summary readback cannot be proven until this work node finishes.
- NEVER edit the orchestration source of THIS running workflow: .smithers/workflows/docs-driven-development.tsx and .smithers/lib/ddd/*.ts are OFF-LIMITS. Editing them mid-run corrupts the live run — it has caused dependency-deadlock deaths, module-hash drift, and premature single-round exits. The docs-driven-development feature's PRODUCT surface (its UI under .smithers/ui/, the rendered spec under .smithers/spec) is fair game; the workflow engine + scripts are not. If you find a real bug in the workflow/scripts, DO NOT fix it here — record it precisely in your summary so a human can apply it between runs.
- If this is a review/issue task, create concrete issue records in the spec metadata (features.json missing[]) or report blocked with exact findings.
- Do not print secrets or tokens.

${CONTEXT}`
      : `No triage item selected for slot ${slot}. Return JSON with slot ${slot}, status "skipped", and a short summary.`;
  };
}

export function roundSummaryFromDeps(deps: any) {
  const workItems = Array.isArray(deps.work) ? deps.work : deps.work ? [deps.work] : [];
  const fixed = workItems
    .filter((item: any) => item?.status === "done")
    .map((item: any) => `${item.featureId || "unknown"}: ${item.summary || "completed"}`);
  const remaining = [
    ...(deps.audit?.broken ?? []).map((id: string) => `broken: ${id}`),
    ...(deps.audit?.partial ?? []).map((id: string) => `partial: ${id}`),
    ...(deps.audit?.missingE2E ?? deps.audit?.missing_e2e ?? []).map((id: string) => `missing e2e: ${id}`),
    ...(deps.audit?.missingDocs ?? deps.audit?.missing_docs ?? []).map((id: string) => `missing docs: ${id}`),
    ...workItems
      .filter((item: any) => item?.status && item.status !== "done" && item.status !== "skipped")
      .map((item: any) => `${item.status}: ${item.featureId || "unknown"} - ${item.summary || "not complete"}`),
    ...(deps.review?.blockingFindings ?? deps.review?.blocking_findings ?? []).map((finding: string) => `review blocker: ${finding}`),
  ];
  const blocked = (deps.review?.blockingFindings ?? deps.review?.blocking_findings ?? []).length > 0;
  const done =
    remaining.length === 0 &&
    deps.review?.approved === true &&
    workItems.length > 0 &&
    workItems.every((item: any) => item?.status === "done");

  return {
    status: done ? "done" : blocked ? "blocked" : "partial",
    fixed,
    remaining,
    summary: done
      ? "All tracked P0/P1 features are complete, tested, documented, and reviewed."
      : "Cycle complete, but tracked features still have broken, partial, missing-test, missing-doc, or review follow-up items. Continue the improvement loop.",
  };
}

export default smithers((ctx) => {
  // Robust against inputs that arrive without zod defaults applied: implementation
  // runs unless explicitly disabled, so the work wave is never silently skipped.
  const maxAgents = resolvedMaxAgents(ctx.input.maxAgents);
  // Bulletproof: Number(null)===0 and Number(undefined)===NaN both fall through to
  // the floor, so maxIterations can never be 0/null (which silently caps the loop
  // at a single iteration — observed when a stale self-edited module dropped the
  // fallback). Only an explicit >=1 input overrides the long-running default.
  const maxRounds = resolvedMaxRounds(ctx.input.maxRounds);
  const runImplementation = ctx.input.runImplementation !== false;
  const requireImplementationApproval = ctx.input.requireImplementationApproval === true;
  const implementationApproved = ctx.input.implementationApproved !== false;
  const approvalRequired = runImplementation && requireImplementationApproval && !implementationApproved;
  const workApproved =
    runImplementation &&
    (implementationApproved || !requireImplementationApproval || approvalRequired);

  return (
    <Workflow name="docs-driven-development">
      <Loop id="improvement-loop" until={productComplete(ctx)} maxIterations={maxRounds} onMaxReached="return-last">
        <Sequence>
          <Task id="bootstrap" output={outputs.bootstrap}>
            {async () => {
              const commandsRun: string[] = [];
              try {
                runCommand("bun", [".smithers/lib/ddd/build.ts"]);
                commandsRun.push("bun .smithers/lib/ddd/build.ts");
                const output = {
                  scaffolded: true,
                  docsBuildPassed: true,
                  commandsRun,
                  summary: "features.json validated, derived feature docs regenerated, and UI content modules rebuilt reproducibly.",
                };
                writeJsonArtifact(BOOTSTRAP_ARTIFACT, output);
                return output;
              } catch (error) {
                commandsRun.push("bun .smithers/lib/ddd/build.ts");
                const message = error instanceof Error ? error.message : String(error);
                const output = {
                  scaffolded: true,
                  docsBuildPassed: false,
                  commandsRun,
                  summary: `Spec build failed: ${message}`,
                };
                writeJsonArtifact(BOOTSTRAP_ARTIFACT, output);
                return output;
              }
            }}
          </Task>

          <Task id="metaTicket" output={outputs.metaTicket} dependsOn={["bootstrap"]}>
            {async () => {
              const ticket = ctx.input.metaTicket;
              const gitStatus = tryRunCommand("git", ["status", "--short"]);
              const fullDocsDiff = cleanDiffForMetaTicket(tryRunCommand("git", ["diff", "--", ".smithers/spec"]));
              const docsDiff = boundedField(fullDocsDiff, "meta-ticket-docs-diff");
              const codeDiffFiles = tryRunCommand("git", ["diff", "--name-only", "--", "packages", "apps", "docs", "e2e", "package.json"])
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);

              if (!ticket) {
                return {
                  created: false,
                  gitStatus,
                  docsDiff: docsDiff.value,
                  docsDiffArtifactPath: docsDiff.artifactPath,
                  docsDiffTruncated: docsDiff.truncated,
                  codeDiffFiles,
                  summary: "No editor-created docs change was submitted. Triage should use the current spec and codebase state.",
                };
              }

              return {
                created: true,
                title: ticket.title,
                source: ticket.source,
                docPath: ticket.docPath,
                featureIds: ticket.featureIds,
                changedFiles: ticket.changedFiles,
                beforeMarkdown: ticket.beforeMarkdown,
                afterMarkdown: ticket.afterMarkdown,
                gitStatus,
                docsDiff: docsDiff.value,
                docsDiffArtifactPath: docsDiff.artifactPath,
                docsDiffTruncated: docsDiff.truncated,
                codeDiffFiles,
                summary: `Editor-created docs change for ${ticket.docPath}. Triage should turn this docs delta plus current code state into implementation, e2e, review, or issue tickets.`,
              };
            }}
          </Task>

          <Task id="audit" output={outputs.audit} agent={auditAgent(ctx)} retries={1} timeoutMs={20 * 60 * 1000} dependsOn={["metaTicket"]}>
            {`Audit the current docs-driven-development spec state. Start with "bun .smithers/lib/ddd/auditInputs.ts" and read only the listed bounded inputs unless a specific gap requires one more file. Read .smithers/spec/features.json and the derived content. Inspect the meta-ticket output first; if it was created from the docs editor, include that requested docs delta in your audit. The workflow already ran "bun .smithers/lib/ddd/build.ts"; check the bootstrap node output (or .smithers/docs-driven-development/bootstrap-latest.json) before deciding generatedSiteBuilds, which means "the ddd build gate passed". Return only JSON matching the audit schema. ${CONTEXT}`}
          </Task>

          <Task id="spec-update" output={outputs.spec} agent={codex} retries={1} timeoutMs={40 * 60 * 1000} dependsOn={["audit", "metaTicket"]} deps={{ audit: outputs.audit, metaTicket: outputs.metaTicket }}>
            {(deps: any) => `Update the smithers product spec so it reflects the audit honestly. The source of truth is .smithers/spec/features.json — edit it (feature status, summary, tests, observability, debug, architecture, changes/diffHints, missing) for the real product features. PRESERVE the organization fields on every record — tier, group, userValue, capabilities, endpoints, links — never drop them. tier is "feature" (end-user-facing), "platform" (infra that gates production confidence), or "reference" (a shared doc surfaced as a record). group is an END-USER JOURNEY (e.g. "Author workflows", "Run & observe", "Recover & replay", "Ship & review", "Platform & delivery") — it is NOT an owner/team name. Keep userValue (one end-user sentence), capabilities (drill-down), endpoints, and links; every link href must resolve to an existing content file (reference/<doc>.md#anchor or features/<id>.md) or a full URL. .smithers/spec/content/features/<id>.md are DERIVED from features.json (regenerated by bun .smithers/lib/ddd/build.ts — never hand-edit them); .smithers/spec/content/overview.md is the editable product overview. If the meta-ticket was created by the docs editor, apply that intent to features.json (or overview.md) only where it is supported by the current codebase/diffs; otherwise record it as a missing or broken gap. Keep the spec about the smithers product, not about this workflow (which is just the docs-driven-development feature). After editing, run bun .smithers/lib/ddd/build.ts and keep features.json valid. Return only JSON matching the spec schema.

Audit:
${JSON.stringify(deps.audit, null, 2)}

Meta ticket:
${JSON.stringify(deps.metaTicket, null, 2)}

${CONTEXT}`}
          </Task>

          <Task id="triage" output={outputs.triage} agent={planningAgent(ctx)} retries={1} timeoutMs={30 * 60 * 1000} dependsOn={["spec-update"]}>
            {`Plan the next docs-driven-development round. First run "bun .smithers/lib/ddd/triageCandidates.ts --max ${Math.max(maxAgents * 4, 4)}" and use that bounded ranked list instead of re-auditing the entire repo. Read the meta-ticket output before selecting slots. If it contains a docs-editor change, triage tickets based on that latest docs delta, the recorded docs diff, and the current codebase state. Pick at most ${maxAgents} work items. Slots must be numbered 1..${maxAgents}. Prefer broken P0 fixes, then partial P0 proof gaps, then missing e2e tests, then high-impact reviews/issues, then new features. Choose "codex" for most implementation/review tasks, "sonnet" for trivial bounded docs/code updates, and "opus" when planning/review judgment is the work item. The runtime uses Claude for sonnet/opus while useClaudeForPlanning=true and routes those same slots to Codex when the run is resumed with useClaudeForPlanning=false after a Claude rate limit. Never select pointless issues unless the product is otherwise fully built, tested, documented, and reviewed. Return only JSON matching the triage schema. ${CONTEXT}`}
          </Task>

          <Task
            id="materialize-tickets"
            output={outputs.materializedTickets}
            dependsOn={["triage"]}
            deps={{ triage: outputs.triage }}
          >
            {(deps: any) => materializeTriageTickets(String((ctx as any).runId ?? (ctx.input as any).runId ?? "unknown-run"), deps.triage)}
          </Task>

          {triageReady(ctx) && approvalRequired ? (
            <Approval
              id="approve-implementation"
              output={outputs.review}
              request={{
                title: "Approve docs-driven-development implementation wave?",
                summary: "Review the triage output. Approve to launch the implementation/review agent wave.",
              }}
              onDeny="fail"
            />
          ) : null}

          {/* Implementation wave. Rendered as a single direct Sequence Task (like
              audit/triage) so it ALWAYS materializes — a dynamic Parallel of custom
              components was being dropped by the renderer, silently skipping
              implementation. maxAgents>1 fan-out is intentionally not used here
              (SQLite-backed default is 1 agent). */}
          {workApproved ? (
            <Task
              id="work:1"
              output={outputs.work}
              agent={agentForSlot(ctx, 1)}
              retries={1}
              timeoutMs={60 * 60 * 1000}
              heartbeatTimeoutMs={20 * 60 * 1000}
              dependsOn={approvalRequired ? ["materialize-tickets", "approve-implementation"] : ["materialize-tickets"]}
              deps={{ triage: outputs.triage }}
            >
              {workSlotPrompt(ctx, 1)}
            </Task>
          ) : null}

          <Task id="cycle-review" output={outputs.review} agent={planningAgent(ctx)} retries={1} timeoutMs={20 * 60 * 1000} dependsOn={workApproved ? ["work:1"] : ["triage"]}>
            {`Review this entire docs-driven-development cycle. Start with "bun .smithers/lib/ddd/auditInputs.ts" for bounded inputs and read this run's node outputs (smithers output <runId> <nodeId>) before reading raw traces. Check whether the workflow itself wasted work, stopped too early, selected the wrong agents, failed to test, or failed to update the spec honestly. Set approved=true only if the cycle made genuine forward progress or accurately identified the next blocker. List inefficiencies with concrete script fixes. Return only JSON matching the review schema. ${CONTEXT}`}
          </Task>

          <Task
            id="round-summary"
            output={outputs.summary}
            dependsOn={["cycle-review"]}
            // The deps KEY resolves to the upstream task id unless remapped with
            // needs. audit/triage keys already match their task ids; review/spec/
            // materializedTickets/work do NOT (cycle-review, spec-update,
            // materialize-tickets, work:1) — remap them or the graph deadlocks.
            // work:1 only exists when workApproved, so its dep is conditional.
            needs={{
              review: "cycle-review",
              spec: "spec-update",
              materializedTickets: "materialize-tickets",
              ...(workApproved ? { work: "work:1" } : {}),
            }}
            deps={{
              audit: outputs.audit,
              review: outputs.review,
              spec: outputs.spec,
              triage: outputs.triage,
              materializedTickets: outputs.materializedTickets,
              ...(workApproved ? { work: outputs.work } : {}),
            }}
          >
            {roundSummaryFromDeps}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
