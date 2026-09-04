# text/

Tiny text helpers shared across prompts, PR bodies, and rendering.

- `fenceFor.ts` — picks a code fence longer than any backtick run in untrusted
  content, so embedded diffs/snippets cannot break out of their fence
  (prompt-injection and markdown-escape defense).
- `pluralize.ts` — `count + noun`; defaults to an `s` suffix, with an optional
  irregular-plural override.
- `trimDiff.ts` — per-file diff cap for agent prompts.

These are the canonical copies; import from here rather than duplicating them
in feature directories.
