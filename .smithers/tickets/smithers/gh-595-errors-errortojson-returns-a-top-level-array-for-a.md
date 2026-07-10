# 🐛 errors: errorToJson returns a top-level array for array input, violating its Record<string, unknown> contract

GitHub: https://github.com/smithersai/smithers/issues/595

**What happens**
`buildErrorJson`'s fallback `if (error && typeof error === "object") return error;` (packages/errors/src/errorToJson.js:129-131) passes arrays through, and `toJsonSafe` preserves them as arrays (lines 57-62). So `errorToJson([1])` returns `[1]` — `Array.isArray(...) === true` — while the JSDoc and generated d.ts declare `Record<string, unknown>`.

**Why it's wrong / failure scenario**
Effect failures (and `throw`) can carry arbitrary values, including arrays (e.g. an array of validation errors). The result flows to the engine's durable failed-task write path typed as a record; consumers that read `errorJson.message` / `errorJson.name` or spread it into an object get undefined fields or index keys, and a DB row expected to hold a JSON object holds a top-level array.

**Expected behavior**
Wrap non-record objects, e.g. arrays become `{ message: <stringified>, value: [...] }` (or similar), so the declared return type is always true. Alternatively, if array pass-through is desired, fix the declared type — but the durable write path suggests normalizing to a record is the right call.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
