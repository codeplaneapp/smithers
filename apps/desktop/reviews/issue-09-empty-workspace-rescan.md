# getState rescans workflows on every call when empty

Severity: Low

Location: `src/bun/workspace/WorkspaceService.ts:52`

Description:
`getState` triggers a workflow scan whenever `root` is set and the cached workflow list is empty. In an empty workspace this means repeated IO on every call.

Impact:
Unnecessary filesystem work and latency in empty or new workspaces.

Suggested Fix:
Track whether a scan has been performed or cache a "no workflows" result with a timestamp to avoid repeated scans.
