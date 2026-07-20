# 🐛 openapi: [medium] templated server URLs (`https://{region}.api.com`) are used verbatim — server variables never substituted

GitHub: https://github.com/smithersai/smithers/issues/716

_via ultracode (Opus multi-agent) review_

## Summary
`resolveServerUrl` only distinguishes absolute vs. relative URLs and never substitutes OpenAPI 3.0 server variables from `servers[].variables[].default`, so a templated server URL is used verbatim as the base URL and every request hits an unresolvable host.

## Location
- `packages/openapi/src/tool-factory/_helpers.js:397` (`resolveServerUrl`) — returns the URL unchanged when `isAbsoluteUrl` is true.
- `packages/openapi/src/tool-factory/_helpers.js:377` (`isAbsoluteUrl`) — `new URL("https://{region}.api.example.com/v1")` parses with host literally `{region}.api.example.com`, so it counts as absolute (verified).
- `packages/openapi/src/tool-factory/_helpers.js:412` (`resolveBaseUrl`) — feeds `servers[0].url` straight through when no `baseUrl` option is given.

## Failure scenario
Spec whose only server is `{ url: "https://{region}.api.example.com", variables: { region: { default: "us" } } }`, caller passes no `baseUrl`. Generated tools fetch `https://{region}.api.example.com/...`, which fails DNS resolution instead of `https://us.api.example.com/...`. The tool surfaces an opaque network error, not a clear message.

## Why it matters
Server variables with defaults are a standard, widely-used OpenAPI feature (region/environment/version templating). Without substitution these specs are silently unusable unless the caller manually overrides `baseUrl`. Fix: after confirming absoluteness, replace each `{var}` in the URL with `spec.servers[i].variables[var].default` (and model `variables` in the `OpenApiSpec` type at `index.d.ts:131`).
