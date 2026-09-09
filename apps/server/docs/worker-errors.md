# Worker errors

Durable Object transport failures use the route's JSON contract:

- Turn-budget checks admit the call with the configured ceiling as remaining
  budget and log the cause. Unreadable responses use the same fallback.
- Turn registration and cancellation return HTTP 502 with `status: "error"`
  and a `message`. A failed registration never starts a model request. A
  failed cancellation does not establish whether the turn is still running.
- Admin client-error reads return HTTP 200 with `status: "ok"`, an empty log,
  and a `note` stating that the log is unavailable. The cause is logged.

The exported Worker fetch handler catches unexpected route failures, logs
the cause, and returns HTTP 500 with `status: "error"` and a generic `message`.
This boundary covers response creation; errors after a streaming response
has been returned remain the stream handler's responsibility.

`UPSTREAM_TIMEOUT_MS` bounds upstream response headers, defaulting to 20,000
milliseconds when unset or invalid. The model turn and stream routes, admin
forwards and health reads, identity and billing proxies, and gateway calls
share `src/upstreamDeadline.ts`. The timer clears when headers arrive;
streaming bodies can continue and caller cancellation remains effective.

Model and admin forward deadlines return HTTP 504 with `status: "error"`
and a `message` naming the effective duration in milliseconds. Turn deadlines
also settle the cancellation registry. Client disconnects on model routes
remain HTTP 499. Gateway deadlines retain the states and retry policy in
[gateway-retries.md](gateway-retries.md).

Admin health retains its HTTP 200 partial report: timed-out health checks
have `status: "failed"` and a detail naming the effective deadline. An
unavailable balance or request queue remains `null`.
