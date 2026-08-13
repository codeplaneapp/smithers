/** @jsxImportSource smthrs */
/**
 * The child workflow the sandbox boundary carries.
 *
 * The stereOS provider ships this definition into the VM as part of the
 * request JSON and the guest runner produces the result, so nothing here
 * executes on the host. Once a mixtape carries a Smithers runner (Bun plus
 * `run-smithers-sandbox.js`), this body is what the guest would execute
 * instead — the shape is already the contract.
 */
import { createSmithers } from "smthrs";
import { z } from "zod";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({ prompt: z.string() }),
  result: z.object({
    summary: z.string(),
    prompt: z.string(),
    promptSha256: z.string(),
    guest: z.record(z.string(), z.unknown()),
    restrictions: z.record(z.string(), z.string()),
    harnessesOnPath: z.string(),
  }),
});

export { outputs as childOutputs };

export default smithers(() => (
  <Workflow name="stereos-guest-work">{/* Executed by the guest runner inside the VM, not by the host. */}</Workflow>
));
