// smithers-source: authored
// smithers-display-name: UltraGrill
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { createSmithers, Loop, Parallel, Sequence, Task, WaitForEvent } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

/**
 * UltraGrill — real-time, open-ended collaboration with worker agents.
 *
 * One durable run, two concurrent planes (the proposal's model, grounded in real
 * primitives and validated end-to-end against the engine):
 *
 *   • INTAKE — a keep-alive <Loop> of <WaitForEvent event="utterance">. The UI
 *     posts each thing you say/type as a `utterance` signal; the loop wakes,
 *     records it, and waits for the next. An utterance with `end: true` stops the
 *     whole session (D8 — open-ended until you end it).
 *   • WORKERS — one <Task> per non-end utterance (dynamic dispatch: the durable
 *     list of utterances is `.map()`-ed to worker tasks, the dynamic-demo trick).
 *     Each worker carries out the directive, folds it into a LIVING markdown
 *     artifact it rewrites on disk (D7 — the artifact is the spec, kept in sync),
 *     and returns a rolling set of clarifying `questions`.
 *
 * The rolling question pool (proposal §3②) is surfaced from the latest worker's
 * `questions`: the UI shows them as cards you can answer (by saying the next
 * thing) or ignore (the next worker turn replaces them). This is the reliable v1
 * of the pool. The durable-<HumanTask>-with-TTL pool (D6) and voice/dev-server
 * (D1/D5) are follow-ons — the proposal's own #1 risk (interleaving many async
 * durable waits in a never-ending run) is real; this design keeps a single
 * durable wait in flight at a time, so the run cycles deterministically.
 */

const utteranceSchema = z.object({
  text: z.string().default(""),
  end: z.boolean().default(false),
});

const workSchema = z.object({
  summary: z.string(),
  artifact: z.string().default(""),
  questions: z.array(z.string().trim().min(1)).max(4).default([]),
});

export const inputSchema = z.object({
  goal: z.string().trim().min(1).default("Collaborate with me in real time."),
  artifactPath: z.string().trim().min(1).default(".smithers/artifacts/ultragrill-spec.md"),
  turnTimeoutMs: z.number().int().min(1).max(3_600_000).default(120_000),
  maxTurns: z.number().int().min(1).max(1_000).default(50),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  utterance: utteranceSchema,
  work: workSchema,
});

type Utterance = z.infer<typeof utteranceSchema>;
type Work = z.infer<typeof workSchema> & { nodeId?: string; iteration?: number };

function workerPrompt(opts: {
  goal: string;
  artifactPath: string;
  utterance: string;
  index: number;
  priorArtifact: string;
}): string {
  const priorBlock = opts.priorArtifact
    ? `\n\nCURRENT LIVING SPEC (update it in place, don't start over):\n\n${opts.priorArtifact}`
    : "";
  return `You are a worker on a real-time collaboration session.

Session goal: ${opts.goal}

The user just said (directive #${opts.index + 1}):
"${opts.utterance}"${priorBlock}

Do this, then return your result:
1. Carry out the directive as far as you can this turn (edit code, run commands — this is a shared repo, work directly).
2. Keep a LIVING markdown spec in sync: read ${opts.artifactPath} if present, fold in what this directive changes, and write the full updated markdown back to ${opts.artifactPath} (create it if missing). Markdown-first, HTML-renderable — headings, lists, short prose.
3. Return: a one-line \`summary\` of what you did, the FULL current markdown of the spec in \`artifact\`, and 1–4 short \`questions\` whose answers would sharpen the next turn (the user answers by saying the next thing, or ignores them).`;
}

export default smithers((ctx) => {
  const goal = ctx.input.goal ?? "Collaborate with me in real time.";
  const artifactPath = ctx.input.artifactPath ?? ".smithers/artifacts/ultragrill-spec.md";
  const maxTurns = ctx.input.maxTurns ?? 50;
  const turnTimeoutMs = ctx.input.turnTimeoutMs ?? 120_000;
  const utterances = (ctx.outputs.utterance ?? []) as Utterance[];
  const endIndex = utterances.findIndex((u) => u.end === true);
  const accepted = endIndex >= 0 ? utterances.slice(0, endIndex) : utterances;
  const directives = accepted.filter((u) => !u.end && u.text.trim().length > 0);
  const ended = endIndex >= 0;
  const works = (ctx.outputs.work ?? []) as Work[];
  const artifactBefore = (index: number) => {
    if (index <= 0) return "";
    const prior = works.filter((work) => work.nodeId === `worker:${index - 1}`).at(-1);
    return prior?.artifact ?? "";
  };

  return (
    <Workflow name="ultragrill">
      <UI entry="../ui/ultragrill.tsx" title={"UltraGrill"} />
      <Parallel>
        {/* ── intake plane: drain utterances until the user ends the session ── */}
        <Loop id="intake" until={ended} maxIterations={maxTurns}>
          <WaitForEvent
            id="utterance"
            event="utterance"
            correlationId="utterance"
            output={outputs.utterance}
            timeoutMs={turnTimeoutMs}
            onTimeout="continue"
          />
        </Loop>

        {/* ── worker plane: one worker per directive (dynamic dispatch) ────── */}
        <Sequence>
          {directives.map((u, i) => (
            <Task
              key={`worker-${i}`}
              id={`worker:${i}`}
              output={outputs.work}
              agent={agents.implement}
              dependsOn={i > 0 ? [`worker:${i - 1}`] : undefined}
            >
              {workerPrompt({
                goal,
                artifactPath,
                utterance: u.text,
                index: i,
                priorArtifact: artifactBefore(i),
              })}
            </Task>
          ))}
        </Sequence>
      </Parallel>
    </Workflow>
  );
});
