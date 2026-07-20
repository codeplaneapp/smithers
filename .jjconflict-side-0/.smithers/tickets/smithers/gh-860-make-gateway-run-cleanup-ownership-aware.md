# Make gateway run cleanup ownership-aware

GitHub: https://github.com/smithersai/smithers/issues/860

Change startRun cleanup so a settling run promise removes runRegistry, activeRuns, and inflightRuns entries only when each map still contains the record or promise owned by that start. Add coverage proving a stale resume cannot delete a replacement live record.
