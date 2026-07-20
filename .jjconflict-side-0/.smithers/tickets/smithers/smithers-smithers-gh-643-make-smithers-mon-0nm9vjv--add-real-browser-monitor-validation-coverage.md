# Add real-browser monitor validation coverage

GitHub: https://github.com/smithersai/smithers/issues/1120

Parent: smithers/smithers-gh-643-make-smithers-monitor-trul-0iz5n9a--add-responsive-accessible-and-resilient-mo-0vi5vil.md

Context: Unit and happy-dom tests do not establish that the bundled monitor behaves correctly against a real gateway in a browser. Acceptance criteria: add no-mock Playwright coverage against a real gateway for light and dark themes and mobile through wide-desktop viewports; cover loading, empty, error, offline/reconnect, approvals, run-tree expansion and selection, events/timeline, focus and keyboard behavior, and custom-UI/PTY modal open-close behavior; assert accessible dialog semantics, Escape handling, focus restoration, and absence of unwanted page-level horizontal overflow.
