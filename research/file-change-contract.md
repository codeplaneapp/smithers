# Cross-harness file-change contract

> **Written for Smithers 0.x.** This note is research from before the 1.0
> rewrite. It describes the JSX workflow runtime, its CLI, or its gateway, none
> of which exist in 1.0.0-rc.0. It is kept as history, not as guidance; see
> `docs/pages/migration/1.0.md` for what replaced each surface it names.

Status: design spec, not yet implemented.

## Problem

Only `CodexAgent.js` emits structured file-change data (`item.changes: {path, kind}[]`,
no diff content). Every other adapter (`ClaudeCodeAgent.js`, `KimiAgent.js`, etc.)
classifies a tool call as `kind: "file_change"` purely via `toolKindFromName`
keyword matching and attaches the raw tool input unparsed. The chat UI
(`packages/gateway-ui/src/nodeChat.ts:76-88`) collapses all of this to a single
text note ("Edited a.ts, b.ts +2 more") via `describeFileChange` — no diff ever
reaches the UI, even though Claude Code's `Edit`/`Write` tool input
(`old_string`/`new_string`/`file_path`/`content`) is rich enough to reconstruct
a full unified diff.

## 1. Normalized type

New shared type, `packages/agents/src/agent-contract/AgentFileChange.ts`:

```ts
export type AgentFileChangeKind = "created" | "modified" | "deleted" | "renamed";

export type AgentFileChange = {
  path: string;
  kind: AgentFileChangeKind;
  oldPath?: string;                    // set when kind === "renamed"
  unifiedDiff?: string;                // full `git diff`-style patch, when available
  source: "reported" | "reconstructed"; // did the harness report the diff, or did we build it from tool input?
};
```

Lives in `agent-contract/` (not `capability-registry/`) because it's a payload
shape shared by adapters and consumers, not a capability declaration. Exported
from the package root alongside `SmithersAgentContract`.

`unifiedDiff` is optional by design — a `paths-only` harness contributes
`AgentFileChange` records with no diff, and the UI falls back to the snapshot
diff (existing worktree-snapshot diffing, out of scope here) to fill it in
later if needed.

## 2. Capability surface

Extend `AgentCapabilityRegistry` (`packages/agents/src/capability-registry/AgentCapabilityRegistry.ts`)
with a new field, following the existing `skills`/`humanInteraction` boolean-flag pattern:

```ts
fileChanges: {
  supportsFileChanges: boolean;     // can this engine identify file-mutating tool calls at all?
  supportsUnifiedDiff: boolean;     // can it produce (report or reconstruct) full diff content?
};
```

Each engine's registry sets these statically (see per-harness plan below).
`normalizeCapabilityRegistry.js` and `hashCapabilityRegistry.js` need the new
field added so registry hashing/normalization stays consistent — same
mechanical change as any new registry field (see the
`gotcha_new_workspace_package_checklist` pattern: this needs both lockfiles
untouched, but does need `docs/reference/package-configuration.mdx`-style
capability docs and `pnpm docs:llms` if capability docs are added).

The actual normalization logic is a per-adapter method, not part of the
registry (the registry only *declares* support):

```ts
// optional on BaseCliAgent subclasses
parseFileChanges?(rawEvent: unknown): AgentFileChange[] | undefined;
```

Adapters that can't normalize simply don't implement it; callers check
`typeof agent.parseFileChanges === "function"` before calling — graceful
absence, no throw, no stub returning `[]` (an empty array would wrongly imply
"no changes" rather than "unsupported").

## 3. Riding on the existing action event

No new event type. `AgentCliActionKind` already has `"file_change"`
(`packages/agents/src/BaseCliAgent/AgentCliActionKind.ts`). Adapters that can
normalize attach the array under a new, additive `detail` key:

```ts
action: {
  id, kind: "file_change", title,
  detail: {
    ...existing detail fields (e.g. Codex's `changes`, Claude's `input`),
    fileChanges: AgentFileChange[],   // NEW, optional
  },
}
```

Existing consumers that read `detail.changes` (Codex) or `detail.input`
(Claude) are untouched — `fileChanges` is additive. `describeFileChange` in
`nodeChat.ts` is updated to prefer `detail.fileChanges` when present (richer
`kind`/`oldPath` data) and fall back to the current `detail.changes`/`detail.file`
scan for adapters that haven't been migrated.

## 4. Per-harness plan

| Engine | Support | Approach |
|---|---|---|
| Claude Code | full-diff | `tool_use` blocks for `Edit`/`MultiEdit`/`Write`/`NotebookEdit` carry `old_string`/`new_string`/`file_path` (or `content`+`file_path` for Write) verbatim in `block.input`. Reconstruct a unified diff locally (no filesystem read needed — Edit already gives both old and new content). `source: "reconstructed"`. Multi-edit blocks become multiple `AgentFileChange` entries. |
| Codex | paths-only (upgradeable) | Native `item.changes: {path, kind}[]` gives path+kind only, no content. Emit `AgentFileChange` with `unifiedDiff: undefined`, `source: "reported"`. Full diff would require reading Codex's `apply_patch` payload if present in the raw event — worth a follow-up but not in scope for v1. |
| Kimi | full-diff | Uses the same Anthropic-style tool-call shape as Claude Code (`toolKindFromName` keyword match, same tool names) per KimiAgent.js:300 — same reconstruction path as Claude Code. |
| Cursor | paths-only | Has file/diff-related code paths per grep; needs a dedicated read of `CursorAgent.js` before committing to full-diff — treat as paths-only until verified, since its raw event shape is unconfirmed. |
| Gemini | none (v1) | Not present in `AgentCapabilityRegistry.engine` file/diff grep hits; no adapter code inspected. Ship with `supportsFileChanges: false` until an adapter pass confirms its raw event shape. |
| Amp | paths-only | `AmpAgent.js` matched file/diff grep; needs its own inspection pass, default to paths-only pending confirmation of whether raw tool input carries full before/after content. |
| OpenCode | paths-only | Matched grep; same caveat as Amp — verify raw event shape before promoting to full-diff. |

Anything not listed (Antigravity, Forge, Hermes, Omp, OpenAI, OpenClaw, Pi,
Pool, Vibe) ships `supportsFileChanges: false` in v1; each is a follow-up once
its raw tool-call/diff shape is confirmed against a real transcript.

## 5. e2e test strategy

Committed real transcript fixtures, one per adapter that declares
`supportsFileChanges: true`, under
`packages/agents/src/__fixtures__/file-changes/<engine>.json` (or `.jsonl` if
the raw protocol is streaming). Each fixture is a captured raw event stream
from a real single-file-edit run of that engine, with secrets/paths scrubbed:

- API keys, tokens, session ids → replaced with placeholder strings before commit.
- File paths inside the repo checkout at capture time → rewritten to a fixed
  fake project root (e.g. `/repo/src/example.ts`) so fixtures don't leak the
  capturing machine's directory layout.
- Scrub pass is a script (`scripts/scrub-transcript-fixture.mjs`), not manual
  editing, so re-capturing a fixture after an engine protocol change stays
  reproducible.

Test: `packages/agents/src/*Agent.test.ts` adds a case per fixture that feeds
the raw transcript through the adapter's stream handling and asserts the
resulting `action.detail.fileChanges` matches an expected `AgentFileChange[]`
snapshot (committed alongside the fixture as `<engine>.expected.json`).
Reconstructed diffs (Claude, Kimi) get their `unifiedDiff` string asserted
literally; reported-only adapters (Codex) assert `unifiedDiff` is `undefined`
and `path`/`kind` match.

## 6. UI

`nodeChat.ts`: when `detail.fileChanges` is present, push a new
`NodeChatItem` kind instead of a `"note"`:

```ts
{ kind: "file_change", key: `filechange:${frame.seq}`, files: AgentFileChange[], label: string }
```

(`label` keeps the existing "Edited a.ts, b.ts +2 more" summary as the collapsed
chip text; `files` carries the full data for expansion.)

`NodeChatStream.tsx`: add a case in the render switch — a clickable chip
(reuse existing `Marker`/chip styling) that expands, on click, into one
`packages/ui/src/diff-hunks.tsx` `<DiffHunks file={...} />` per changed file
with a non-empty `unifiedDiff`. Files with no diff (paths-only harnesses)
render as a plain path row with a "diff unavailable" affordance instead of a
`DiffHunks` block — no fabricated content.

Feeding `DiffHunks` requires converting `AgentFileChange.unifiedDiff` (a raw
patch string) into the `DiffFile` shape (`packages/ui/src/diff.ts:29-46`) via
the existing unified-diff parser (wherever `Diff`/`DiffFile` values are
currently produced elsewhere in the UI — reuse it, don't write a second
parser).

**Known pre-existing defect, flagged not fixed here**: `packages/ui/src/diff.ts`'s
`DiffLine` type names the old-file line number `lnOld` but the new-file line
number just `ln` (not `lnNew`), and `diff-hunks.tsx:52-53` mirrors this into
CSS class names (`sui-diff-ln-old` / `sui-diff-ln-new` mapped to fields
`lnOld` / `ln`). This is confusing but functional; do not block this contract
on renaming it — track as a separate cleanup issue.
