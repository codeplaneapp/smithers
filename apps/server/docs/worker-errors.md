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
