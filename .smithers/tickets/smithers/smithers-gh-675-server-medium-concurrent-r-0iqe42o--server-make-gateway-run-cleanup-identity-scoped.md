# server: make gateway run cleanup identity-scoped

GitHub: https://github.com/smithersai/smithers/issues/997

Parent: smithers/gh-675-server-medium-concurrent-resume-orphans-a--0kt69qx.md

Context: startRun currently deletes runRegistry, activeRuns, and inflightRuns by runId when its engine promise settles. If a newer record has replaced an older record for the same runId, the older promise can delete the newer run's tracking state.

Acceptance criteria:
1. The finally cleanup removes an entry only when the map still contains the record or in-flight promise owned by the settling invocation, across runRegistry, activeRuns, and inflightRuns.
2. A settling older invocation cannot remove a newer same-runId record, preserving tracking and cancellation for the live run.
3. A regression test verifies replacement preservation and confirms ordinary completion still cleans up all owned entries.
