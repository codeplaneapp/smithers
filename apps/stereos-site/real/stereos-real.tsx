/** @jsxImportSource smthrs */
/**
 * A Smithers run whose work happens inside a real stereOS mixtape VM.
 *
 * Boot the VM first, then run this workflow:
 *
 *   cd apps/stereos-site/real
 *   mb up                                   # boots the mixtape (~8s)
 *   eval "$(./bootstrap-vm.sh)"             # keys the agent user, exports the port
 *   env -u ANTHROPIC_API_KEY bun ../../../apps/cli/src/index.js up stereos-real.tsx \
 *     --input '{"prompt":"hello from the host"}'
 *
 * See real/README.md for the full recipe and the recorded run.
 */
import { createSmithers, Sandbox } from "smthrs";
import { z } from "zod";
import childWorkflow, { guestResultSchema } from "./child-workflow.tsx";
import { stereosProvider } from "./stereos-provider.ts";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({ prompt: z.string().default("hello from the host") }),
  result: guestResultSchema,
});

export default smithers((ctx) => (
  <Workflow name="stereos-real">
    <Sandbox
      id="stereos-vm"
      provider={stereosProvider}
      workflow={childWorkflow}
      input={{ prompt: ctx.input.prompt }}
      output={outputs.result}
      allowNetwork
      reviewDiffs={false}
      timeoutMs={120_000}
      retries={1}
    />
  </Workflow>
));
