# 🐛 conventions/loader: [medium] a frontmatter-less companion .md silently suppresses the executable file's block-comment frontmatter

GitHub: https://github.com/smithersai/smithers/issues/719

_via ultracode (Opus multi-agent) review_

## Summary
`readSourceForFrontmatter` prefers a companion `.md` whenever it is *readable*, without checking that the `.md` actually contains a frontmatter block — so a prose-only `foo.workflow.md` next to `foo.workflow.ts` discards the executable file's real `/* --- ... --- */` block-comment frontmatter.

## Location
- `packages/agent-eliza/src/conventions/loader.js:61-68` — `readSourceForFrontmatter` returns `await readFile(companionMd, "utf8")` and only falls back to `execSource` inside `catch` (file absent).
- `packages/agent-eliza/src/conventions/frontmatter.js:46-48` — a `.md` with no leading `---` block yields `{ frontmatter: {} }`.
- `packages/agent-eliza/src/conventions/loader.js:113-114, 116-142` — `buildDefinition`: for the bare-workflow-export shape `raw = {}`, so all metadata comes from `frontmatter`.

## Failure scenario
`cleanup.workflow.ts` uses block-comment frontmatter `name: cleanup / system: true / disable-model-invocation: true` and default-exports a bare workflow object (no name/system fields on the export). An author drops a sibling `cleanup.workflow.md` containing only prose (human docs, no `---` YAML).

`readSourceForFrontmatter` reads the `.md`, `parseWorkflowFrontmatter` returns `{}`, and `buildDefinition` falls through to `nameFromFile` (`'cleanup'`) with `system` / `disableModelInvocation` / `version` / `tags` all `undefined`. The workflow that was explicitly marked internal now appears in default listings and in `formatWorkflowsForPrompt` output (which hides only `system`/`disable-model-invocation` workflows), i.e. it becomes model-invocable against the author's explicit opt-out.

## Why it matters
Frontmatter drives visibility, model-invocability, naming, and versioning. Silently discarding it based on the mere existence of a docs `.md` flips a hidden/internal workflow into a publicly listed, model-invocable one — a safety/correctness regression. No test covers it: the block-comment test (`tests/conventions.test.ts:544`) ships no companion `.md`, and every companion-`.md` test supplies real `---` frontmatter and duplicates metadata on the export, masking the loss.

## Fix
In `readSourceForFrontmatter`, only use the `.md` when it actually contains a frontmatter block (e.g. `parseWorkflowFrontmatter(md)` finds one, or the text starts with `---`); otherwise return `execSource`.
