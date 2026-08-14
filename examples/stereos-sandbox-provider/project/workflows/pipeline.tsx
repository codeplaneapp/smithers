/** @jsxImportSource smthrs */
// Three literal Tasks in a Sequence. Each task reads the previous task's
// output through `deps`, so the run exercises real output persistence and
// dependency resolution without an agent.
import { openSmithersBackend, Sequence, Task } from "smthrs";
import { z } from "zod";

const { Workflow, smithers, outputs } = await openSmithersBackend({
  input: z.object({ text: z.string() }),
  normalized: z.object({ value: z.string() }),
  counted: z.object({ value: z.string(), words: z.number() }),
  summary: z.object({ report: z.string() }),
});

export default smithers((ctx) => (
  <Workflow name="pipeline">
    <Sequence>
      <Task id="normalize" output={outputs.normalized}>
        {{ value: ctx.input.text.trim().toLowerCase() }}
      </Task>

      <Task id="count" output={outputs.counted} deps={{ normalize: outputs.normalized }}>
        {(deps) => ({
          value: deps.normalize.value,
          words: deps.normalize.value.split(/\s+/).filter(Boolean).length,
        })}
      </Task>

      <Task id="report" output={outputs.summary} deps={{ count: outputs.counted }}>
        {(deps) => ({
          report: `${deps.count.words} word(s): ${deps.count.value}`,
        })}
      </Task>
    </Sequence>
  </Workflow>
));
