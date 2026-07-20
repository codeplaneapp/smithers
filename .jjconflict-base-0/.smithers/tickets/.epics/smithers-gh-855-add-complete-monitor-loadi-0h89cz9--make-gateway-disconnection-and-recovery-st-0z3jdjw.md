# Make gateway disconnection and recovery states explicit in the Monitor

GitHub: https://github.com/smithersai/smithers/issues/960

Parent: smithers/gh-855-add-complete-monitor-loading-empty-and-error-state.md

Context: ConnectionBadge shows Live, Connecting, Offline, and Unauthorized, but the broader UI does not consistently explain query impact or recovery. Acceptance criteria: 1. Connecting, offline, and unauthorized states are visually consistent and actionable. 2. Offline mode clearly identifies last-known data and does not present it as current. 3. Initial connection failure is not rendered as a misleading empty workspace. 4. Recovery transitions back to live data without losing selection or filters. 5. Add tests for each connection state and reconnection behavior.
