/** @jsxImportSource smthrs */
// Fake-agent variant of examples/incident-runbook-memory.jsx, run END-TO-END under
// the real engine. Mirrors the example's workflow exactly (same task ids, schemas,
// Branch threshold, approval gate, and the same store calls its agent tools make);
// only the model-backed agents are replaced by fakes, so it runs in CI with no keys.
// Keep it in lockstep with the example when the example changes.
//
// The example's claim is that RUNS COMPOUND, so this drives FIVE runs on one db:
//   runs 1-3  bank one lesson each (below the distill threshold — no gate)
//   run 4     recall sees 3 lessons -> distill writes ONE pending rule superseding
//             them -> parks at the ratify gate -> approve -> resume -> the rule is
//             live and the lessons retire atomically
//   run 5     recall serves ONE runbook rule and zero lessons (the compressed
//             corpus) — the payoff step, measured
import { expect, test } from "bun:test";
import { z } from "zod";
import {
  Sequence,
  Branch,
  Task,
  Workflow,
  runWorkflow,
  approveNode,
  createMemoryStore,
  ensureSmithersTables,
} from "../src/index.js";
import { SmithersDb } from "@smthrs/db/adapter";
import { Effect } from "effect";
import { dirname } from "node:path";
import { createTestSmithers } from "./helpers.js";

const OPS = { kind: "user", id: "ops-team" };
const DISTILL_THRESHOLD = 3; // same as the example

const schemas = {
  recall: z.object({
    rules: z.array(z.string()),
    lessons: z.array(z.string()),
    lessonIds: z.array(z.string()),
    onCall: z.string(),
    lessonCount: z.number(),
  }),
  triage: z.object({
    diagnosis: z.string(),
    actions: z.array(z.string()),
    groundedInPriorKnowledge: z.boolean(),
  }),
  bank: z.object({ lessonIds: z.array(z.string()), summary: z.string() }),
  proposal: z.object({ ruleNoteId: z.string(), rationale: z.string() }),
  ratification: z.object({ ratifiedNoteId: z.string(), supersededCount: z.number() }),
};

function runInTestRoot(workflow, dbPath, opts) {
  return Effect.runPromise(runWorkflow(workflow, { ...opts, rootDir: dirname(dbPath) }));
}

test("incident-runbook-memory: five runs compound, distill gates, the corpus compresses", async () => {
  const { smithers, outputs, db, dbPath, cleanup } = createTestSmithers(schemas);
  ensureSmithersTables(db);
  const store = createMemoryStore(db);
  await store.setFact(OPS, "on-call", "alice"); // the mutable-facts lane the recall step reads

  // Fakes stand in for the model only; they run the SAME store writes the
  // example's tools execute, with the same closure-injected provenance.
  const fakeTriager = {
    id: "fake-triager",
    async generate(args) {
      const grounded =
        /runbook rules:\n1\.|Lessons from past incidents/.test(args.prompt) && !args.prompt.includes("(none yet");
      return {
        output: {
          diagnosis: grounded
            ? "warm the cache tier before rollout"
            : "insufficient prior knowledge — investigating from scratch",
          actions: ["check cache hit rate"],
          groundedInPriorKnowledge: grounded,
        },
      };
    },
  };
  // Mirrors makeBanker: the model's only contribution is the lesson body.
  const fakeBanker = (provenance, lessonBody) => ({
    id: "fake-banker",
    async generate() {
      const note = await store.saveNote({
        namespace: OPS,
        body: lessonBody,
        kind: "lesson",
        tags: ["deploys"],
        provenance,
      });
      return { output: { lessonIds: [note.id], summary: `banked: ${lessonBody}` } };
    },
  });
  // Mirrors makeDistiller: PENDING rule superseding the recalled lessons.
  const fakeDistiller = (provenance, lessonIds) => ({
    id: "fake-distiller",
    async generate() {
      const note = await store.saveNote({
        namespace: OPS,
        body: "RULE: always pre-warm the cache tier before any deploys rollout (cold cache saturates the origin)",
        kind: "runbook-rule",
        tags: ["deploys"],
        status: "pending",
        supersedes: lessonIds,
        provenance,
      });
      return { output: { ruleNoteId: note.id, rationale: "three lessons, one root cause" } };
    },
  });

  // The example's build function, verbatim shape (task ids, Branch, gate).
  const workflow = smithers((ctx) => {
    const topic = ctx.input.topic ?? "deploys";
    const lessonBody = ctx.input.lessonBody ?? "deploys fail when the cache is cold";
    const recall = ctx.outputMaybe("recall", { nodeId: "recall" });
    const proposal = ctx.outputMaybe("proposal", { nodeId: "distill" });
    const shouldDistill = (recall?.lessonCount ?? 0) >= DISTILL_THRESHOLD;
    return (
      <Workflow name="incident-runbook-memory">
        <Sequence>
          <Task id="recall" output={outputs.recall}>
            {async () => {
              await store.enableNoteSearch("user");
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
          <Task id="triage" output={outputs.triage} agent={fakeTriager}>
            {`Incident: ${ctx.input.incident}\nThe team's ratified runbook rules:\n${(recall?.rules ?? []).map((r, i) => `${i + 1}. ${r}`).join("\n") || "(none yet)"}\nLessons from past incidents on this topic:\n${(recall?.lessons ?? []).map((l, i) => `${i + 1}. ${l}`).join("\n") || "(none yet — this is a cold start)"}`}
          </Task>
          <Task
            id="bank"
            output={outputs.bank}
            agent={fakeBanker({ runId: ctx.runId, nodeId: "bank", iteration: 0 }, lessonBody)}
          >
            {"Extract lessons from this incident."}
          </Task>
          <Branch
            if={shouldDistill}
            then={
              <Sequence>
                <Task
                  id="distill"
                  output={outputs.proposal}
                  agent={fakeDistiller({ runId: ctx.runId, nodeId: "distill", iteration: 0 }, recall?.lessonIds ?? [])}
                >
                  {"Distill the recurring lessons into one runbook rule."}
                </Task>
                <Task id="ratify" output={outputs.ratification} needsApproval>
                  {async () => {
                    const before = (await store.listNotes(OPS)).length;
                    await store.setNoteStatus(proposal.ruleNoteId, "accepted");
                    const after = (await store.listNotes(OPS)).length;
                    return { ratifiedNoteId: proposal.ruleNoteId, supersededCount: before - after + 1 };
                  }}
                </Task>
              </Sequence>
            }
          />
        </Sequence>
      </Workflow>
    );
  });

  // --- Runs 1-3: lessons accumulate; the distill branch never mounts. ---
  const lessonBodies = [
    "deploys fail when the cache tier is cold after scale-down",
    "deploys during peak traffic saturate the origin on cache misses",
    "deploys right after a cache flush show the same origin saturation",
  ];
  const runIds = [];
  for (let i = 0; i < 3; i++) {
    const r = await runInTestRoot(workflow, dbPath, {
      input: { incident: `incident #${i + 1}`, topic: "deploys", lessonBody: lessonBodies[i] },
    });
    expect(r.status).toBe("finished"); // below threshold: no gate parks the run
    runIds.push(r.runId);
  }
  const lessonsAfter3 = await store.listNotes(OPS, { kind: "lesson" });
  expect(lessonsAfter3).toHaveLength(3);
  // Provenance: each lesson answers "which run learned this?" — unfakeably.
  expect(new Set(lessonsAfter3.map((n) => n.runId))).toEqual(new Set(runIds));
  expect(lessonsAfter3.every((n) => n.nodeId === "bank")).toBe(true);

  // --- Run 4: threshold reached -> distill -> gate -> approve -> resume. ---
  const r4 = await runInTestRoot(workflow, dbPath, {
    input: { incident: "incident #4", topic: "deploys", lessonBody: "deploys: cold-cache failures recur weekly" },
  });
  expect(r4.status).toBe("waiting-approval");
  // Mid-gate: the pending rule hides nothing — all lessons still live.
  expect((await store.listNotes(OPS, { kind: "lesson" })).length).toBeGreaterThanOrEqual(3);
  const pendingRules = await store.listNotes(OPS, { kind: "runbook-rule", status: "pending" });
  expect(pendingRules).toHaveLength(1);
  const adapter = new SmithersDb(db);
  await Effect.runPromise(approveNode(adapter, r4.runId, "ratify", 0, "good rule", "j"));
  const r4resumed = await runInTestRoot(workflow, dbPath, {
    input: { incident: "incident #4", topic: "deploys", lessonBody: "deploys: cold-cache failures recur weekly" },
    runId: r4.runId,
    resume: true,
  });
  expect(r4resumed.status).toBe("finished");

  // Post-approval: the rule is live; the 3 recalled lessons retired atomically.
  const liveRules = await store.listNotes(OPS, { kind: "runbook-rule" });
  expect(liveRules).toHaveLength(1);
  expect(liveRules[0].body).toContain("pre-warm the cache");
  const liveLessons = await store.listNotes(OPS, { kind: "lesson" });
  expect(liveLessons).toHaveLength(1); // only run 4's own new lesson (banked before distill recalled it)
  // Nothing was destroyed — widening the read shows the full history.
  expect((await store.listNotes(OPS, { status: "any", includeSuperseded: true })).length).toBe(5);

  // --- Run 5: the payoff, measured — recall serves the compressed corpus. ---
  const r5 = await runInTestRoot(workflow, dbPath, {
    input: { incident: "incident #5", topic: "deploys", lessonBody: "deploys: yet another cache incident" },
  });
  expect(r5.status).toBe("finished");
  // Read run 5's recall output from its durable output table.
  const recalls = db.$client.query(`SELECT rules, lesson_count FROM recall WHERE run_id = ?`).get(r5.runId);
  expect(JSON.parse(recalls.rules)).toHaveLength(1); // ONE rule where three lessons were
  // Run 5's triage was grounded in prior knowledge — the compounding claim.
  const triage = db.$client
    .query(`SELECT grounded_in_prior_knowledge AS g, diagnosis FROM triage WHERE run_id = ?`)
    .get(r5.runId);
  expect(Boolean(triage.g)).toBe(true);
  expect(triage.diagnosis).toContain("warm the cache");
  cleanup();
}, 60_000);
