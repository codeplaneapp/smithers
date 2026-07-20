# Complete execution-tree and frame-scrubber unavailable states

GitHub: https://github.com/smithersai/smithers/issues/962

Parent: smithers/gh-855-add-complete-monitor-loading-empty-and-error-state.md

Context: ExecutionTree handles loading, query failure, no nodes, empty frames, and frame-unavailable text, but these paths are not component-tested and frame errors are only a small inline label. Acceptance criteria: 1. Live tree loading, successful empty tree, and failed tree query are distinct. 2. Empty historical frames are distinct from frames that failed to load. 3. Scrubbing keeps the previous valid tree while loading and clearly reports unavailable frames. 4. Retry or return-to-live actions are available where appropriate. 5. Add rendering tests for live and historical tree states.
