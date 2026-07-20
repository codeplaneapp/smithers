# 🐛 agent-eliza: unvalidated frontmatter tags/aliases crash the workflow formatter (`.join` on a string)

GitHub: https://github.com/smithersai/smithers/issues/531

**What happens**
`packages/agent-eliza/src/conventions/loader.js:125-126`: `buildDefinition` typeof-guards `name`/`description`/`system`/`version` from frontmatter but casts `frontmatter.tags` and `frontmatter.aliases` straight to `string[] | undefined` with no `Array.isArray` check.

**Why it's wrong / failure scenario**
YAML frontmatter like `tags: foo` parses to a plain string. It flows into `WorkflowDefinition.tags`, passes the formatter's guard (`w.tags && w.tags.length > 0` is true for a non-empty string), and then `w.tags.join(", ")` throws `TypeError: w.tags.join is not a function` (`packages/agent-eliza/src/conventions/formatter.js:49-54`) — one malformed user workflow file crashes prompt formatting for the whole listing.

**Expected behavior**
`Array.isArray(frontmatter.tags) ? frontmatter.tags.filter(t => typeof t === "string") : undefined` (same for aliases), mirroring the validation applied to the other frontmatter fields.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
