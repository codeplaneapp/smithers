# gatewayUi/

The pieces `../gateway.js` uses to serve workflow UIs and the built-in operator
console:

- `createGatewayUiApp.js` — Hono sub-app: resolves a UI match per pathname,
  serves the index HTML and bundled assets with `no-store` headers.
- `bundle.js` — `Bun.build` bundler for UI entries.
- `auth.js` — thin gate that skips authentication when `authMode` is `"none"`.
- `defaultOperatorUi.js` + `defaultConsole.js` — the default operator console
  client.

Gotchas:

- `defaultOperatorUi.js` ships its UI by serializing `defaultOperatorUiClient`
  via `Function.prototype.toString()`: the function body IS the browser script.
  It must stay self-contained (no imports, no outer-scope references) and its
  source text must not be restyled. The theme CSS is spliced in over the
  `/*__SMITHERS_WORKFLOW_UI_THEME_CSS__*/` placeholder.
- `bundle.js` pins BOTH `react` and `react-dom` to this package's copies via an
  `onResolve` plugin (mixed React copies crash react-dom). The bundle cache is
  keyed by entry path and invalidated when any build input changes;
  `SMITHERS_GATEWAY_UI_NO_CACHE=1` still rebuilds on every request.
- Consumers are `gateway.js` and tests, but these modules are also reachable as
  public subpaths through the package's `./*` wildcard export, so keep exported
  names stable.
