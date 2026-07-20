# Show actionable approval context and live wait times

GitHub: https://github.com/smithersai/smithers/issues/952

Parent: smithers/gh-854-make-approvals-clear-and-actionable.md

Context: Operators need to understand what a pending gate will do before deciding. Acceptance criteria: Each pending approval displays its title, summary or payload context, workflow, run ID, node ID, iteration, request timestamp, and a live elapsed wait time; wait age has clear fresh/warning/stale states; loading, empty, and unavailable-data states are understandable; component and browser tests cover the rendered context and time states.
