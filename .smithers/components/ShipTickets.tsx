// smithers-source: authored
/** @jsxImportSource smithers-orchestrator */
import { Sequence, Task, Worktree, type AgentLike } from "smithers-orchestrator";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { z } from "zod/v4";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "./ValidationLoop";
import { reviewOutputSchema } from "./Review";
import ResearchPrompt from "../prompts/research.mdx";
import PlanPrompt from "../prompts/plan.mdx";

export const researchOutputSchema = z.looseObject({
  summary: z.string(),
  keyFindings: z.array(z.string()).default([]),
});

export const planOutputSchema = z.looseObject({
  summary: z.string(),
  steps: z.array(z.string()).default([]),
});

export const shipResultSchema = z.object({
  ticketId: z.string(),
  branch: z.string(),
  status: z.enum(["merged", "skipped", "failed"]),
  summary: z.string(),
});

export const manifestSchema = z.object({
  ticketsDir: z.string(),
  tickets: z.array(z.object({ slug: z.string(), title: z.string(), id: z.string() })).default([]),
});

// The agent roles ShipTickets uses. The pack's `agents` registry satisfies this.
export type ShipTicketsAgents = {
  smart: AgentLike[];
  smartTool: AgentLike[];
  cheapFast: AgentLike[];
  research: AgentLike[];
  planning: AgentLike[];
  midTier: AgentLike[];
  /** Codex Luna implementation tier. */
  implement: AgentLike[];
  /** Codex Sol review tier. */
  review: AgentLike[];
};

/** Pull a human title from a ticket's frontmatter or first H1, falling back to the slug. */
function parseTitle(content: string, fallback: string): string {
  const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|\s*$)/);
  const title = fm?.[1].match(/^title:\s*(.+)$/m);
  if (title) return title[1].replace(/^["']|["']$/g, "").trim();
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fallback;
}

function safeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "ticket"
  );
}

function pathHash(value: string): string {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 8);
}

function discoverTickets(ticketsDir: string): Array<{ id: string; slug: string; title: string; content: string }> {
  const out: Array<{ id: string; slug: string; title: string; content: string }> = [];

  function walk(dir: string, depth: number): void {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      if (e.name.toLowerCase() === "readme.md") continue;
      const rel = relative(ticketsDir, full);
      const slug = safeSlug(rel.replace(/\.md$/, "").replace(/[/\\]/g, "-"));
      const content = readFileSync(full, "utf8");
      out.push({ id: relative(process.cwd(), full), slug, title: parseTitle(content, slug), content });
    }
  }

  walk(ticketsDir, 0);
  out.sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set<string>();
  for (const ticket of out) {
    if (seen.has(ticket.slug)) {
      const stem = `${ticket.slug}-${pathHash(ticket.id)}`;
      ticket.slug = stem;
      let disambiguator = 2;
      while (seen.has(ticket.slug)) ticket.slug = `${stem}-${disambiguator++}`;
    }
    seen.add(ticket.slug);
  }
  return out;
}

function rawRows(ctx: any, table: string): any[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(table) : ctx.outputs?.[table];
  return Array.isArray(rows) ? rows : [];
}

type RawIteration = { iteration: number; iterationCount: number };

function rawIteration(row: any): RawIteration {
  const iteration = Number.isFinite(Number(row?.iteration)) ? Number(row.iteration) : 0;
  const iterationCount = Number.isFinite(Number(row?.iterationCount)) ? Number(row.iterationCount) : iteration;
  return { iteration, iterationCount };
}

function latestRaw(rows: any[], nodeId: string): any | undefined {
  return rows
    .filter((row) => row?.nodeId === nodeId)
    .reduce((best, row) => {
      if (!best) return row;
      const current = rawIteration(row);
      const previous = rawIteration(best);
      return current.iterationCount > previous.iterationCount ||
        (current.iterationCount === previous.iterationCount && current.iteration >= previous.iteration)
        ? row
        : best;
    }, undefined);
}

/** Per-ticket done/feedback, scoped by slug and paired by current iteration. */
function buildFeedback(ctx: any, slug: string): { feedback: string | null; done: boolean } {
  const validate = latestRaw(rawRows(ctx, "validate"), `${slug}:validate`);
  const review = latestRaw(rawRows(ctx, "review"), `${slug}:review:0`);
  const validateVersion = validate ? rawIteration(validate) : null;
  const reviewVersion = review ? rawIteration(review) : null;
  const sameIteration =
    validateVersion !== null &&
    reviewVersion !== null &&
    validateVersion.iteration === reviewVersion.iteration &&
    validateVersion.iterationCount === reviewVersion.iterationCount;

  const validationPassed = sameIteration && validate?.allPassed === true;
  const reviewApproved = sameIteration && review?.approved === true;
  const done = validationPassed && reviewApproved;

  const parts: string[] = [];
  if (validate?.allPassed === false && validate.failingSummary) {
    parts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  if (sameIteration && review?.approved === false) {
    parts.push(`REVIEWER REJECTED:\n${review.feedback}`);
    for (const issue of review.issues ?? []) {
      parts.push(`  [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
    }
  }
  return { feedback: parts.length > 0 ? parts.join("\n\n") : null, done };
}

const mergePrompt = (slug: string, ticketId: string, baseBranch: string) =>
  `You are landing ONE ticket's work onto ${baseBranch} with a commit-then-merge cadence.

Worktree: ${join(process.cwd(), ".worktrees", `ship-${slug}`)}  (branch: ship/${slug})
Ticket file: ${ticketId}

Do exactly this:
1. Inspect the changed paths in the worktree (${join(process.cwd(), ".worktrees", `ship-${slug}`)}) and stage only the intended ticket files with explicit \`git add -- <path>...\`; never use \`git add -A\` or blanket staging. If there is nothing to commit, set status "skipped" and stop. Otherwise commit with the repo's emoji + conventional-commit style — e.g. "✨ feat(ultragrill): <ticket title>" — ending with the Co-Authored-By trailer. Preserve unrelated shared changes.
2. Return to the main repo root, ensure ${baseBranch} is checked out and clean, and merge ship/${slug} into ${baseBranch} (fast-forward if possible, otherwise --no-ff).
3. If there are conflicts, resolve them favoring correctness and the ticket's intent.
4. Keep the gate green: run \`pnpm typecheck\` plus any directly relevant tests, and fix anything the merge broke before finishing.
5. Do NOT push. Work only locally on ${baseBranch}.

Report status "merged" on success or "failed" if you could not land it cleanly, with a one-line summary.`;

function renderTicket(
  ctx: any,
  ticket: { id: string; slug: string; title: string; content: string },
  baseBranch: string,
  tdd: boolean,
  agents: ShipTicketsAgents,
) {
  const { slug } = ticket;
  const research = ctx.outputMaybe("research", { nodeId: `${slug}:research` });
  const plan = ctx.outputMaybe("plan", { nodeId: `${slug}:plan` });
  const { feedback, done } = buildFeedback(ctx, slug);

  const base = `Implement the ticket below.\n\nTICKET FILE: ${ticket.id}\n\n${ticket.content}`;

  const researchBlock = research
    ? `RESEARCH FINDINGS:\n${research.summary}\n\nKey findings:\n${research.keyFindings.map((f: string) => `- ${f}`).join("\n")}`
    : null;

  const planPrompt = [
    base,
    researchBlock,
    tdd ? "IMPORTANT: Write tests FIRST. The plan MUST start with test steps before any implementation steps." : null,
  ]
    .filter(Boolean)
    .join("\n\n---\n");

  const implementPrompt = [
    base,
    researchBlock,
    plan
      ? `IMPLEMENTATION PLAN:\n${plan.summary}\n\nSteps:\n${plan.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`
      : null,
    tdd ? "IMPORTANT: Follow the plan's test-first approach — tests before production code." : null,
  ]
    .filter(Boolean)
    .join("\n\n---\n");

  return (
    <Sequence key={slug}>
      <Worktree
        path={join(process.cwd(), ".worktrees", `ship-${slug}`)}
        branch={`ship/${slug}`}
        baseBranch={baseBranch}
      >
        <Sequence>
          <Task id={`${slug}:research`} output={researchOutputSchema} agent={agents.research}>
            <ResearchPrompt prompt={base} />
          </Task>
          <Task id={`${slug}:plan`} output={planOutputSchema} agent={agents.planning}>
            <PlanPrompt prompt={planPrompt} />
          </Task>
          <ValidationLoop
            idPrefix={slug}
            prompt={implementPrompt}
            implementAgents={agents.implement}
            validateAgents={agents.midTier}
            reviewAgents={[agents.review]}
            feedback={feedback}
            done={done}
            maxIterations={3}
          />
        </Sequence>
      </Worktree>

      {done && (
        <Task id={`${slug}:merge`} output={shipResultSchema} agent={agents.implement} continueOnFail>
          {mergePrompt(slug, ticket.id, baseBranch)}
        </Task>
      )}
    </Sequence>
  );
}

export type ShipTicketsProps = {
  ctx: any;
  ticketsDir: string;
  baseBranch: string;
  tdd: boolean;
  agents: ShipTicketsAgents;
};

/**
 * Discover the ticket queue in `ticketsDir` and ship each ticket SERIALLY:
 * research → plan → implement → validate → review in its own git worktree, then
 * commit + merge onto `baseBranch` — so the branch advances one ticket at a time
 * and later tickets build on already-landed work. The `manifest` task publishes
 * the full ordered list so a monitoring UI can render the whole pipeline,
 * including not-yet-started tickets, from one read. Tickets are re-discovered
 * each render frame, so the pipeline self-populates once an upstream step
 * (e.g. VerifiableGoals) writes the queue.
 */
export function ShipTickets({ ctx, ticketsDir, baseBranch, tdd, agents }: ShipTicketsProps) {
  const tickets = discoverTickets(resolve(process.cwd(), ticketsDir));

  return (
    <Sequence>
      <Task id="manifest" output={manifestSchema}>
        {{
          ticketsDir,
          tickets: tickets.map((t) => ({ slug: t.slug, title: t.title, id: t.id })),
        }}
      </Task>
      {tickets.map((ticket) => renderTicket(ctx, ticket, baseBranch, tdd, agents))}
    </Sequence>
  );
}
