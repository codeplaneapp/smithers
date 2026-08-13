/** @jsxImportSource smthrs */
/**
 * hello - the smallest demo run. One `<Sandbox>` whose body executes inside a
 * booted stereOS VM over the SSH provider.
 */
import { createSmithers, Sandbox } from "smthrs";
import { z } from "zod";
import childWorkflow, { helloResultSchema } from "../guest-hello.tsx";
import { createStereosProvider } from "../stereos-provider.ts";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({ name: z.string().default("stereOS") }),
  result: helloResultSchema,
});

const provider = createStereosProvider({ id: "hello", guestEntry: "guest-hello.tsx" });

export default smithers((ctx) => (
  <Workflow name="hello">
    <Sandbox
      id="stereos-vm"
      provider={provider}
      workflow={childWorkflow}
      input={{ name: ctx.input?.name ?? "stereOS" }}
      output={outputs.result}
      allowNetwork
      reviewDiffs={false}
      timeoutMs={120_000}
      retries={1}
    />
  </Workflow>
));
