# Add state-aware monitor run lifecycle, retry, and health controls

GitHub: https://github.com/smithersai/smithers/issues/1125

Parent: smithers/smithers-gh-643-make-smithers-monitor-trul-0iz5n9a--polish-approvals-and-run-actions.md

Context: Operators need safe lifecycle controls for runs from the monitor. Acceptance criteria: expose pause, resume, cancel, and retry only when valid for the current run or node state; confirm destructive actions; disable conflicting controls while requests are pending; show success and recoverable error feedback; surface healthy, waiting, stale, orphaned, quota, failed, and offline health states with appropriate actions; provide accessible names, focus behavior, and browser tests for each state and action.
