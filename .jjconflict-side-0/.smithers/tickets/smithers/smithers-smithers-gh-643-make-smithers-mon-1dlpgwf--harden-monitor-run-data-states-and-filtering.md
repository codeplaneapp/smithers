# Harden monitor run data states and filtering

GitHub: https://github.com/smithersai/smithers/issues/1138

Parent: smithers/smithers-gh-643-make-smithers-monitor-trul-0iz5n9a--polish-the-monitor-runs-overview-and-runs-rail.md

Context: The monitor is a live operational surface that must remain understandable during connectivity and data problems. Acceptance criteria: preserve search, status filtering, workflow filtering, pagination, loading, empty, offline, and run-list error states; preserve last-known rows during transient outages; provide retry or reconnect guidance; add tests for each state.
