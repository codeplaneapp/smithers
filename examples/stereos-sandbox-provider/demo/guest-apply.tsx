/** @jsxImportSource smthrs */
/**
 * The post-approval stage of `approval-demo`, executed inside the stereOS guest.
 *
 * The Approval gate itself is a host concern: the engine parks the run until a
 * decision arrives. Only the work the decision authorizes runs in the VM, so
 * the guest facts in the result are proof that the approved side effect
 * happened in the guest.
 */
import { createSmithers } from "smthrs";
import { z } from "zod";
import { guestFacts, guestFactsSchema } from "./guest-facts.ts";

export const applyResultSchema = z.object({
  status: z.string(),
  change: z.string(),
  appliedAt: z.string(),
  witness: z.string(),
  guest: guestFactsSchema,
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ change: z.string(), approved: z.boolean() }),
  result: applyResultSchema,
});

/** The child-workflow body. This function executes only in-guest. */
export async function executeGuestWork(change: string, approved: boolean) {
  const guest = await guestFacts();
  // The approved side effect is a real file write inside the guest workspace,
  // read back so the result reports what the guest filesystem actually holds.
  const path = `${process.env.HOME ?? "/home/agent"}/workspace/approved-change.txt`;
  let witness = "not written (denied)";
  if (approved) {
    const line = `${change} @ ${guest.hostname}`;
    await Bun.write(path, `${line}\n`);
    witness = (await Bun.file(path).text()).trim();
  }
  return {
    status: approved ? "applied" : "skipped",
    change,
    appliedAt: new Date().toISOString(),
    witness,
    guest,
  };
}

export default smithers((ctx) => (
  <Workflow name="apply-guest">
    <Task id="apply" output={outputs.result}>
      {() => executeGuestWork(ctx.input.change, ctx.input.approved)}
    </Task>
  </Workflow>
));

if (import.meta.main) {
  const requestPath = process.env.SMITHERS_SANDBOX_REQUEST_PATH;
  const resultPath = process.env.SMITHERS_SANDBOX_RESULT_PATH;
  if (!requestPath || !resultPath) throw new Error("Smithers sandbox protocol paths are unset");
  const request = await Bun.file(requestPath).json();
  const output = await executeGuestWork(
    z.string().parse(request.input?.change),
    z.boolean().parse(request.input?.approved),
  );
  const result = JSON.stringify({ status: "finished", output });
  await Bun.write(resultPath, result);
  process.stdout.write(`${result}\n`);
}
