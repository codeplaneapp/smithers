# Add representative monitor component and browser coverage

GitHub: https://github.com/smithersai/smithers/issues/1130

Parent: smithers/smithers-gh-643-make-smithers-monitor-trul-0iz5n9a--polish-execution-tree-retries-nesting-time-0quyuma.md

Context: Existing tests cover model helpers, shell controls, and bundle mounting but do not verify the complete execution-tree interaction surface. Acceptance criteria: test a real seeded monitor against nested containers, multiple iterations, retries, failures, collapsed descendant failures, empty and loading trees, output/transcript/inspector selection, XML mode, timeline mode, and historical frame scrubbing; verify keyboard navigation and accessibility attributes without fabricating gateway data.
