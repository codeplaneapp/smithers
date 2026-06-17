/**
 * <ParallelTickets> — Triage → Wave-by-wave parallel execution → Merge queue.
 *
 * Pipeline:
 *   1. Triage (Claude Opus) reads every ticket, builds a dependency graph,
 *      and groups tickets into waves. Tickets within a wave are independent
 *      and can run in parallel; waves run sequentially.
 *   2. For each wave, every ticket runs concurrently in its own worktree:
 *        implement (Sonnet, no browse / no docs) →
 *          if implementer asked for docs: researcher (Haiku) writes them to wiki/ →
 *        review (gpt-5.5 xhigh)
 *      The loop exits only when the reviewer approves.
 *   3. After a wave finishes, branches are merged back into main one-by-one
 *      (MergeQueue, maxConcurrency=1) before the next wave starts.
 *
 * Subscriptions: Claude roles run via the Claude Code CLI; the reviewer runs
 * via the Pi/Codex CLI — both use the user's existing subscriptions.
 */
import { Sequence, Parallel, Loop, MergeQueue, Worktree } from "smithers-orchestrator";
import { ClaudeCodeAgent, PiAgent } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { z } from "zod";
import TriagePrompt from "./prompts/parallel-tickets/triage.mdx";
import ImplementPrompt from "./prompts/parallel-tickets/implement.mdx";
import ResearchPrompt from "./prompts/parallel-tickets/research.mdx";
import ReviewPrompt from "./prompts/parallel-tickets/review.mdx";
import MergePrompt from "./prompts/parallel-tickets/merge.mdx";

// ─── Schemas ───────────────────────────────────────────────────────────────

const ticketSchema = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    files: z.array(z.string()).default([]),
    dependsOn: z.array(z.string()).default([]),
    acceptanceCriteria: z.string().optional(),
});

const triageSchema = z.object({
    tickets: z.array(ticketSchema),
    waves: z.array(z.object({
        index: z.number(),
        ticketIds: z.array(z.string()),
        rationale: z.string(),
    })),
    summary: z.string(),
});

const implementSchema = z.object({
    ticketId: z.string(),
    status: z.enum(["complete", "needs_docs"]),
    branch: z.string(),
    summary: z.string(),
    filesChanged: z.array(z.string()).default([]),
    commitCount: z.number().default(0),
    docRequests: z.array(z.object({
        topic: z.string(),
        questions: z.array(z.string()),
    })).default([]),
});

const researchSchema = z.object({
    ticketId: z.string(),
    requestsAddressed: z.array(z.string()),
    docsWritten: z.array(z.string()), // paths inside wiki/
    summary: z.string(),
});

const reviewSchema = z.object({
    ticketId: z.string(),
    approved: z.boolean(),
    feedback: z.string(),
    issues: z.array(z.object({
        severity: z.enum(["blocker", "major", "minor", "nit"]),
        file: z.string(),
        description: z.string(),
        suggestion: z.string(),
    })).default([]),
});

const mergeSchema = z.object({
    ticketId: z.string(),
    branch: z.string(),
    status: z.enum(["merged", "conflict", "failed"]),
    note: z.string(),
});

const reportSchema = z.object({
    totalTickets: z.number(),
    waves: z.number(),
    merged: z.number(),
    failed: z.number(),
    summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
    triage: triageSchema,
    implement: implementSchema,
    research: researchSchema,
    review: reviewSchema,
    merge: mergeSchema,
    report: reportSchema,
});

// ─── Agents ────────────────────────────────────────────────────────────────

const TRIAGE_MODEL = "claude-opus-4-5";
const IMPLEMENTER_MODEL = "claude-sonnet-4-6";
const RESEARCHER_MODEL = "claude-haiku-4-5";
const REVIEWER_MODEL = "gpt-5.5";

/** Triage: reads every ticket, builds the dep graph, groups into parallel waves. */
const triageAgent = new ClaudeCodeAgent({
    model: TRIAGE_MODEL,
    instructions: `You are the Triage agent. You read all tickets and the
codebase, infer dependencies between tickets, and partition them into "waves":
sets of tickets that can run in parallel because no ticket in the wave depends
on another ticket in the same wave.

Rules:
- A ticket may only land in wave N if all of its dependsOn tickets are in waves 0..N-1.
- Prefer wider waves over narrower ones — maximize parallelism.
- If two tickets touch the same files in conflicting ways, treat that as a
  hidden dependency and put the lower-priority one in a later wave.
- Keep ticket IDs stable across the run.`,
});

/** Implementer: works inside its worktree. Cannot read external docs or browse.
 *  If it needs information, it emits docRequests to be fulfilled by the researcher. */
const implementerAgent = new ClaudeCodeAgent({
    model: IMPLEMENTER_MODEL,
    permissionMode: "acceptEdits",
    // Hard ban on browsing and external docs. The implementer may only consult
    // code in the worktree and files written into wiki/ by the researcher.
    disallowedTools: ["WebFetch", "WebSearch"],
    instructions: `You are the Implementer. You work inside an isolated git
worktree on a single ticket. Make focused, atomic commits with conventional
prefixes. You MUST NOT browse the web or attempt to read external docs.

If — and only if — you cannot proceed without external information, emit a
status of "needs_docs" with a list of docRequests describing what you need.
Then stop. Do not invent answers. Do not commit a half-baked guess.

When you resume, the researcher will have written authoritative notes into
the worktree's wiki/ folder. Read those before continuing.

Otherwise, complete the ticket: implement the change, commit it on the
ticket's branch, and report status "complete" with the branch name and a
summary of what you did.`,
});

/** Researcher: fulfills implementer doc requests by writing notes into wiki/. */
const researcherAgent = new ClaudeCodeAgent({
    model: RESEARCHER_MODEL,
    permissionMode: "acceptEdits",
    instructions: `You are the Researcher. The implementer is blocked and has
asked specific questions. You may use any tools — reading code, searching
the web, consulting external docs — to answer them.

Write your findings as concise, authoritative markdown into the worktree's
wiki/ folder, one file per topic. Reference exact APIs, version numbers,
and links. Then report which requests you addressed and the paths you wrote.`,
});

/** Reviewer: GPT-5.5 thinking="xhigh" via Codex subscription.
 *  May research freely. Loop only exits when this agent approves. */
const reviewerAgent = new PiAgent({
    provider: "openai-codex",
    model: REVIEWER_MODEL,
    mode: "rpc",
    thinking: "xhigh",
    tools: ["read", "grep", "bash"],
});

/** Merge: serialised one-at-a-time merge of approved branches into main. */
const mergeAgent = new ClaudeCodeAgent({
    model: IMPLEMENTER_MODEL,
    permissionMode: "acceptEdits",
    allowedTools: ["Bash", "Read", "Grep"],
    instructions: `You are the Merge agent. Fast-forward (or rebase if needed)
the given ticket branch onto main, run the project's build/test gates, and
push. If the merge would conflict, mark status "conflict" and stop — do not
attempt to resolve conflicts in this step. Report exactly one merge result.`,
});

// ─── Workflow ──────────────────────────────────────────────────────────────

export default smithers((ctx) => {
    const triage = ctx.outputMaybe("triage", { nodeId: "triage" });
    const allImpls = ctx.outputs.implement ?? [];
    const allReviews = ctx.outputs.review ?? [];
    const allMerges = ctx.outputs.merge ?? [];

    const latestImplFor = (ticketId) => {
        const rows = allImpls.filter((r) => r.ticketId === ticketId);
        return rows[rows.length - 1];
    };
    const latestReviewFor = (ticketId) => {
        const rows = allReviews.filter((r) => r.ticketId === ticketId);
        return rows[rows.length - 1];
    };

    const maxParallel = ctx.input.maxParallel ?? 6;
    const maxIterations = ctx.input.maxIterations ?? 6;
    const baseBranch = ctx.input.baseBranch ?? "main";

    return (
        <Workflow name="parallel-tickets">
            <Sequence>
                {/* ═══ TRIAGE ═══ */}
                <Task id="triage" output={outputs.triage} agent={triageAgent}>
                    <TriagePrompt
                        directory={ctx.input.directory}
                        tickets={ctx.input.tickets}
                        baseBranch={baseBranch}
                    />
                </Task>

                {/* ═══ WAVES ═══
                    Static unroll over triage.waves. Each wave is a Sequence of
                    {parallel review-loops, then serial merges}. Waves execute
                    top-to-bottom because they live inside the outer Sequence. */}
                {triage?.waves.map((wave) => {
                    const waveTickets = wave.ticketIds
                        .map((tid) => triage.tickets.find((t) => t.id === tid))
                        .filter((t) => t != null);

                    return (
                        <Sequence key={`wave-${wave.index}`}>
                            {/* Per-ticket review loops, run in parallel worktrees */}
                            <Parallel maxConcurrency={maxParallel}>
                                {waveTickets.map((ticket) => {
                                    const latestImpl = latestImplFor(ticket.id);
                                    const latestReview = latestReviewFor(ticket.id);
                                    const isApproved = latestReview?.approved === true;
                                    const needsDocs = latestImpl?.status === "needs_docs";

                                    return (
                                        <Worktree
                                            key={ticket.id}
                                            path={`.worktrees/${ticket.id}`}
                                            branch={`ticket/${ticket.id}`}
                                            baseBranch={baseBranch}
                                        >
                                            <Loop
                                                until={isApproved}
                                                maxIterations={maxIterations}
                                                onMaxReached="return-last"
                                            >
                                                <Sequence>
                                                    {/* Implement (or fix from review feedback) */}
                                                    <Task
                                                        id={`implement-${ticket.id}`}
                                                        output={outputs.implement}
                                                        agent={implementerAgent}
                                                        retries={1}
                                                        timeoutMs={20 * 60_000}
                                                    >
                                                        <ImplementPrompt
                                                            ticket={ticket}
                                                            previousImpl={latestImpl}
                                                            review={latestReview}
                                                        />
                                                    </Task>

                                                    {/* Researcher only runs when implementer asked for docs */}
                                                    <Task
                                                        id={`research-${ticket.id}`}
                                                        output={outputs.research}
                                                        agent={researcherAgent}
                                                        skipIf={!needsDocs}
                                                        timeoutMs={10 * 60_000}
                                                    >
                                                        <ResearchPrompt
                                                            ticket={ticket}
                                                            docRequests={latestImpl?.docRequests ?? []}
                                                        />
                                                    </Task>

                                                    {/* Reviewer is skipped while waiting on docs */}
                                                    <Task
                                                        id={`review-${ticket.id}`}
                                                        output={outputs.review}
                                                        agent={reviewerAgent}
                                                        skipIf={needsDocs}
                                                        timeoutMs={15 * 60_000}
                                                    >
                                                        <ReviewPrompt
                                                            ticket={ticket}
                                                            impl={latestImpl}
                                                        />
                                                    </Task>
                                                </Sequence>
                                            </Loop>
                                        </Worktree>
                                    );
                                })}
                            </Parallel>

                            {/* Serial merge of every branch in this wave before
                                we start the next wave. */}
                            <MergeQueue id={`merge-wave-${wave.index}`} maxConcurrency={1}>
                                {waveTickets.map((ticket) => {
                                    const review = latestReviewFor(ticket.id);
                                    return (
                                        <Task
                                            key={ticket.id}
                                            id={`merge-${ticket.id}`}
                                            output={outputs.merge}
                                            agent={mergeAgent}
                                            skipIf={review?.approved !== true}
                                            retries={1}
                                            timeoutMs={10 * 60_000}
                                        >
                                            <MergePrompt
                                                ticketId={ticket.id}
                                                branch={`ticket/${ticket.id}`}
                                                baseBranch={baseBranch}
                                            />
                                        </Task>
                                    );
                                })}
                            </MergeQueue>
                        </Sequence>
                    );
                })}

                {/* ═══ FINAL REPORT ═══ */}
                <Task id="report" output={outputs.report}>
                    {{
                        totalTickets: triage?.tickets.length ?? 0,
                        waves: triage?.waves.length ?? 0,
                        merged: allMerges.filter((m) => m.status === "merged").length,
                        failed: allMerges.filter((m) => m.status !== "merged").length,
                        summary: triage
                            ? `Processed ${triage.tickets.length} tickets across ${triage.waves.length} wave(s); ${allMerges.filter((m) => m.status === "merged").length} merged.`
                            : "Triage did not produce a plan.",
                    }}
                </Task>
            </Sequence>
        </Workflow>
    );
});
