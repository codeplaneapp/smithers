# Cap streamRunEvents registrations per connection, user, run, and gateway

GitHub: https://github.com/smithersai/smithers/issues/894

Add configurable limits for run-event stream registrations, reject registrations beyond connection/user/run/global caps, maintain accurate counters, and verify cleanup after unsubscribe and WebSocket close.
