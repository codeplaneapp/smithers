// smithers-display-name: Kanban
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { createSmithers, Sequence, Parallel, Worktree } from "smithers-orchestrator";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { z } from "zod/v4";
import { agents } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema } from "../components/Review";
import MergeTicketsPrompt from "../prompts/merge-tickets.mdx";

const ticketResultSchema = z.object({
  ticketId: z.string(),
  branch: z.string(),
  status: z.enum(["success", "partial", "failed"]),
  summary: z.string(),
});

const mergeResultSchema = z.object({
  merged: z.array(z.string()),
  conflicted: z.array(z.string()),
  summary: z.string(),
});

const inputSchema = z.object({
  maxConcurrency: z.number().int().default(3),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  ticketResult: ticketResultSchema,
  merge: mergeResultSchema,
});

function discoverTickets(): Array<{ id: string; slug: string; content: string }> {
  const ticketsDir = resolve(process.cwd(), ".smithers/tickets");
  const out: Array<{ id: string; slug: string; content: string }> = [];

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
      const id = rel;
      const slug = rel.replace(/\.md$/, "").replace(/[/\\]/g, "__");
      out.push({ id, slug, content: readFileSync(full, "utf8") });
    }
  }

  walk(ticketsDir, 0);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Build feedback string from validation + review outputs for a ticket. */
function buildFeedback(
  ctx: any,
  slug: string,
): { feedback: string | null; done: boolean } {
  const validate = ctx.outputMaybe("validate", { nodeId: `${slug}:validate` });
  const reviews = ctx.outputs.review ?? [];

  // Review outputs share the same table across every ticket; scope by node id.
  const ticketReviews = reviews.filter(
    (r: any) => typeof r.nodeId === "string" && r.nodeId.startsWith(`${slug}:review:`),
  );

  // done = false until validate has actually run AND passed, AND at least one reviewer approved
  const hasValidated = validate !== undefined;
  const validationPassed = hasValidated && validate.allPassed !== false;
  const anyReviewApproved = ticketReviews.length > 0 && ticketReviews.some((r: any) => r.approved === true);
  const done = validationPassed && anyReviewApproved;

  if (!hasValidated) return { feedback: null, done: false };

  const parts: string[] = [];

  if (!validationPassed && validate.failingSummary) {
    parts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }

  for (const review of ticketReviews) {
    if (review.approved === false) {
      parts.push(`REVIEWER REJECTED:\n${review.feedback}`);
      if (review.issues?.length) {
        for (const issue of review.issues) {
          parts.push(`  [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
        }
      }
    }
  }

  return {
    feedback: parts.length > 0 ? parts.join("\n\n") : null,
    done,
  };
}

export default smithers((ctx) => {
  const tickets = discoverTickets();
  const maxConcurrency = ctx.input.maxConcurrency;
  const ticketResults = ctx.outputs.ticketResult ?? [];

  return (
    <Workflow name="kanban">
      <UI entry="../ui/kanban.tsx" title={"Kanban"} />
      <Sequence>
        {/* Implement each ticket in its own worktree branch, in parallel */}
        <Parallel maxConcurrency={maxConcurrency}>
          {tickets.map((ticket) => {
            const { feedback, done } = buildFeedback(ctx, ticket.slug);
            return (
              <Worktree
                key={ticket.slug}
                path={resolve(process.cwd(), ".worktrees", ticket.slug)}
                branch={`ticket/${ticket.slug}`}
              >
                <Sequence>
                  <ValidationLoop
                    idPrefix={ticket.slug}
                    prompt={`Implement the ticket below in this worktree, then make it pass.\n\nTICKET FILE: .smithers/tickets/${ticket.id}\n\n${ticket.content}\n\n--- When the work is complete and green ---\n- COMMIT your changes to THIS worktree branch with one atomic emoji+conventional commit. Local commits only; the workflow lands them on main itself.\n- NEVER push, force-push, or run gh pr create; never switch branches or touch main/origin. An agent push corrupts shared main; the workflow owns all merging.`}
                    implementAgents={agents.implement}
                    validateAgents={agents.smart}
                    reviewAgents={agents.review}
                    feedback={feedback}
                    done={done}
                    maxIterations={3}
                  />
                  <Task
                    id={`result-${ticket.slug}`}
                    output={outputs.ticketResult}
                    continueOnFail
                  >
                    {async () => {
                      const { spawnSync } = await import("node:child_process");
                      const branch = `ticket/${ticket.slug}`;
                      const wt = resolve(process.cwd(), ".worktrees", ticket.slug);
                      const git = (args: string[], cwd = wt) =>
                        spawnSync("git", args, { cwd, encoding: "utf8" });
                      // Safety net: the implement agent is asked to commit, but if it
                      // left converged work uncommitted, capture it here so the merge
                      // step doesn't silently drop it. Only commit once the loop
                      // converged (validation passed + a reviewer approved).
                      let committed = false;
                      if (done) {
                        git(["add", "-A"]);
                        const dirty = (git(["status", "--porcelain"]).stdout ?? "").trim().length > 0;
                        if (dirty) {
                          git(["commit", "-m", `✅ kanban: ${ticket.id}`]);
                          committed = true;
                        }
                      }
                      const ahead = ((git(["rev-list", "--count", `main..${branch}`], process.cwd()).stdout) ?? "0").trim();
                      const hasWork = ahead !== "" && ahead !== "0";
                      return {
                        ticketId: ticket.id,
                        branch,
                        status: done && hasWork ? "success" : "partial",
                        summary: done
                          ? committed
                            ? `Committed pending work for ${ticket.slug} (${ahead} commit(s))`
                            : `Implemented ${ticket.slug} (${ahead} commit(s))`
                          : `Did not converge for ${ticket.slug}`,
                      };
                    }}
                  </Task>
                </Sequence>
              </Worktree>
            );
          })}
        </Parallel>

        {/* Agent merges completed branches back into main */}
        <Task id="merge" output={outputs.merge} agent={agents.smart}>
          <MergeTicketsPrompt ticketSummary={ticketResults
            .map((r) => `- ${r.ticketId}: branch "${r.branch}" — ${r.status} (${r.summary})`)
            .join("\n")} />
        </Task>
      </Sequence>
    </Workflow>
  );
});
