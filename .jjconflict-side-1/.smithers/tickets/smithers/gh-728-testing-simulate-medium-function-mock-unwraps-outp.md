# 🐛 testing(simulate): [medium] function-mock unwraps `{output}` without validating, breaking mocks whose schema has an `output` field

GitHub: https://github.com/smithersai/smithers/issues/728

_via ultracode (Opus multi-agent) review_

**Summary:** `simulate()`'s function-mock branch blindly unwraps any returned object containing an `output` key, so a correctly-shaped mock for a task whose output schema itself has an `output` field is silently truncated and then rejected.

**Location:** `packages/testing/src/simulate.ts:243-245`
```ts
if (isObject(result) && "output" in result) {
  return result.output;
}
```
No schema check — contrast `packages/testing/src/fakeAgent.ts:108-121`, whose `normalizeResult` treats `{output,...}` as a wrapper only when the nested `output` validates against the schema, otherwise falls through to bare-output.

**Failure scenario:** Task `grade` has `outputSchema z.object({ output: z.string(), score: z.number() })`. User writes `mocks: { grade: () => ({ output: "A", score: 95 }) }` — an exact schema match. `materializeMock` sees `"output" in result` and returns just `"A"`, dropping `score`. `validateTaskOutput` (simulate.ts:147-154) then parses `"A"` against the object schema, fails, and `simulate()` throws `INVALID_OUTPUT` on a correct mock.

**Why it matters:** `simulate()` is a test helper meant to be trustworthy. A valid mock is silently mangled and rejected, producing a confusing failure and blocking a legitimate use case (schemas with an `output` field). Fix: reuse the validate-then-unwrap logic from `fakeAgent.normalizeResult` — only unwrap when `result.output` validates against `task.outputSchema`, otherwise treat the whole result as the bare output.
