// @ts-nocheck
/**
 * <IncidentRunbookMemory> — An on-call helper that gets smarter every incident.
 * Triage the current incident with everything the team has learned so far, bank
 * what this one teaches, and when the same lesson keeps recurring, compress the
 * pile into ONE human-ratified runbook rule.
 *
 * Pattern: recall knowledge → triage with it → bank new lessons →
 *          (when lessons pile up) propose a runbook rule → human gate.
 * Use cases: on-call copilots, support desks with recall, postmortem distillation,
 * any recurring agent job whose runs should compound instead of starting cold.
 *
 * Run it repeatedly with different incidents — the recall step is the payoff:
 *   smithers workflow run examples/incident-runbook-memory.jsx \
 *     --input '{"incident": "deploys failing again, cache tier cold after scale-down", "topic": "deploys"}'
 */
import { Sequence, Branch } from "smithers-orchestrator";
import { createMemoryStore, ensureSmithersTables } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import TriagePrompt from "./prompts/incident-runbook-memory/triage.mdx";
import BankPrompt from "./prompts/incident-runbook-memory/bank.mdx";
import DistillPrompt from "./prompts/incident-runbook-memory/distill.mdx";

// One namespace for the team's operational knowledge. Notes are durable
// append-only knowledge (lessons, rules); facts are mutable KV scratch
// (who's on call) — same store, two disciplines.
const OPS = { kind: "user", id: "ops-team" };
// Distill once this many accepted lessons share the topic. Low so the demo
// reaches the consolidation path quickly; tune for real use.
const DISTILL_THRESHOLD = 3;

const recallSchema = z.object({
    rules: z.array(z.string()),
    lessons: z.array(z.string()),
    lessonIds: z.array(z.string()),
    onCall: z.string(),
    lessonCount: z.number(),
});
const triageSchema = z.object({
    diagnosis: z.string(),
    actions: z.array(z.string()),
    groundedInPriorKnowledge: z.boolean(),
});
const bankSchema = z.object({
    lessonIds: z.array(z.string()),
    summary: z.string(),
});
const proposalSchema = z.object({
    ruleNoteId: z.string(),
    rationale: z.string(),
});
const ratificationSchema = z.object({
    ratifiedNoteId: z.string(),
    supersededCount: z.number(),
});

const { Workflow, Task, smithers, outputs, db } = createExampleSmithers({
    recall: recallSchema,
    triage: triageSchema,
    bank: bankSchema,
    proposal: proposalSchema,
    ratification: ratificationSchema,
});
ensureSmithersTables(db); // memory tables are created on first runWorkflow; a store used at build time needs them now
const store = createMemoryStore(db);

/**
 * Agents are built per run so their memory tools close over THIS run's
 * provenance — the model writes bodies, never coordinates. Every note this
 * workflow creates answers "which run learned this?" for free.
 */
function makeBanker(provenance) {
    return new Agent({
        model: anthropic("claude-sonnet-5"),
        tools: {
            record_lesson: tool({
                description: "Save one operational lesson from this incident as a durable team memory note.",
                inputSchema: z.object({
                    lesson: z.string().describe("One concrete, reusable lesson (not a description of this incident)."),
                    topic: z.string().describe("Short topic tag, e.g. 'deploys'."),
                }),
                execute: async ({ lesson, topic }) => {
                    const note = await store.saveNote({
                        namespace: OPS,
                        body: lesson,
                        kind: "lesson", // free-form label; the engine never interprets it
                        tags: [topic],
                        provenance,
                    });
                    return { noteId: note.id };
                },
            }),
        },
        instructions: "You extract durable operational lessons from incidents. Each lesson must be reusable by someone who never saw this incident.",
    });
}

function makeDistiller(provenance, lessonIds, topic) {
    return new Agent({
        model: anthropic("claude-sonnet-5"),
        tools: {
            propose_runbook_rule: tool({
                description: "Propose ONE runbook rule that replaces the accumulated lessons. It is recorded PENDING — a human approves or rejects it at the gate.",
                inputSchema: z.object({
                    rule: z.string().describe("The consolidated runbook rule, standing on its own."),
                }),
                execute: async ({ rule }) => {
                    const note = await store.saveNote({
                        namespace: OPS,
                        body: rule,
                        kind: "runbook-rule",
                        tags: [topic],
                        status: "pending", // until approved, the individual lessons stay live — a pending superseder hides nothing
                        supersedes: lessonIds,
                        provenance,
                    });
                    return { noteId: note.id };
                },
            }),
        },
        instructions: "You distill repeated operational lessons into one clear runbook rule. Never lose information the lessons agree on; never invent policy they don't support.",
    });
}

const triager = new Agent({
    model: anthropic("claude-sonnet-5"),
    instructions: "You are an on-call triage assistant. Ground your diagnosis in the team's runbook rules and lessons when they apply; say so when they don't.",
});

export default smithers((ctx) => {
    const incident = ctx.input.incident ?? "deploys failing, cache tier cold after the weekend scale-down";
    const topic = ctx.input.topic ?? "deploys";
    const recall = ctx.outputMaybe("recall", { nodeId: "recall" });
    const proposal = ctx.outputMaybe("proposal", { nodeId: "distill" });
    const shouldDistill = (recall?.lessonCount ?? 0) >= DISTILL_THRESHOLD;
    return (<Workflow name="incident-runbook-memory">
      <Sequence>
        {/* 1. RECALL — the payoff of every previous run. listNotes returns only
            LIVE knowledge (accepted, not superseded by an accepted note), so the
            triager never sees rejected proposals or lessons a ratified rule
            replaced. searchNotes is FTS over note bodies, indexed lazily on the
            first enableNoteSearch call. Facts are the mutable scratch lane. */}
        <Task id="recall" output={outputs.recall}>
          {async () => {
            await store.enableNoteSearch("user"); // idempotent; creates the FTS index on first use
            const rules = await store.listNotes(OPS, { kind: "runbook-rule" });
            const lessons = (await store.searchNotes("user", topic)).filter((n) => n.kind === "lesson");
            const onCall = await store.getFact(OPS, "on-call");
            return {
                rules: rules.map((n) => n.body),
                lessons: lessons.map((n) => n.body),
                lessonIds: lessons.map((n) => n.id),
                onCall: onCall ? JSON.parse(onCall.valueJson) : "unassigned",
                lessonCount: lessons.length,
            };
        }}
        </Task>

        {/* 2. TRIAGE — the agent is smarter than a cold start because of what
            prior runs banked. This is the reason the rest of the loop exists. */}
        <Task id="triage" output={outputs.triage} agent={triager}>
          <TriagePrompt incident={incident} rules={recall?.rules ?? []} lessons={recall?.lessons ?? []} onCall={recall?.onCall ?? "unassigned"}/>
        </Task>

        {/* 3. BANK — save what THIS incident taught. Provenance rides the tool
            closure: the note records which run learned it, unfakeably. */}
        <Task id="bank" output={outputs.bank} agent={makeBanker({ runId: ctx.runId, nodeId: "bank", iteration: 0 })}>
          <BankPrompt incident={incident} topic={topic} existingLessons={recall?.lessons ?? []}/>
        </Task>

        {/* 4. DISTILL — only once lessons pile up. The rule is written PENDING
            and supersedes the lessons; nothing changes for readers yet. */}
        <Branch if={shouldDistill} then={<Sequence>
            <Task id="distill" output={outputs.proposal} agent={makeDistiller({ runId: ctx.runId, nodeId: "distill", iteration: 0 }, recall?.lessonIds ?? [], topic)}>
              <DistillPrompt topic={topic} lessons={recall?.lessons ?? []}/>
            </Task>

            {/* 5. RATIFY — the human gate. Approving performs the ONE mutable
                write (status → accepted): the rule goes live and the lessons it
                replaces drop out of recall, atomically. Denying leaves the
                knowledge base exactly as it was — a rejected superseder hides
                nothing. Storage only remembers the answer. */}
            <Task id="ratify" output={outputs.ratification} needsApproval>
              {async () => {
                const before = (await store.listNotes(OPS)).length;
                await store.setNoteStatus(proposal.ruleNoteId, "accepted");
                const after = (await store.listNotes(OPS)).length;
                return { ratifiedNoteId: proposal.ruleNoteId, supersededCount: before - after + 1 };
            }}
            </Task>
          </Sequence>}/>
      </Sequence>
    </Workflow>);
});
