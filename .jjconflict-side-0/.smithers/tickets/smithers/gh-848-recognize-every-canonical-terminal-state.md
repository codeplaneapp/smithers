# Recognize every canonical terminal state

GitHub: https://github.com/smithersai/smithers/issues/848

Update isTerminalRunStatus and TERMINAL_STATUSES in packages/ui/src/status.ts to recognize all terminal raw and derived states, including continued and succeeded, while keeping running, waiting, paused, recovering, stale, orphaned, and unknown non-terminal. Add exhaustive terminality tests.
