# 🐛 engine: [medium] diff-bundle git-apply fallback silently drops renames (empty new file, orphaned old file)

GitHub: https://github.com/smithersai/smithers/issues/672

_via ultracode (Opus multi-agent) review_

## Summary
When `applyDiffBundle`'s batched `git apply` throws and the code falls back to per-patch `applyPatchFallback`, a git rename is mishandled: the new path gets an empty file and the old path is left on disk, and the apply reports success.

## Location
- `packages/engine/src/effect/diff-bundle.js:382` (`applyPatchFallback` — `current` selection / write)
- Fallback trigger: `packages/engine/src/effect/diff-bundle.js:421-424`
- Misclassification: `extractOperation` `:121-129` returns `"modify"` for a rename; `extractPatchPath` `:98-116` returns only the rename-TO path.

## Failure scenario
Bundles are computed with `git diff --find-renames=100%`, so a pure rename `a/foo.ts`→`a/bar.ts` is emitted as one chunk:
```
diff --git a/foo.ts b/bar.ts
similarity index 100%
rename from foo.ts
rename to bar.ts
```
This chunk has no `@@` hunks and neither a `new file mode` nor `deleted file mode` line.
- `extractOperation` → `"modify"`, `extractPatchPath` → `bar.ts` (the from-path is never surfaced as a separate patch).
- In `applyPatchFallback`, `bar.ts` does not exist, so `current = ""` (line 382). `applyUnifiedPatch("", chunk)` returns `""` (verified: empty string, not `false`), so no error is thrown.
- `writeFile(bar.ts, "")` creates an **empty** `bar.ts`; `foo.ts` is **never removed** (no delete patch exists for it).

Because the batched `git apply` failing on ANY single patch routes the WHOLE bundle through the fallback, an otherwise-clean rename is corrupted even when the rename alone would have applied fine.

## Why it matters
`applyDiffBundle` merges sandbox/child-workflow filesystem changes back into the parent worktree (`attachSandboxComputeFns` → `applyDiffBundle`). A dropped rename (old file kept, new file empty) is durable, silent workspace data corruption reported as a successful apply — the exact failure the durability layer exists to prevent.

## Fix direction
In the fallback, treat rename chunks as a delete-of-from + add-of-to: parse `rename from` to `rm` the old path, and reconstruct the new file's content (for a 100% rename, copy the old file's bytes before deleting) instead of writing the result of applying an empty-hunk patch to an empty string.
