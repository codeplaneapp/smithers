# Cap WebSocket run-event subscriptions

GitHub: https://github.com/smithersai/smithers/issues/1010

Parent: smithers/gh-787-fix-gateway-high-unbounded-stream-subscrip-15mgjqq.md

Context: streamRunEvents currently allocates a stream state and heartbeat for every registration without connection, user, run, or gateway-wide limits. Acceptance criteria: define enforced caps for each scope; reject registrations before allocating state when a cap is exceeded with a stable documented error; maintain accurate counters across normal unsubscribe, connection close, backpressure disconnect, and gateway shutdown; add tests covering every cap and cleanup.
