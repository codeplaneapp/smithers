# Complete event-panel loading, empty, filtered-empty, and error states

GitHub: https://github.com/smithersai/smithers/issues/961

Parent: smithers/gh-855-add-complete-monitor-loading-empty-and-error-state.md

Context: EventLog has loading, empty, filtered-empty, and error branches, but these states lack dedicated component coverage and should be standardized with the rest of the Monitor. Acceptance criteria: 1. Initial event loading is distinct from a run with no events. 2. Empty all-events and empty Notable/Activity filters have accurate copy. 3. Stream/query failures show a consistent error state and recovery action. 4. Disconnection explains whether displayed events are last-known data. 5. Add rendering tests for all event-panel states.
