# 🐛 memory: Summarizer agent.run failures escape as UnknownException instead of SmithersError

GitHub: https://github.com/smithersai/smithers/issues/532

**What happens**
`packages/memory/src/Summarizer.js:73`: `yield* Effect.tryPromise(() => agent.run(prompt))` uses the single-argument form, so a rejected `agent.run` surfaces as `UnknownException` in the Effect error channel.

**Why it's wrong**
Both the local JSDoc (`@returns {Effect.Effect<void, SmithersError>}`) and the `MemoryProcessor` contract (`packages/memory/src/MemoryProcessor.ts:8`: `processEffect: (store) => Effect.Effect<void, SmithersError>`) promise a typed `SmithersError` channel. Callers matching on SmithersError code/details get an untyped `UnknownException` instead. The store layer already does this correctly (`MemoryStoreLive.js` uses `Effect.tryPromise({ try, catch })` with error mapping). The mismatch is invisible to `tsc` today only because `checkJs` is not enabled in packages/memory.

**Expected behavior**
`Effect.tryPromise({ try: () => agent.run(prompt), catch: (cause) => toSmithersError(cause, ...) })` so summarizer agent failures stay inside the declared error type.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
