# stereos-site

Four-tab page at https://stereos.smithers.sh.

- **Live demo** — starts real `hello`, `pipeline`, and `approval-demo` runs on
  the demo host. Each run's sandbox body executes inside a booted stereOS
  mixtape VM. The page embeds the run UI the host serves and shows the guest
  facts the run returned. If the host is unreachable the tab says so and points
  at the recorded runs; it never fabricates a run.
- **How it works** — the two recorded runs, as a flow diagram, per-host result
  cards, a stepped walkthrough whose excerpts are sliced out of the committed
  captures at render time, and the full unedited captures behind disclosures.
- **Implementation** — a file tree over the sources that actually run the demo,
  with a viewer and per-file GitHub links. Built from `smthrs/ui` `FileTree`,
  `Card`, `Badge`, `Button`, and `EmptyState` plus `smthrs/gateway-ui`
  `StatusPill`.
- **Proposed API** — the provider design reference, demoted to a secondary tab.
  Content is lifted verbatim from `tab1-source/stereos-sandbox-provider.html` at
  build time; edit that file, not the generated page. `build.mjs` scopes the
  reference stylesheet to `#panel-api` so it cannot reach the rest of the page.

There is deliberately no `package.json` in this directory, so the app stays out
of the pnpm workspace and the `check:docs` gates, matching `apps/patterns-site`.

The design follows `apps/patterns-site`: card grid, tight type scale, inline
SVG diagrams, near-zero prose. The page holds about 500 words of visible prose.

## Layout

| Path | What it is |
| --- | --- |
| `page/index.template.html` | Page shell, design system, tab chrome, and all copy. |
| `page/flow-diagram.svg` | The host-to-guest flow diagram, inlined into two tabs. |
| `page/live.js` | Live demo: backend discovery, run control, guest evidence. |
| `page/evidence.js` | How it works: result cards, walkthrough excerpts, captures. |
| `page/impl/main.jsx` | Implementation file tree, bundled by esbuild into `site/impl.js`. |
| `tab1-source/` | Source document for the Proposed API tab. |
| `real/` | The provider, guest workflow, host scripts, and recorded captures. |
| `service/` | The demo service that runs on the GCE host. See `service/README.md`. |
| `project/` | The retired WebContainer demo, kept for reference (PR #1506). |
| `site/` | Generated deploy output. Do not edit by hand. |
| `e2e/` | Playwright check against the deployed site. |

## Build and deploy

```sh
node apps/stereos-site/build.mjs                     # regenerate site/
cd apps/stereos-site
../status-site/node_modules/.bin/wrangler deploy
```

`build.mjs` reads the implementation sources out of the repository, so the
Implementation tab cannot drift from the code that runs.

## Test

```sh
pnpm install --frozen-lockfile                       # supplies apps/cli's Playwright dependency
node apps/stereos-site/e2e/stereos.e2e.mjs [url]
```

The check asserts that the WebContainer simulation tab and its assets are gone,
that the Live demo tab starts a real run that reaches the engine-reported
`finished` state and reports `coder-dev` guest facts, that `approval-demo` parks
at its gate and finishes after the Approve click inside the embedded UI, that
the guard does not expose gateway RPC, that the file tree opens `service/guard.ts`
and shows source byte-identical to the repository, and that both recorded
captures and the Proposed API document still hold their claims. Budget 3-6
minutes; a cold VM boot on the demo host adds about 30 seconds.
