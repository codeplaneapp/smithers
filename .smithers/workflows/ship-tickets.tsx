// smithers-source: authored
// smithers-display-name: Ship Tickets
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Worktree } from "smithers-orchestrator";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";
import ResearchPrompt from "../prompts/research.mdx";
import PlanPrompt from "../prompts/plan.mdx";

const researchOutputSchema = z.looseObject({
  summary: z.string(),
  keyFindings: z.array(z.string()).default([]),
});

const planOutputSchema = z.looseObject({
  summary: z.string(),
  steps: z.array(z.string()).default([]),
});

const shipResultSchema = z.object({
  ticketId: z.string(),
  branch: z.string(),
  status: z.enum(["merged", "skipped", "failed"]),
  summary: z.string(),
});

const manifestSchema = z.object({
  ticketsDir: z.string(),
  tickets: z.array(z.object({ slug: z.string(), title: z.string(), id: z.string() })).default([]),
});

const inputSchema = z.object({
  ticketsDir: z.string().default(".smithers/tickets/ultragrill"),
  baseBranch: z.string().default("main"),
  tdd: z.boolean().default(false),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  research: researchOutputSchema,
  plan: planOutputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  shipResult: shipResultSchema,
  manifest: manifestSchema,
});

/** Pull a human title from a ticket's frontmatter or first H1, falling back to the slug. */
function parseTitle(content: string, fallback: string): string {
  const fm = content.match(/^title:\s*(.+)$/m);
  if (fm) return fm[1].replace(/^["']|["']$/g, "").trim();
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return fallback;
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
      const slug = rel.replace(/\.md$/, "").replace(/[/\\]/g, "__");
      const content = readFileSync(full, "utf8");
      out.push({ id: relative(process.cwd(), full), slug, title: parseTitle(content, slug), content });
    }
  }

  walk(ticketsDir, 0);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Per-ticket done/feedback, scoped by slug — review rows share one table. */
function buildFeedback(ctx: any, slug: string): { feedback: string | null; done: boolean } {
  const validate = ctx.outputMaybe("validate", { nodeId: `${slug}:validate` });
  const reviews = (ctx.outputs.review ?? []).filter(
    (r: any) => typeof r.nodeId === "string" && r.nodeId.startsWith(`${slug}:review:`),
  );

  const validationPassed = validate !== undefined && validate.allPassed !== false;
  const anyReviewApproved = reviews.length > 0 && reviews.some((r: any) => r.approved === true);
  const done = validationPassed && anyReviewApproved;

  if (validate === undefined) return { feedback: null, done: false };

  const parts: string[] = [];
  if (!validationPassed && validate.failingSummary) {
    parts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  for (const review of reviews) {
    if (review.approved === false) {
      parts.push(`REVIEWER REJECTED:\n${review.feedback}`);
      for (const issue of review.issues ?? []) {
        parts.push(`  [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
      }
    }
  }
  return { feedback: parts.length > 0 ? parts.join("\n\n") : null, done };
}

const mergePrompt = (slug: string, ticketId: string, baseBranch: string) =>
  `You are landing ONE ticket's work onto ${baseBranch} with a commit-then-merge cadence.

Worktree: .worktrees/ship-${slug}  (branch: ship/${slug})
Ticket file: ${ticketId}

Do exactly this, using bash:
1. cd into the worktree (.worktrees/ship-${slug}) and run \`git add -A\`. If there is nothing to commit, set status "skipped" and stop. Otherwise commit with the repo's emoji + conventional-commit style — e.g. "✨ feat(ultragrill): <ticket title>" — ending with the Co-Authored-By trailer.
2. Return to the main repo root, ensure ${baseBranch} is checked out and clean, and merge ship/${slug} into ${baseBranch} (fast-forward if possible, otherwise --no-ff).
3. If there are conflicts, resolve them favoring correctness and the ticket's intent.
4. Keep the gate green: run \`pnpm typecheck\` plus any directly relevant tests, and fix anything the merge broke before finishing.
5. Do NOT push. Work only locally on ${baseBranch}.

Report status "merged" on success or "failed" if you could not land it cleanly, with a one-line summary.`;

function renderTicket(ctx: any, ticket: { id: string; slug: string; title: string; content: string }) {
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
    ctx.input.tdd ? "IMPORTANT: Write tests FIRST. The plan MUST start with test steps before any implementation steps." : null,
  ].filter(Boolean).join("\n\n---\n");

  const implementPrompt = [
    base,
    researchBlock,
    plan ? `IMPLEMENTATION PLAN:\n${plan.summary}\n\nSteps:\n${plan.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}` : null,
    ctx.input.tdd ? "IMPORTANT: Follow the plan's test-first approach — tests before production code." : null,
  ].filter(Boolean).join("\n\n---\n");

  return (
    <Sequence key={slug}>
      <Worktree path={`.worktrees/ship-${slug}`} branch={`ship/${slug}`} baseBranch={ctx.input.baseBranch}>
        <Sequence>
          <Task id={`${slug}:research`} output={researchOutputSchema} agent={agents.smartTool}>
            <ResearchPrompt prompt={base} />
          </Task>
          <Task id={`${slug}:plan`} output={planOutputSchema} agent={agents.smart}>
            <PlanPrompt prompt={planPrompt} />
          </Task>
          <ValidationLoop
            idPrefix={slug}
            prompt={implementPrompt}
            implementAgents={agents.smart}
            validateAgents={agents.cheapFast}
            reviewAgents={agents.smart}
            feedback={feedback}
            done={done}
            maxIterations={3}
          />
        </Sequence>
      </Worktree>

      {/* Outside the worktree: commit the branch and merge it into the base branch. */}
      <Task id={`${slug}:merge`} output={outputs.shipResult} agent={agents.smart} continueOnFail>
        {mergePrompt(slug, ticket.id, ctx.input.baseBranch)}
      </Task>
    </Sequence>
  );
}

export default smithers((ctx) => {
  const tickets = discoverTickets(resolve(process.cwd(), ctx.input.ticketsDir));

  return (
    <Workflow name="ship-tickets">
      {/* Serial: each ticket is fully implemented, committed, and merged to the
          base branch before the next one starts — so main advances per commit
          and later tickets build on already-landed work. */}
      <Sequence>
        {/* Manifest: the full ordered ticket list, so the monitoring UI can render
            the whole pipeline — including not-yet-started tickets — from one read. */}
        <Task id="manifest" output={outputs.manifest}>
          {{
            ticketsDir: ctx.input.ticketsDir,
            tickets: tickets.map((t) => ({ slug: t.slug, title: t.title, id: t.id })),
          }}
        </Task>
        {tickets.map((ticket) => renderTicket(ctx, ticket))}
      </Sequence>
    </Workflow>
  );
});
