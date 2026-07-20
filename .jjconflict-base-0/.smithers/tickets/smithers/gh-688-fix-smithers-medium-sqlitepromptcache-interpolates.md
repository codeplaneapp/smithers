# 🔒 fix(smithers): [medium] SqlitePromptCache interpolates unvalidated table names

GitHub: https://github.com/smithersai/smithers/issues/688

via /codex review (pass 3)

Refs:
- `.smithers/components/extract-prompt/SqlitePromptCache.ts:7` exposes `SqlitePromptCacheOptions`.
- `.smithers/components/extract-prompt/SqlitePromptCache.ts:11` allows callers to override `table`.
- `.smithers/components/extract-prompt/SqlitePromptCache.ts:23` stores that option directly.
- `.smithers/components/extract-prompt/SqlitePromptCache.ts:31` interpolates it into `SELECT`.
- `.smithers/components/extract-prompt/SqlitePromptCache.ts:40` interpolates it into `INSERT`.
- `.smithers/components/extract-prompt/SqlitePromptCache.ts:49` interpolates it into `DELETE`.
- `.smithers/components/extract-prompt/SqlitePromptCache.ts:54` interpolates it into `SELECT key`.
- `.smithers/components/extract-prompt/SqlitePromptCache.ts:69` interpolates it into `CREATE TABLE`.

Failure scenario:
A workflow or reusable component constructs `new SqlitePromptCache({ table })` from config/input. A benign table like `extract-prompt-cache` causes SQL syntax errors because the identifier is not quoted. A malicious value can alter the generated SQL text for every cache operation; even if multi-statement execution is not available in every call path, injected clauses or malformed identifiers can read from/delete from the wrong table or permanently break the cache initialization.

Why it matters:
The cache API presents `table` as a plain option, but every method treats it as trusted SQL. That is both a correctness footgun for normal names and a SQL injection surface when workflows pass through user-provided config. Validate the option as a strict SQL identifier (for example `[A-Za-z_][A-Za-z0-9_]*`) or quote identifiers centrally with proper escaping before interpolation.
