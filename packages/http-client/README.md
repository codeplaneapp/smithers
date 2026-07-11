# `@smithers-orchestrator/http-client`

Small, dependency-free outbound HTTP safety primitives shared by Smithers'
agent tools, provider integrations, and server runtimes. The package uses only
Web Platform APIs, so it runs under Bun, Node 22+, and Workers-style runtimes.
The opt-in `@smithers-orchestrator/http-client/node` subpath adds Node/Bun DNS
resolution without loading Node built-ins into Workers-style consumers.

It deliberately does not choose product policy. Callers decide which extra
origins may receive credentials, which custom headers/query parameters are
sensitive, and whether a destination passes their DNS/private-network rules.
The primitives make those decisions consistent and enforce them on every hop.

```js
import {
  fetchWithPolicy,
  readResponseJson,
} from "@smithers-orchestrator/http-client";

const response = await fetchWithPolicy(
  "https://api.example.com/v1/items",
  {
    headers: { authorization: `Bearer ${token}` },
    signal,
  },
  {
    allowedOrigins: ["https://uploads.example.com"],
    sensitiveHeaders: ["x-company-token"],
    maxRedirects: 5,
    validateUrl: (url, { initial, from }) =>
      destinationPolicy.assertAllowed(url, { initial, from }),
  },
);

const payload = await readResponseJson(response, {
  maxBytes: 1024 * 1024,
  signal,
});
```

## Contract

- `assertHttpUrl` accepts only `http:` and `https:` URLs and rejects embedded
  URL userinfo. Error messages never repeat credentials or query strings.
- `isNonGlobalIpLiteral` recognizes WHATWG IP spellings outside ordinary public
  unicast, including private, loopback, link-local, shared, benchmarking,
  documentation, translation, mapped, multicast, and other IANA non-global
  special-purpose ranges. It does not resolve hostnames or claim DNS-rebinding
  protection.
- The Node/Bun-only `assertPublicHostname` helper fails closed when a hostname
  cannot be resolved or any A/AAAA answer is non-global. It blocks static DNS
  aliases to private networks. Its `resolveHostname` option injects a resolver
  for controlled runtimes and deterministic tests. Fetch resolves again, so a
  network-layer deny is still required to eliminate DNS-rebinding races.
- `createPublicRedirectValidator` trusts a configured initial origin and exact
  `allowedOrigins`, then applies `assertPublicHostname` to every other redirect
  destination. This lets an operator target an intentional private provider
  without allowing a provider response to pivot into the rest of the network.
- `fetchWithPolicy` handles 301, 302, 303, 307, and 308 itself. It follows at
  most five hops by default, applies Fetch-compatible method/body rewriting,
  and calls `validateUrl` before the first request and every redirect request.
- HTTPS-to-HTTP redirects always fail. There is intentionally no core opt-out.
- The initial origin is trusted to receive the request's sensitive material.
  `allowedOrigins` adds redirect origins with that same trust. On any other
  cross-origin redirect, sensitive headers and named query parameters are
  stripped, ambient credentials/referrers are disabled, and a body-preserving
  redirect is rejected. Once stripped, credentials are never reintroduced by a
  later hop.
- Default sensitive headers are `authorization`, `proxy-authorization`,
  `cookie`, `cookie2`, `x-api-key`, `api-key`, `xi-api-key`, and
  `x-subscription-token`. Matching is case-insensitive; `sensitiveHeaders`
  extends the set.
- A redirect that needs to replay a one-shot body fails before the destination
  is contacted. Strings, blobs, URL-encoded bodies, ArrayBuffers, and typed
  arrays are replayable; streams, FormData, and bodies inherited from a
  `Request` are treated as one-shot.
- `readResponseBytes`, `readResponseText`, and `readResponseJson` require a
  byte cap. They reject oversized `Content-Length` before buffering, enforce
  the cap again while streaming, accept exact-at-cap responses, and cancel the
  body on overflow.
- `composeAbortSignals` and `abortableDelay` preserve the winning signal's
  exact abort reason rather than wrapping it as a generic network error.

All policy failures use `HttpClientPolicyError` and a stable `code`; details do
not contain response bodies, request headers, URL userinfo, or query strings.
