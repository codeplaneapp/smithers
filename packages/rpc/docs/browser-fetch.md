# Browser fetch deadline

`browserFetch` uses one `timeoutMs` deadline for DNS resolution, response headers,
redirect hops and body reads. The default is 10,000 ms. A deadline returns
`{ ok: false }` with a message that reading the current host took too long.

The deadline bounds caller settlement. Transport cleanup is best-effort and
fire-and-forget: redirect bodies, capped readers and interrupted readers are
cancelled without waiting for cancellation to settle. Cancellation rejections are
ignored. A stalled cancellation cannot delay a redirect, a capped result or a
deadline failure. An errored redirect body does not prevent processing its status
and location.
