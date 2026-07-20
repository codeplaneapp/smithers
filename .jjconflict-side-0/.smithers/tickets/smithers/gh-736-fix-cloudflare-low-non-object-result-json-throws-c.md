# 🐛 fix(cloudflare): [low] non-object result JSON throws cryptic `in` TypeError instead of guarded diagnostic

GitHub: https://github.com/smithersai/smithers/issues/736

_via ultracode (Opus multi-agent) review_

**Summary:** `parseCloudflareSandboxResult` runs `"bundlePath" in parsed` on a value that may be a JSON primitive, throwing a bare `TypeError` instead of the intended actionable error.

**Location:** `packages/cloudflare/src/index.js:181` (guard at :172, parse at :176-179).

**Failure scenario:** A sandbox workflow entry writes a JSON primitive — `null`, `"ok"`, `123`, or `true` — to the result file (or prints it to stdout). `rawResult.trim() !== ""` so the empty-result guard at line 172 passes. `JSON.parse` succeeds (returns the primitive), so the try/catch at 176-179 does not fire. Line 181 then evaluates `"bundlePath" in parsed`; the JS `in` operator requires an object on its right side and throws `TypeError: Cannot use 'in' operator to search for 'bundlePath' in null` for any primitive.

**Why it matters:** This parser exists to give operators a clear diagnostic ("the workflow entry must write result JSON …") when the in-sandbox entry misbehaves. A non-object result is a common entry bug, and the unguarded `in` replaces that diagnostic with an opaque crash that points at cloudflare internals rather than the user's entry script.

**Fix sketch:** After parsing, assert the result is a non-null object (e.g. `if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(...)` with the same style of message as line 173) before using the `in` operator or spreading `...parsed`.
