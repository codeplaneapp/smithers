// Deterministic fixture workflow for phase1 issue sweep eval. Demonstrates
// parallel per-item lanes with correction loops, then serial merge queue landing.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const issueSchema = z.object({
  id: z.string(),
  title: z.string(),
});

const inputSchema = z.object({
  issues: z.array(issueSchema).default([
    { id: "i1", title: "Fix type error" },
    { id: "i2", title: "Add missing test" },
  ]),
});

const triageSchema = z.object({
  issueId: z.string(),
  priority: z.enum(["p0", "p1", "p2"]).default("p1"),
});

const fixSchema = z.object({
  issueId: z.string(),
  attempt: z.number().int().default(0),
  status: z.enum(["done", "partial"]).default("partial"),
  summary: z.string().default(""),
});

const verifySchema = z.object({
  issueId: z.string(),
  attempt: z.number().int().default(0),
  approved: z.boolean().default(false),
  feedback: z.string().default(""),
});

const mergeSchema = z.object({
  issueId: z.string(),
  status: z.enum(["merged", "conflict"]).default("merged"),
});

const { Workflow, Task, Sequence, Parallel, Loop, MergeQueue, smithers, outputs } = createSmithers({
  input: inputSchema,
  triage: triageSchema,
  fix: fixSchema,
  verify: verifySchema,
  merge: mergeSchema,
});

export default smithers((ctx) => {
  const issues = ctx.input.issues ?? [];

  return (
    <Workflow name="issue-sweep">
      <Sequence>
        {/* Triage each issue once. */}
        <Parallel maxConcurrency={10}>
          {issues.map((issue) => (
            <Task
              key={`${issue.id}:triage`}
              id={`${issue.id}:triage`}
              output={outputs.triage}
            >
              {() => ({
                issueId: issue.id,
                priority: issue.id === "i1" ? "p0" : "p1",
              })}
            </Task>
          ))}
        </Parallel>

        {/* Fix → verify loop for each issue, in parallel. */}
        <Parallel maxConcurrency={2}>
          {issues.map((issue) => {
            const key = issue.id;
            // Loop until the latest verification is approved.
            // ctx.latest reads the most recent output across ALL iterations.
            const latestVerify = ctx.latest(outputs.verify, `${key}:verify`);
            const isDone = latestVerify?.approved === true;

            return (
              <Loop
                key={`${key}:loop`}
                id={`${key}:loop`}
                until={isDone}
                maxIterations={2}
                onMaxReached="return-last"
              >
                <Sequence>
                    <Task
                      id={`${key}:fix`}
                      output={outputs.fix}
                    >
                      {() => {
                        // outputMaybe reads a specific output from the prior iteration.
                        const priorFix = ctx.outputMaybe(outputs.fix, {
                          nodeId: `${key}:fix`,
                          iteration: ctx.iteration,
                        });
                        return {
                          issueId: key,
                          attempt: ctx.iteration,
                          status: ctx.iteration > 0 ? "done" : "partial",
                          summary: priorFix ? "Improved from feedback" : "Initial fix",
                        };
                      }}
                    </Task>
                    <Task
                      id={`${key}:verify`}
                      output={outputs.verify}
                    >
                      {() => {
                        // Use ctx.latest to check the current iteration's fix.
                        const currentFix = ctx.latest(outputs.fix, `${key}:fix`);
                        return {
                          issueId: key,
                          attempt: ctx.iteration,
                          approved: currentFix?.status === "done",
                          feedback: currentFix?.status === "partial" ? "Needs more work" : "",
                        };
                      }}
                    </Task>
                </Sequence>
              </Loop>
            );
          })}
        </Parallel>

        {/* Serial merge queue: land approved issues one at a time. */}
        <MergeQueue id="merge-queue" maxConcurrency={1}>
          {issues.map((issue) => {
            const latestVerify = ctx.latest(outputs.verify, `${issue.id}:verify`);
            const shouldMerge = latestVerify?.approved === true;

            return shouldMerge ? (
              <Task
                key={`${issue.id}:merge`}
                id={`${issue.id}:merge`}
                output={outputs.merge}
              >
                {() => ({
                  issueId: issue.id,
                  status: "merged" as const,
                })}
              </Task>
            ) : null;
          })}
        </MergeQueue>
      </Sequence>
    </Workflow>
  );
});
