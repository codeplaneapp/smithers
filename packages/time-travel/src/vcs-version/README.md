# vcs-version/

Ties run frames to jj (Jujutsu) working-copy state via `_smithers_vcs_tags`
rows keyed `(run_id, frame_no)`.

- `tagSnapshotVcsEffect.js` records the current jj pointer + operation id for a
  frame; `loadVcsTagEffect.js` reads a tag back.
- `rerunAtRevisionEffect.js` reverts the working copy to the tagged pointer —
  it returns `restored: false` rather than failing when no tag exists.
- `resolveWorkflowAtRevisionEffect.js` instead materializes a fresh jj
  workspace at the tagged revision, for replaying without touching the live
  working copy.
- `index.js` provides Promise facades that supply `BunContext.layer`; the
  Effect variants require a `CommandExecutor` from the caller. Its
  `@smithers-type-exports` block is tool-managed.
