# Classify canonical run states in shared UI helpers

GitHub: https://github.com/smithersai/smithers/issues/847

Update packages/ui/src/status.ts so statusClass and formatStatus explicitly cover every canonical RunStatus and RunState value, including recovering, stale, orphaned, cancelled, succeeded, and continued, with the intended success, warning, and failure tones. Add focused regression tests.
