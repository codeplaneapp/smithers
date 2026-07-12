# Expose retry and attempt history clearly in the monitor inspector

GitHub: https://github.com/smithersai/smithers/issues/1127

Parent: smithers/smithers-gh-643-make-smithers-monitor-trul-0iz5n9a--polish-execution-tree-retries-nesting-time-0quyuma.md

Context: Operators need to understand whether a failed node is retrying, exhausted, or safe to retry. Acceptance criteria: show the current attempt, retry budget, iteration, failure details, acting agent, and retry state for the first and later attempts; make retry availability and busy/error/confirmation states explicit; keep output and transcript tied to the selected node and iteration; test failed, retried, exhausted, and successful retry cases.
