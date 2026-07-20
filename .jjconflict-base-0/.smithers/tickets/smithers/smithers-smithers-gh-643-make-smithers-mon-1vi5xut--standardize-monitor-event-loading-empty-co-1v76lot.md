# Standardize Monitor event loading, empty, connection, and stream-error states

GitHub: https://github.com/smithersai/smithers/issues/1133

Parent: smithers/smithers-gh-643-make-smithers-monitor-trul-0iz5n9a--polish-the-events-stream-and-event-filtering.md

Context: Event history and live subscriptions can be loading, empty, disconnected, unauthorized, or failed independently. Acceptance criteria: distinguish initial loading from a run with no events; provide accurate empty copy for each filter; clearly identify connection loss and whether displayed data is last known; surface stream/query errors with actionable recovery guidance; add rendering coverage for every state.
