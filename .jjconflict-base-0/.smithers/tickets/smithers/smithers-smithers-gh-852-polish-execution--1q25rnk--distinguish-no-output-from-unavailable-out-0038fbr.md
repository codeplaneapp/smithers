# Distinguish no output from unavailable output and handle transient fetch errors

GitHub: https://github.com/smithersai/smithers/issues/1152

Parent: smithers/smithers-gh-852-polish-execution-tree-retr-051acv6--complete-structured-node-output-and-error--0jj8193.md

Context: A successful response with no row is different from an output request that failed or is temporarily unavailable, but the inspector currently falls through to the same empty-state copy. Acceptance criteria: Show no output only after a successful no-row response; show unavailable/error state for fetch failures; provide a recovery/refetch path where appropriate; add a fail-then-success transient fetch test.
