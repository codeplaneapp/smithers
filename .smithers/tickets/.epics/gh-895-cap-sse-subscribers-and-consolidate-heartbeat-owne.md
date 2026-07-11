# Cap SSE subscribers and consolidate heartbeat ownership

GitHub: https://github.com/smithersai/smithers/issues/895

Add global and per-user limits for /v1/api/stream subscribers, reject excess subscribers, clean counters on disconnect, and replace per-subscriber heartbeat intervals with bounded connection-level heartbeat ownership.
