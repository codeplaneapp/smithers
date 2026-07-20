# Add real-browser coverage for Monitor event filtering and live updates

GitHub: https://github.com/smithersai/smithers/issues/1135

Parent: smithers/smithers-gh-643-make-smithers-monitor-trul-0iz5n9a--polish-the-events-stream-and-event-filtering.md

Context: Existing unit tests cover event formatting and classification but do not prove the served Monitor works with a live gateway stream. Acceptance criteria: launch the real Monitor against a real gateway and deterministic event data in a browser; verify Notable, Activity, and All filtering; verify new events appear live and follow/paused scrolling behaves correctly; verify loading, empty, connection, and stream-error presentation where practical; do not fabricate event data with browser route interception.
