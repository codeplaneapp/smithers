/** @jsxImportSource smthrs */
/**
 * pipeline - a `<Sequence>` whose second stage is a `<Sandbox>` running in a
 * booted stereOS VM. The host prepares the input, the guest does the work, and
 * the host summarizes what the guest returned, so the run exercises real output
 * persistence and dependency resolution across the host/guest boundary.
 */
import { createSmithers, Sandbox, Sequence, Task } from "smthrs";
import { z } from "zod";
import childWorkflow, { pipelineResultSchema } from "../guest-pipeline.tsx";
import { createStereosProvider } from "../stereos-provider.ts";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({ text: z.string().default("Smithers runs this inside a real VM") }),
  prepared: z.object({ text: z.string(), chars: z.number() }),
  computed: pipelineResultSchema,
  summary: z.object({ report: z.string(), ranOn: z.string() }),
});

const provider = createStereosProvider({ id: "pipeline", guestEntry: "guest-pipeline.tsx" });

export default smithers((ctx) => {
  // Gateway UI discovery renders the workflow with no input, so read the text
  // defensively rather than through the parsed default.
  const text = ctx.input?.text ?? "Smithers runs this inside a real VM";
  return (
    <Workflow name="pipeline">
      <Sequence>
        <Task id="prepare" output={outputs.prepared}>
          {{ text, chars: text.length }}
        </Task>

        <Sandbox
          id="stereos-vm"
          provider={provider}
          workflow={childWorkflow}
          input={{ text }}
          output={outputs.computed}
          allowNetwork
          reviewDiffs={false}
          timeoutMs={120_000}
          retries={1}
        />

        {/* The dep key is resolved as an upstream task id, so `needs` points it
            at the sandbox node that actually produces this output. */}
        <Task
          id="report"
          output={outputs.summary}
          deps={{ computed: outputs.computed }}
          needs={{ computed: "stereos-vm" }}
        >
          {(deps) => ({ report: deps.computed.report, ranOn: deps.computed.guest.hostname })}
        </Task>
      </Sequence>
    </Workflow>
  );
});
