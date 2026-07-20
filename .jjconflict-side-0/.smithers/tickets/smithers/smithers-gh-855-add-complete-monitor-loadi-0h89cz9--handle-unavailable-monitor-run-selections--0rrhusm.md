# Handle unavailable Monitor run selections and deep links

GitHub: https://github.com/smithersai/smithers/issues/959

Parent: smithers/gh-855-add-complete-monitor-loading-empty-and-error-state.md

Context: A selected or URL-deep-linked run that cannot be loaded currently renders only “Run not found,” without recovery controls or distinction from a failed query. Acceptance criteria: 1. A genuinely missing or deleted run has an explicit unavailable state showing the requested run ID. 2. A failed run query is distinguished from a confirmed missing run. 3. The state offers retry/refresh and a return-to-runs action. 4. Deep links remain safe when the run is absent or disappears after selection. 5. Add tests for missing, loading, failed, and recovered selections.
