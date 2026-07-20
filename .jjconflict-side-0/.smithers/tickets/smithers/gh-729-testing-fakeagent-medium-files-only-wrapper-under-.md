# 🐛 testing(fakeAgent): [medium] files-only wrapper under a permissive schema silently drops declared files

GitHub: https://github.com/smithersai/smithers/issues/729

_via ultracode (Opus multi-agent) review_

`normalizeResult` treats a text/files-only wrapper as a bare output under a permissive schema, so declared files are never written.

**Where:** `packages/testing/src/fakeAgent.ts:108-120` (files dropped at `writeFiles`, line 176).

**Trace** for `{ text, files }` with no `output` key under `z.any()`:
- Line 108 `hasResponseKeys(result) && "output" in result` — `"output" in result` is false → wrapper branch skipped.
- Line 118 `schema.safeParse(result)` — `z.any()` validates the whole `{text,files}` object → returns `{ output: {text,files} }` (119-121).
- The text/files-honoring branch at 124-130 is never reached; `response.files` is `undefined`, so `writeFiles` (line 176) writes nothing.

**Failure scenario:**
```ts
const agent = fakeAgent(z.any(), { text: "done", files: { "out.txt": "hi\n" } });
await agent.generate({ rootDir: dir });
// out.txt is NOT created; result.output is the whole {text,files} wrapper.
```

**Why it matters:** A fake agent that only edits the workspace (files, no structured output) is a normal way to simulate a coding agent. Under a permissive/all-optional schema, the promised file writes silently don't happen, so file-content assertions fail for a non-obvious reason.

**Coverage gap:** The test at `fakeAgent.test.ts:71` only covers the `output+files` wrapper; the test at `:123` covers a files/text-only wrapper but under a *strict* schema. The files-only-wrapper-under-permissive-schema case is untested.

**Fix direction:** Disambiguate text/files wrapper intent before treating a value as a bare output under a permissive schema — e.g., when the value carries `text`/`files` keys but no `output`, honor the wrapper rather than validating the whole object as the output.
