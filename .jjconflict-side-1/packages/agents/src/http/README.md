# http/

`createHttpTool.js` — a generic call-any-REST-API tool (method/url/headers/
query/body/auth/timeout), plus its type sidecars (`CreateHttpToolOptions.ts`,
`HttpToolAuth.ts`, `HttpToolInput.ts`, `HttpToolOutput.ts`).

Security model: `defaultHeaders` can carry secrets while the model picks the
URL, so `baseUrl`/`allowedHosts` pin an allowlist of hosts allowed to receive
them (matched as WHATWG `url.host`, fail-closed on port mismatch). With no
allowlist configured, headers go to every host.

Behavior notes:

- Bodies are JSON-serialized (and `content-type` set) unless already a
  string/Blob/FormData/URLSearchParams; GET/HEAD never send a body.
- JSON responses are parsed; everything else is returned as text.
- Redirects are resolved manually (up to 20 hops, standard 301/302/303/307/308
  method/body semantics). Caller headers, auth, and default headers ride a
  redirect hop only when it stays on the original request's origin or lands on
  an allowlisted host; any other cross-origin hop is sent with no headers so a
  redirecting endpoint can't exfiltrate secrets.

Exported through the package root (`createHttpTool`).
