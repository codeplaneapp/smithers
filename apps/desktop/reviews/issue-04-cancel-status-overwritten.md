# Cancelled runs can be marked failed

Severity: Medium

Location: `src/bun/smithers/SmithersService.ts:184`, `src/bun/smithers/SmithersService.ts:292`

Description:
`cancelRun` sets status to `cancelled`, but `executeRun` catches all errors and unconditionally sets status to `failed`. If the workflow engine throws on abort, the cancelled run will be marked failed.

Impact:
Run status and UI state become inconsistent and misleading, especially for user-initiated cancellations.

Suggested Fix:
Detect abort-related errors (e.g., `AbortError`) and keep status `cancelled`, or guard `executeRun` from overwriting a cancelled status.
