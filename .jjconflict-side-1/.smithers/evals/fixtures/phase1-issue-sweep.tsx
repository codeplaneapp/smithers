// Deterministic fixture workflow for phase1 issue-sweep eval suite. Demonstrates
// parallel per-item correction loops, ctx.latest in loop conditions, and global
// MergeQueue for landing. Compute nodes only: all lanes run locally without agent calls.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    title: z.string(),
    needsFix: z.boolean().default(true),
  })).default([
    { id: "item-1", title: "Auth flow", needsFix: true },
    { id: "item-2", title: "Rate limit", needsFix: false },
    { id: "item-3", title: "Error handler", needsFix: true },
  ]),
  maxCorrections: z.number().int().min(1).max(10).default(3),
});

const scanSchema = z.object({
  itemId: z.string(),
  title: z.string(),
  issues: z.array(z.string()),
  ready: z.boolean(),
});

const correctSchema = z.object({
  itemId: z.string(),
  attempt: z.number().int(),
  fixed: z.boolean(),
  evidence: z.string(),
});

const verifySchema = z.object({
  itemId: z.string(),
  headSha: z.string(),
  approved: z.boolean(),
  feedback: z.string().default(""),
});

const landSchema = z.object({
  itemId: z.string(),
  merged: z.boolean(),
  summary: z.string(),
});

const { Workflow, Task, Sequence, Parallel, Loop, MergeQueue, smithers, outputs } = createSmithers({
  input: inputSchema,
  scan: scanSchema,
  correct: correctSchema,
  verify: verifySchema,
  land: landSchema,
});

function needsCorrection(ctx: any, itemId: string): boolean {
  const latest = ctx.latest(outputs.correct, `${itemId}:correct`) as z.infer<typeof correctSchema> | undefined;
  return !latest || !latest.fixed;
}

export default smithers((ctx) => {
  const items = (ctx.input?.items ?? [
    { id: "item-1", title: "Auth flow", needsFix: true },
    { id: "item-2", title: "Rate limit", needsFix: false },
  ]).filter((item) => item.needsFix);
  const maxCorrections = ctx.input?.maxCorrections ?? 3;

  return (
    <Workflow name="phase1-issue-sweep">
      {items.length > 0 ? (
        <Sequence>
          <Parallel id="parallel-scan" maxConcurrency={4}>
            {items.map((item) => (
              <Task key={item.id} id={`${item.id}:scan`} output={outputs.scan}>
                {() => ({
                  itemId: item.id,
                  title: item.title,
                  issues: ["issue1", "issue2"],
                  ready: true,
                })}
              </Task>
            ))}
          </Parallel>

          <Parallel id="parallel-correction-loops" maxConcurrency={3}>
            {items.map((item) => {
              const latest = ctx.latest(outputs.correct, `${item.id}:correct`) as z.infer<typeof correctSchema> | undefined;
              const isFixed = latest?.fixed ?? false;

              return (
                <Loop
                  key={item.id}
                  id={`${item.id}:correction-loop`}
                  maxIterations={maxCorrections}
                  until={isFixed}
                  onMaxReached="return-last"
                >
                  <Sequence>
                    <Task
                      id={`${item.id}:correct`}
                      output={outputs.correct}
                      continueOnFail
                    >
                      {() => {
                        const iterationCount = ctx.iteration;
                        return {
                          itemId: item.id,
                          attempt: iterationCount,
                          fixed: iterationCount === maxCorrections - 1,
                          evidence: `Fixed after iteration ${iterationCount}`,
                        };
                      }}
                    </Task>

                    <Task
                      id={`${item.id}:verify`}
                      output={outputs.verify}
                      continueOnFail
                    >
                      {() => {
                        const iterationCount = ctx.iteration;
                        const previousIteration = Math.max(0, iterationCount - 1);
                        const previous = ctx.outputMaybe(outputs.verify, { nodeId: `${item.id}:verify`, iteration: previousIteration });
                        return {
                          itemId: item.id,
                          headSha: `sha-${item.id}-${iterationCount}`,
                          approved: iterationCount > 0,
                          feedback: previous && !previous.approved ? "Reviewer rejected: " + previous.feedback : "Verification passed",
                        };
                      }}
                    </Task>
                  </Sequence>
                </Loop>
              );
            })}
          </Parallel>

          <MergeQueue id="landing-queue" maxConcurrency={1}>
            <Parallel id="landing-prep" subtreeConcurrency={1}>
              {items.map((item) => (
                <Task key={item.id} id={`${item.id}:land`} output={outputs.land}>
                  {() => ({
                    itemId: item.id,
                    merged: true,
                    summary: `Landed fix for ${item.title}`,
                  })}
                </Task>
              ))}
            </Parallel>
          </MergeQueue>
        </Sequence>
      ) : (
        <Task id="no-items" output={outputs.scan}>
          {() => ({
            itemId: "none",
            title: "No items to fix",
            issues: [],
            ready: false,
          })}
        </Task>
      )}
    </Workflow>
  );
});
