/** @jsxImportSource smithers-orchestrator */
/**
 * SWE-EVO benchmark workflow.
 *
 * One run = one SWE-EVO instance (a release-to-release evolution task). The
 * workflow is a durable five-step pipeline that genuinely mixes two harnesses:
 *
 *   prepare    (compute) materialize repo@base_commit on the host from the image
 *   implement  (Claude Opus 4.8 / claude-code) draft the implementation from the
 *              release-note spec, editing the real checkout
 *   refine     (Codex / gpt-5.5) review the draft against the spec and fix gaps
 *   diff       (compute) capture the combined edits as a unified patch
 *   score      (compute) run the hermetic Docker harness → Resolved + Fix Rate
 *
 * The agents see ONLY the spec and the repo — never the hidden tests or the gold
 * patch (see prompts.ts and dataset/load.ts). Scoring is done by the real test
 * suite in the instance's Docker image (see harness/score_instance.py).
 */

import { createSmithers } from "smithers-orchestrator";
import { ClaudeCodeAgent, CodexAgent } from "@smithers-orchestrator/agents";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod/v4";
import {
  captureDiff,
  loadInstance,
  prepareRepo,
  scoreCandidate,
  workdirFor,
  type Instance,
} from "./harness";
import { implementPrompt, refinePrompt } from "./prompts";

const AGENT_TIMEOUT_MS = Number(process.env.SWEEVO_AGENT_TIMEOUT_MS ?? 1_800_000);
const SCORE_TIMEOUT_S = Number(process.env.SWEEVO_SCORE_TIMEOUT_S ?? 1800);

const summaryShape = z.object({
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
});

export const schemas = {
  prepare: z.object({
    workdir: z.string(),
    baseCommit: z.string(),
    headLine: z.string(),
  }),
  implement: summaryShape,
  refine: summaryShape,
  diff: z.object({
    patch: z.string(),
    changedFiles: z.number(),
    insertions: z.number(),
    deletions: z.number(),
  }),
  // NOTE: smithers maps z.number() output fields to INTEGER columns, so every
  // numeric field here is an integer. Fix Rate is a fraction, so we keep its
  // exact integer components (f2p_passed / f2p_total + all_p2p_pass) and a
  // rounded fix_rate_pct for display; the exact aggregate is computed from the
  // components in run.ts.
  score: z.object({
    instance_id: z.string(),
    repo: z.string().default(""),
    image: z.string().default(""),
    log_parser: z.string().default(""),
    test_cmds: z.string().default(""),
    resolved: z.number(),
    fix_rate_pct: z.number(),
    f2p_total: z.number(),
    f2p_passed: z.number(),
    p2p_total: z.number(),
    p2p_passed: z.number(),
    all_p2p_pass: z.boolean(),
    candidate_applied: z.boolean(),
    testpatch_applied: z.boolean(),
    timed_out: z.boolean(),
    duration_s: z.number(),
    parsed_test_count: z.number(),
    f2p_status: z.record(z.string(), z.string()).default({}),
    p2p_failures: z.record(z.string(), z.string()).default({}),
  }),
};

/** Map the harness ScoreResult to the integer-safe output row. */
function toScoreRow(r: import("./harness").ScoreResult) {
  return {
    instance_id: r.instance_id,
    repo: r.repo,
    image: r.image,
    log_parser: r.log_parser,
    test_cmds: r.test_cmds,
    resolved: r.resolved,
    fix_rate_pct: Math.round(r.fix_rate * 100),
    f2p_total: r.f2p_total,
    f2p_passed: r.f2p_passed,
    p2p_total: r.p2p_total,
    p2p_passed: r.p2p_passed,
    all_p2p_pass: r.all_p2p_pass,
    candidate_applied: r.candidate_applied,
    testpatch_applied: r.testpatch_applied,
    timed_out: r.timed_out,
    duration_s: Math.round(r.duration_s),
    parsed_test_count: r.parsed_test_count,
    f2p_status: r.f2p_status,
    p2p_failures: r.p2p_failures,
  };
}

export function createSweEvo(opts: { dbPath?: string } = {}) {
  const dbPath = opts.dbPath ?? "./swe-evo.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  const api = createSmithers(schemas, { dbPath });
  const { smithers, Workflow, Task, Sequence, outputs } = api as any;

  const claudeModel = process.env.SWEEVO_CLAUDE_MODEL ?? "opus";
  const codexModel = process.env.SWEEVO_CODEX_MODEL;

  const workflow = smithers((ctx: any) => {
    const instance = ctx.input as Instance;
    const workdir = workdirFor(instance.instance_id);

    // Opus 4.8 drafts; Codex (gpt-5.5) refines. Both edit the SAME real checkout.
    const opus = new ClaudeCodeAgent({
      cwd: workdir,
      model: claudeModel,
      dangerouslySkipPermissions: true,
      timeoutMs: AGENT_TIMEOUT_MS,
      maxOutputBytes: 8_000_000,
    });
    const codex = new CodexAgent({
      cwd: workdir,
      ...(codexModel ? { model: codexModel } : {}),
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      timeoutMs: AGENT_TIMEOUT_MS,
      maxOutputBytes: 8_000_000,
    });

    return (
      <Workflow name="swe-evo">
        <Sequence>
          <Task id="prepare" output={outputs.prepare}>
            {() => prepareRepo(instance)}
          </Task>
          <Task
            id="implement"
            output={outputs.implement}
            agent={opus}
            timeoutMs={AGENT_TIMEOUT_MS}
            heartbeatTimeoutMs={900_000}
            retries={1}
          >
            {implementPrompt(instance)}
          </Task>
          <Task
            id="refine"
            output={outputs.refine}
            agent={codex}
            timeoutMs={AGENT_TIMEOUT_MS}
            heartbeatTimeoutMs={900_000}
            retries={1}
          >
            {refinePrompt(instance)}
          </Task>
          <Task id="diff" output={outputs.diff}>
            {() => captureDiff(instance)}
          </Task>
          <Task id="score" output={outputs.score}>
            {() =>
              // The run input carries no gold fields (see run.ts:toRunInput), so
              // reload the full instance (gold patch + hidden tests) from disk.
              toScoreRow(
                scoreCandidate(
                  loadInstance(instance.instance_id),
                  captureDiff(instance).patch,
                  SCORE_TIMEOUT_S,
                ),
              )
            }
          </Task>
        </Sequence>
      </Workflow>
    );
  });

  return { ...api, workflow };
}
