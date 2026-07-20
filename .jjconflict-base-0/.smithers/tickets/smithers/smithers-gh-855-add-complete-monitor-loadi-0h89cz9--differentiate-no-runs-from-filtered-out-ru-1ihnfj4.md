# Differentiate no runs from filtered-out runs in the Smithers Monitor

GitHub: https://github.com/smithersai/smithers/issues/957

Parent: smithers/gh-855-add-complete-monitor-loading-empty-and-error-state.md

Context: The Monitor currently renders “No runs match” for both an initially empty workspace and a successful filter that excludes every run. Acceptance criteria: 1. A successful unfiltered empty result shows a clear no-runs state with launch guidance. 2. A non-empty workspace whose active filters match zero rows shows a distinct filtered-out state. 3. The filtered-out state provides a clear way to reset filters. 4. Loading and query-error states are not misclassified as empty. 5. Add focused component or state-derivation tests.
