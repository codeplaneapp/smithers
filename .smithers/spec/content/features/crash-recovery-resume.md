# Crash recovery and resume

> **Status:** Partial · **Priority:** P0 · **Owner:** smithers-maintainers · **Group:** Recover & replay

**What you can do:** Kill the process mid-run and pick up exactly where it stopped.

Runs resume after process death, quota exhaustion, or machine restart; retry-task recovers hard-failed nodes without honoring spent attempts. Editing a running workflow file still hard-fails resume with RESUME_METADATA_MISMATCH by design.

## Capabilities

### Resume

smithers up/resume restores in-flight runs from the store.

### Quota recovery

retry-task recovers runs that exhausted retries on provider rate limits.




## Test cases

- pnpm -C e2e test
- pnpm -C e2e test:faults

## Observability

_None recorded yet._

## Debugging

_None recorded yet._

## Architecture

_None recorded yet._

## Fixes & diffs

_None recorded yet._

## Open gaps

- Crash-recovery workflow (.smithers/workflows/crash-recovery.tsx) is new and unverified end to end

