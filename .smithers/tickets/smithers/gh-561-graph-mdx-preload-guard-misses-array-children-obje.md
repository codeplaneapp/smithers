# 🐛 graph: MDX-preload guard misses array children — "[object Object],[object Object]" becomes the agent prompt

GitHub: https://github.com/smithersai/smithers/issues/561

**What happens**
In core extract (packages/graph/src/extract.js:615-618) the agent prompt is `String(raw.children ?? "")` and the MDX-preload guard only checks `prompt === "[object Object]"`. The same pattern exists in the legacy extractor (packages/graph/src/dom/extract.js:793-797).

**Why it's wrong / failure scenario**
When MDX preload is inactive and a task has MULTIPLE unstringified object children, `String(children)` stringifies the array: `"[object Object],[object Object]"` — or a mix like `"intro text,[object Object]"`. The exact-equality guard misses it, so instead of failing fast with `MDX_PRELOAD_INACTIVE`, the garbage string is silently sent to the agent as its prompt.

**Expected**
Detect `"[object Object]"` appearing anywhere in the coerced prompt (e.g. `prompt.includes("[object Object]")`) in both extractors.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
