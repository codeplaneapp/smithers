# Browser reads on the Worker

The native app provides guarded HTTPS reads using its own pinned connection.
The Worker advertises `browser.read` only when its `BROWSER_EGRESS` service
binding is configured. Without that binding, the endpoint returns 501 and
the flow is absent from the host's inventory. No service is deployed or
selected automatically.

Workers' `node:https` wraps `fetch` and does not support the custom `lookup`
and `servername` options needed to pin an arbitrary public address while
verifying the original host. Do not replace this binding with an ordinary
hostname-based fetch after a separate DNS check: DNS rebinding would bypass
the private-address guard.

The trusted service must accept `POST https://browser-egress.internal/fetch`
with JSON containing `{ version: 1, url, address, method: "GET", headers }`.
It must connect to exactly `address`, preserve the URL host for HTTP Host,
TLS SNI and certificate verification, and reject unsupported input. It must
never disable certificate verification or resolve the URL host again. Only
the supplied public-page request headers are sent; no caller cookies,
authorization or other credentials are forwarded.

Return the origin's HTTP status, headers and streaming body without following
redirects. The Worker resolves and checks every redirect destination itself,
then submits a separate pinned request. Cancellation must stop the underlying
connection. The shared handler caps the body and applies one deadline across
DNS, redirects, headers and body reads. Request `Accept-Encoding: identity`
or return a correctly decompressed body; do not return compressed bytes as text.

Before configuring a binding, verify public-page reads, hostname/certificate
mismatches, redirects to private IPs, DNS changes, cancellation and body caps
against the service's real transport.

Runtime references: [Workers HTTPS limitations](https://developers.cloudflare.com/workers/runtime-apis/nodejs/https/),
[Workers HTTP lookup limitations](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/).
