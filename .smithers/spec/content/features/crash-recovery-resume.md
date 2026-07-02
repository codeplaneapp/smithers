# Crash recovery and resume

> **Status:** Partial | **Priority:** P0 | **Owner:** smithers-maintainers | **Group:** Recover & replay

Runs resume after process death, quota exhaustion, or machine restart; retry-task recovers hard-failed nodes without honoring spent attempts. Editing a running workflow file still hard-fails resume with RESUME\_METADATA\_MISMATCH by design.

## What you can do

Kill the process mid-run and pick up exactly where it stopped.

## Capabilities

### Resume

`smithers up`/resume restores in-flight runs from the store.

### Quota recovery

retry-task recovers runs that exhausted retries on provider rate limits.

## Test cases

- `pnpm -C e2e test`
- `pnpm -C e2e test:faults`

## Open gaps

- Crash-recovery workflow (`.smithers/workflows/crash-recovery.tsx`) is new and unverified end to end
