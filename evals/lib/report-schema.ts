// The two schemas every fluency eval revolves around:
//   candidateReport — what the weak model produces (artifact + honest self-report)
//   evalVerdict     — what the independent verifier produces (the hard pass/fail)
//
// Assertions in cases.jsonl gate on `verdict[0].passed`, NEVER on the candidate's
// self-reported `oneShot`. Self-report is signal for the scorecard, not ground truth.
import { z } from "zod/v4";

/** A single friction point the candidate hit — the load-bearing data for
 * deciding which doc/API to improve. */
export const frictionItem = z.object({
  kind: z
    .enum([
      "missing-docs", // the answer wasn't in the docs at all
      "ambiguous-docs", // docs were unclear / contradictory
      "wrong-docs", // docs were present but incorrect / out of date
      "api-confusing", // the API shape itself was hard to use correctly
      "tool-error", // a command/tool failed unexpectedly
      "had-to-guess", // proceeded on an assumption, unsure if right
      "other",
    ])
    .describe("Category of friction."),
  detail: z.string().describe("What specifically was missing/unclear/wrong."),
  docPointer: z
    .string()
    .nullable()
    .default(null)
    .describe("Which doc/skill/llms-*.txt SHOULD have covered this (or null)."),
});

/** The candidate-under-test's output. */
export const candidateReport = z.object({
  artifact: z
    .string()
    .describe(
      "The deliverable the task asked for: workflow code, a CLI command, a SQL query, a JSONL line, or a direct answer. Self-contained.",
    ),
  artifactKind: z
    .enum([
      "workflow-tsx",
      "jsonl-cases",
      "scorer-ts",
      "agents-ts",
      "ui-tsx",
      "cli-command",
      "sql",
      "answer",
      "other",
    ])
    .describe("What kind of artifact `artifact` is."),
  oneShot: z
    .boolean()
    .describe(
      "TRUE only if you produced a correct, complete answer on the first attempt with no dead-ends, no guessing, and no doc gaps. Be honest — a false here is valuable signal, not a failure.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Your confidence the artifact is correct (0-1)."),
  friction: z
    .array(frictionItem)
    .default([])
    .describe("Every point where the docs/API slowed you down or made you guess. Empty if truly frictionless."),
  blockers: z
    .array(z.string())
    .default([])
    .describe("Anything that stopped you from completing the task at all."),
  summary: z.string().describe("One or two sentences on what you did and how it went."),
});

/** A single check the verifier ran. */
export const verdictCheck = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().default(""),
});

/** The independent verifier's verdict — the hard gate. */
export const evalVerdict = z.object({
  passed: z.boolean().describe("Did the artifact actually satisfy the task? The pass/fail gate."),
  score: z.number().min(0).max(1).describe("Graded correctness 0-1 (1 = fully correct)."),
  reason: z.string().describe("Why it passed or failed."),
  method: z
    .enum(["contains", "equals", "graph", "sql", "query", "build", "judge"])
    .describe("How verification was performed."),
  checks: z.array(verdictCheck).default([]).describe("Per-check breakdown."),
});

/** First-class AI quality score for UI-authoring (build) cases. Persisted as a
 * workflow output (a judge Task), not a best-effort async scorer, so the score
 * reliably lands even when the judge is slow. */
export const qualityScore = z.object({
  score: z.number().min(0).max(1).describe("UI quality 0-1."),
  reason: z.string().describe("Why this score."),
});

export type CandidateReport = z.infer<typeof candidateReport>;
export type EvalVerdict = z.infer<typeof evalVerdict>;
export type QualityScore = z.infer<typeof qualityScore>;
