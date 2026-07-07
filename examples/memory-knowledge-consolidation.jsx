// @ts-nocheck
/**
 * <MemoryKnowledgeConsolidation> — Distill accumulated observation notes into
 * one human-ratified synthesis, entirely on the durable-knowledge memory
 * substrate (append-only notes + supersession + status + provenance).
 *
 * Pattern: ingest observations → agent proposes a PENDING synthesis that
 * supersedes them → human approval gate → accept → the default read now
 * serves one synthesis instead of N observations.
 * Use cases: memory consolidation ("sleep cycle"), HITL-gated decision
 * records, invariant distillation, any accumulate-then-compress knowledge flow.
 *
 * The substrate does all the bookkeeping, policy-free:
 * - every write is PROVENANCE-stamped with this run's coordinates — the
 *   workflow fills them (the tool closes over ctx.runId), so the model can
 *   never fabricate where a note came from
 * - the synthesis is written PENDING and supersedes the observations via the
 *   junction table; a pending superseder hides NOTHING, so until the human
 *   approves, readers still see the original observations
 * - approval flips ONE mutable field (status) — note bodies are immutable,
 *   and rejecting the proposal leaves the corpus exactly as it was
 * - the DEFAULT READ CONTRACT (accepted + not superseded by an accepted
 *   note) means downstream agents just call listNotes and get live knowledge
 */
import { Sequence } from "smithers-orchestrator";
import { createMemoryStore } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import DistillPrompt from "./prompts/memory-knowledge-consolidation/distill.mdx";

const NAMESPACE = { kind: "user", id: "team-knowledge" };

const ingestSchema = z.object({
    noteIds: z.array(z.string()),
    count: z.number(),
});
const proposalSchema = z.object({
    noteId: z.string(),
    rationale: z.string(),
});
const ratificationSchema = z.object({
    ratifiedNoteId: z.string(),
});
const knowledgeSchema = z.object({
    liveNotes: z.array(z.string()),
    hiddenCount: z.number(),
});

const { Workflow, Task, smithers, outputs, db } = createExampleSmithers({
    ingest: ingestSchema,
    proposal: proposalSchema,
    ratification: ratificationSchema,
    knowledge: knowledgeSchema,
});
const store = createMemoryStore(db);

/**
 * The distiller agent, built PER RUN so its tool closes over this run's
 * provenance and the observation ids. The model supplies only the synthesis
 * body — namespace, supersession targets, pending status, and provenance are
 * all filled by the workflow, which is what makes the note trustworthy.
 */
function makeDistiller(provenance, observationIds) {
    return new Agent({
        model: anthropic("claude-sonnet-5"),
        tools: {
            propose_consolidation: tool({
                description: "Record the consolidated synthesis as a PENDING memory note that supersedes the observation notes. Returns the new note's id.",
                inputSchema: z.object({
                    synthesis: z.string().describe("The distilled knowledge, grounded in the observations."),
                }),
                execute: async ({ synthesis }) => {
                    const note = await store.saveNote({
                        namespace: NAMESPACE,
                        body: synthesis,
                        kind: "synthesis",
                        status: "pending", // the human gate decides; storage only remembers the answer
                        supersedes: observationIds,
                        provenance,
                    });
                    return { noteId: note.id };
                },
            }),
        },
        instructions: "You consolidate observation notes into durable knowledge. Be faithful to the source observations; never invent facts.",
    });
}

const DEMO_OBSERVATIONS = [
    "Deploy failed Tuesday 09:12 — cache tier was cold after the weekend scale-down.",
    "Deploy failed during the traffic spike — cache misses saturated the origin.",
    "Deploy failed after the cache flush migration — same origin saturation signature.",
];

export default smithers((ctx) => {
    const observations = ctx.input.observations ?? DEMO_OBSERVATIONS;
    const topic = ctx.input.topic ?? "deploy failures";
    const ingested = ctx.outputMaybe("ingest", { nodeId: "ingest" });
    const proposal = ctx.outputMaybe("proposal", { nodeId: "distill" });
    return (<Workflow name="memory-knowledge-consolidation">
      <Sequence>
        {/* 1. Ingest: observations become provenance-stamped memory notes. */}
        <Task id="ingest" output={outputs.ingest}>
          {async () => {
            const noteIds = [];
            for (const body of observations) {
                const note = await store.saveNote({
                    namespace: NAMESPACE,
                    body,
                    kind: "observation",
                    provenance: { runId: ctx.runId, nodeId: "ingest", iteration: 0 },
                });
                noteIds.push(note.id);
            }
            return { noteIds, count: noteIds.length };
        }}
        </Task>

        {/* 2. Distill: the agent proposes ONE synthesis. Its tool writes the
            note PENDING + superseding — until a human approves, the default
            read still serves the original observations. */}
        <Task id="distill" output={outputs.proposal} agent={makeDistiller({ runId: ctx.runId, nodeId: "distill", iteration: 0 }, ingested?.noteIds ?? [])}>
          <DistillPrompt topic={topic} observations={observations.map((o, i) => `${i + 1}. ${o}`).join("\n")}/>
        </Task>

        {/* 3. Ratify: the human gate. Approving runs the ONE mutable write —
            status → accepted — which atomically flips what the default read
            serves. Denying leaves the corpus untouched (a rejected superseder
            hides nothing). */}
        <Task id="ratify" output={outputs.ratification} needsApproval>
          {async () => {
            await store.setNoteStatus(proposal.noteId, "accepted");
            return { ratifiedNoteId: proposal.noteId };
        }}
        </Task>

        {/* 4. Read back what any future agent now sees: one synthesis, the
            superseded observations hidden (but preserved — widen the filter
            to audit them). */}
        <Task id="knowledge" output={outputs.knowledge}>
          {async () => {
            const live = await store.listNotes(NAMESPACE);
            const all = await store.listNotes(NAMESPACE, { status: "any", includeSuperseded: true });
            return {
                liveNotes: live.map((n) => n.body),
                hiddenCount: all.length - live.length,
            };
        }}
        </Task>
      </Sequence>
    </Workflow>);
});
