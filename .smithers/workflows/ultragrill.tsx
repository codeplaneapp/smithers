// smithers-source: authored
// smithers-display-name: UltraGrill
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Loop, Parallel, Task, WaitForEvent } from "smithers-orchestrator";
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
  questions: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  goal: z.string().default("Collaborate with me in real time."),
  artifactPath: z.string().default(".smithers/artifacts/ultragrill-spec.md"),
  turnTimeoutMs: z.number().int().default(120_000),
  maxTurns: z.number().int().default(50),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  utterance: utteranceSchema,
  work: workSchema,
});

type Utterance = z.infer<typeof utteranceSchema>;
type Work = z.infer<typeof workSchema>;

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
  const utterances = (ctx.outputs.utterance ?? []) as Utterance[];
  const directives = utterances.filter((u) => !u.end);
  const ended = utterances.some((u) => u.end === true);
  const works = (ctx.outputs.work ?? []) as Work[];
  const priorArtifact = works.length ? works[works.length - 1].artifact : "";

  return (
    <Workflow name="ultragrill">
      <Parallel>
        {/* ── intake plane: drain utterances until the user ends the session ── */}
        <Loop id="intake" until={ended} maxIterations={ctx.input.maxTurns}>
          <WaitForEvent
            id="utterance"
            event="utterance"
            correlationId="utterance"
            output={outputs.utterance}
            timeoutMs={ctx.input.turnTimeoutMs}
            onTimeout="continue"
          />
        </Loop>

        {/* ── worker plane: one worker per directive (dynamic dispatch) ────── */}
        {directives.map((u, i) => (
          <Task key={`worker-${i}`} id={`worker:${i}`} output={outputs.work} agent={agents.smart}>
            {workerPrompt({
              goal: ctx.input.goal,
              artifactPath: ctx.input.artifactPath,
              utterance: u.text,
              index: i,
              priorArtifact,
            })}
          </Task>
        ))}
      </Parallel>
    </Workflow>
  );
});
