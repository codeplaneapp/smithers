# Workflow modules are cached indefinitely

Severity: Medium

Location: `src/bun/smithers/SmithersService.ts:510`

Description:
`loadWorkflow` caches modules by path and never invalidates the cache unless the workspace root changes. Edits to workflows during a session will not be picked up.

Impact:
Users can run stale workflow code without realizing changes are ignored.

Suggested Fix:
Add cache invalidation (e.g., stat mtime checks, explicit refresh on file change, or disable caching for local workflows).
