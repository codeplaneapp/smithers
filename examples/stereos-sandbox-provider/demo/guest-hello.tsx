/** @jsxImportSource smthrs */
/**
 * `hello`, executed inside the stereOS guest.
 *
 * The provider bundles this module on the host, uploads the bundle over SSH,
 * and the guest's Bun binary runs it. The greeting string is built in the VM.
 */
import { createSmithers } from "smthrs";
import { z } from "zod";
import { guestFacts, guestFactsSchema } from "./guest-facts.ts";

export const helloResultSchema = z.object({
  message: z.string(),
  guest: guestFactsSchema,
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ name: z.string() }),
  result: helloResultSchema,
});

/** The child-workflow body. This function executes only in-guest. */
export async function executeGuestWork(name: string) {
  const guest = await guestFacts();
  return { message: `Hello, ${name} - from ${guest.user}@${guest.hostname} on ${guest.kernel}`, guest };
}

export default smithers((ctx) => (
  <Workflow name="hello-guest">
    <Task id="greet" output={outputs.result}>
      {() => executeGuestWork(ctx.input.name)}
    </Task>
  </Workflow>
));

// createCommandSandboxProvider writes the request path into the environment.
// Bun runs this bundled module as the guest entrypoint and this branch writes
// the provider result. Importing the module on the host does not enter it.
if (import.meta.main) {
  const requestPath = process.env.SMITHERS_SANDBOX_REQUEST_PATH;
  const resultPath = process.env.SMITHERS_SANDBOX_RESULT_PATH;
  if (!requestPath || !resultPath) throw new Error("Smithers sandbox protocol paths are unset");
  const request = await Bun.file(requestPath).json();
  const output = await executeGuestWork(z.string().parse(request.input?.name));
  const result = JSON.stringify({ status: "finished", output });
  await Bun.write(resultPath, result);
  process.stdout.write(`${result}\n`);
}
