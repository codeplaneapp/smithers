# Add a runnable multi-output childRun reference

GitHub: https://github.com/smithersai/smithers/issues/1006

Parent: smithers/gh-768-subflow-mode-childrun-output-is-the-child--0eqwmrr.md

Context: the current Subflow examples use a child with one output table, so they do not answer which value a parent receives when the child writes multiple tables. Acceptance criteria: add a runnable example or typed helper showing a child with at least two output tables and a distinct final task, a parent childRun Subflow whose schema matches that final task, and parent consumption of the result; add an executable test proving the parent receives the final task row rather than a table-keyed snapshot and verify the example through the relevant test/build gate.
