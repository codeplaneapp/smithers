# stereos-site

Two-tab page at https://stereos.smithers.sh.

- **Proposed API** — the stereOS sandbox provider design reference. Tab content
  is lifted verbatim from `reference/stereos-sandbox-provider.html` at build
  time; edit that file, not the generated page.
- **Live demo** — a WebContainer that boots Node, installs the published
  `smthrs` package, and runs three real workflows against the PGlite backend.

There is deliberately no `package.json` in this directory, so the app stays out
of the pnpm workspace and the `check:docs` gates, matching `apps/patterns-site`.

## Layout

| Path | What it is |
| --- | --- |
| `page/index.template.html` | Page shell, tab chrome, and tab-2 copy. |
| `page/demo.js` | Drives the container: boot, install, gateway, app, workflows. |
| `tab1-source/` | Source document for tab 1. |
| `project/` | The tree mounted into the WebContainer. |
| `project/workflows/` | `hello`, `pipeline`, `approval-demo`. |
| `project/app/` | Vite + React UI built on `smthrs/gateway-react` and `smthrs/gateway-ui`. |
| `project/sandbox/` | The stereOS-shaped provider seam, with in-container exec. |
| `project/shims/` | Loader shims that let the Bun-targeted package run under Node. |
| `site/` | Generated deploy output. Do not edit by hand. |
| `e2e/` | Playwright check against the deployed site. |

## Build and deploy

```sh
node apps/stereos-site/build.mjs                     # regenerate site/
cd apps/stereos-site
../status-site/node_modules/.bin/wrangler deploy
```

`site/webcontainer-api.js` is bundled separately and only needs regenerating
when `@webcontainer/api` changes:

```sh
npx esbuild node_modules/@webcontainer/api/dist/index.js \
  --bundle --format=esm --minify --outfile=site/webcontainer-api.js
```

The API is self-hosted rather than loaded from a CDN because the page sets
`Cross-Origin-Embedder-Policy: require-corp`, which WebContainer needs for
`crossOriginIsolated`.

## Test

```sh
node apps/stereos-site/e2e/stereos.e2e.mjs [url]
```

The check asserts the COOP/COEP pair and `crossOriginIsolated`, that tab 1
renders, that `hello` and `pipeline` reach the engine-reported `finished`
state, that `approval-demo` stops at `waiting-approval`, and that clicking
Approve in the embedded app lets it finish. It writes screenshots next to
itself. Budget 10–20 minutes: npm install runs inside the browser.

## Running smthrs under Node

The published package targets Bun. The mounted project applies six things, all
verified before deploy:

1. `overrides.effect` pins one `effect` version. Without it npm nests about
   twenty copies and the engine fails a Context lookup with
   `Cannot read properties of undefined (reading 'get')`.
2. `shims/` maps `bun`, `bun:sqlite`, `bun:test`, and `drizzle-orm/bun-sqlite`
   to stubs. Node rejects the `bun:` URL scheme at load time, before any
   runtime guard can run.
3. `SMITHERS_BACKEND=pglite`, plus `tsconfig.json` with `jsx: react-jsx` and
   `jsxImportSource: smthrs` so tsx compiles JSX with the automatic runtime.
4. `patch-smthrs.mjs`, a postinstall patch that skips the cross-run memory
   sidecar when `Bun` is undefined.
5. An in-process PGlite client replaces `PGLiteSocketServer`. The socket server
   accepts a WebContainer connection but does not complete its PostgreSQL
   handshake.
6. A single-writer transaction path keeps every engine write but omits
   transaction grouping. Effect 4 does not unwind the nested transaction
   operation after successful PGlite writes in WebContainer. The demo runs one
   writer at a time and stops the gateway before it resumes a workflow.

Workflows use `await openSmithersBackend(...)`, not `createSmithers()` — the
latter is the synchronous `bun:sqlite` path and refuses PGlite.
