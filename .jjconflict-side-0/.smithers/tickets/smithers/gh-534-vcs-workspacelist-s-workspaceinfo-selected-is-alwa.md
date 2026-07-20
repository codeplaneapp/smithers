# 🧹 vcs: workspaceList's WorkspaceInfo.selected is always false on modern jj — populate it or drop it

GitHub: https://github.com/smithersai/smithers/issues/534

**What happens**
`packages/vcs/src/jj.js:270-300`: when `jj workspace list -T 'name ++ "\n"'` succeeds (every modern jj), each row is returned as `{ name, path: null, selected: false }` — including the currently selected workspace. Only the legacy human-output fallback (lines 282-298) parses the `*` marker and fills `selected` correctly. `tests/jj-workspace.test.js` asserts the always-false behavior, so it's baked in.

**Why it's worth discussing**
`WorkspaceInfo.selected` is exported public API (re-exported from `packages/smithers/src/index.js:191` and documented in the llms bundles). A field that is structurally present but only meaningful on ancient jj versions is a trap for consumers: code that branches on `selected` works in legacy-fallback tests and silently never fires in production.

**Options**
1. Extend the template to capture selection state (e.g. jj's `current_working_copy` template keyword) and populate `selected` in the primary path.
2. Drop `selected` (and `path`, which is also always null in the primary path) from `WorkspaceInfo`, or document them as legacy-only.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
