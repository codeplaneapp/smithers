/** @jsxImportSource smthrs */
/**
 * `pipeline`, executed inside the stereOS guest.
 *
 * Three dependent stages run in the VM: normalize the input text, count its
 * words, then compute a prime sieve whose upper bound is derived from the
 * input, so the reported numbers change with the input the visitor sends.
 */
import { createSmithers } from "smthrs";
import { z } from "zod";
import { guestFacts, guestFactsSchema } from "./guest-facts.ts";

export const pipelineResultSchema = z.object({
  normalized: z.string(),
  words: z.number(),
  report: z.string(),
  computation: z.object({
    upperBound: z.number(),
    primeCount: z.number(),
    primeSum: z.number(),
    lastPrime: z.number(),
  }),
  guest: guestFactsSchema,
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ text: z.string() }),
  result: pipelineResultSchema,
});

function primesThrough(upperBound: number) {
  const composite = new Uint8Array(upperBound + 1);
  let primeCount = 0;
  let primeSum = 0;
  let lastPrime = 0;
  for (let candidate = 2; candidate <= upperBound; candidate += 1) {
    if (composite[candidate]) continue;
    primeCount += 1;
    primeSum += candidate;
    lastPrime = candidate;
    if (candidate * candidate <= upperBound) {
      for (let multiple = candidate * candidate; multiple <= upperBound; multiple += candidate) {
        composite[multiple] = 1;
      }
    }
  }
  return { upperBound, primeCount, primeSum, lastPrime };
}

/** The child-workflow body. This function executes only in-guest. */
export async function executeGuestWork(text: string) {
  const normalized = text.trim().toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean).length;
  const bytes = new TextEncoder().encode(normalized);
  const upperBound = 20_000 + (bytes.reduce((sum, byte) => sum + byte, 0) % 5_000);
  const computation = primesThrough(upperBound);
  const guest = await guestFacts();
  return {
    normalized,
    words,
    report: `${words} word(s), ${computation.primeCount} primes below ${upperBound}, computed on ${guest.hostname}`,
    computation,
    guest,
  };
}

export default smithers((ctx) => (
  <Workflow name="pipeline-guest">
    <Task id="compute" output={outputs.result}>
      {() => executeGuestWork(ctx.input.text)}
    </Task>
  </Workflow>
));

if (import.meta.main) {
  const requestPath = process.env.SMITHERS_SANDBOX_REQUEST_PATH;
  const resultPath = process.env.SMITHERS_SANDBOX_RESULT_PATH;
  if (!requestPath || !resultPath) throw new Error("Smithers sandbox protocol paths are unset");
  const request = await Bun.file(requestPath).json();
  const output = await executeGuestWork(z.string().parse(request.input?.text));
  const result = JSON.stringify({ status: "finished", output });
  await Bun.write(resultPath, result);
  process.stdout.write(`${result}\n`);
}
