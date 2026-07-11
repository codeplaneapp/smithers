# http/

`createHttpTool.js` creates a generic AI SDK REST tool (method, URL, headers,
query, body, auth, and timeout), with type sidecars in this directory. It is
exported from both `@smithers-orchestrator/agents` and the
`smithers-orchestrator` facade.

```ts
import { createHttpTool } from "@smithers-orchestrator/agents";

const http = createHttpTool({
  baseUrl: "https://api.example.com",
  defaultHeaders: {
    authorization: `Bearer ${process.env.EXAMPLE_API_TOKEN!}`,
  },
  // This upload service is the only cross-origin redirect allowed to retain
  // credentials. Origins include scheme, hostname, and port.
  allowedOrigins: ["https://uploads.example.com"],
  maxResponseBytes: 1024 * 1024,
  maxRedirects: 3,
});
```

## Outbound request policy

- Request URLs and every redirect target must use `http:` or `https:` and must
  not embed URL userinfo. Other schemes and embedded credentials are rejected
  before a fetch.
- Localhost-style names and IP literals outside ordinary public-unicast space
  are blocked by default. Untrusted hostnames are resolved before each request
  and denied when resolution fails, no addresses are returned, or any A/AAAA
  answer is non-global. Prefer an exact `baseUrl` or `allowedHosts` entry for
  an intentional initial endpoint, and `allowedOrigins` for an intentional
  redirect destination. `allowPrivateNetwork: true` opens the broader
  exception. Fetch resolves the
  hostname again after this check, so enforce private-range and metadata egress
  at the network boundary to close DNS-rebinding races. `resolveHostname` is an
  injectable resolver for controlled runtimes and deterministic tests.
- `baseUrl` and `allowedHosts` decide which model-selected destinations may
  receive `defaultHeaders`. `baseUrl` is exact-origin trust (scheme, host, and
  port), so an HTTPS base never authorizes cleartext HTTP. An `allowedHosts`
  entry written as an HTTP(S) URL is normalized to and authorizes only that
  exact origin. A bare hostname or `hostname:port` authorizes only its HTTPS
  origin; it never silently authorizes cleartext HTTP. Configuring
  non-empty `defaultHeaders` without either `baseUrl` or `allowedHosts` fails at
  construction, before a model can select an attacker-controlled URL.
- Redirects are followed manually. Configured default, per-call, and custom
  auth headers, plus common credential headers, stay on same-origin hops and
  are stripped before an untrusted cross-origin hop. They are retained across
  a cross-origin redirect only when the exact destination origin appears in
  `allowedOrigins`. A redirect that would preserve a request body to an
  untrusted origin is rejected, as are HTTPS-to-HTTP downgrades.
- Redirects default to at most 5 hops (`maxRedirects`). Response bodies default
  to 1 MiB (`maxResponseBytes`); an oversized `Content-Length` fails before the
  body is read, and a streamed body is cancelled as soon as it crosses the cap.
- The AI SDK's tool-call `abortSignal` is composed with the input's optional
  `timeoutMs`, so cancellation stops the fetch and response read. When calling
  `tool.execute` directly, pass the signal in the execution-options argument.

Body objects are JSON-serialized (and `content-type` is set) unless the body is
already a string, `Blob`, `FormData`, or `URLSearchParams`; `GET` and `HEAD`
never send a body. JSON responses are parsed and other responses are returned
as text.
