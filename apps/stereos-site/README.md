# stereos-site

The page at https://stereos.smithers.sh.

- **Live demo** — starts real Smithers runs on a GCE host with nested
  virtualization. Each run's `<Sandbox>` body executes inside a booted stereOS
  mixtape VM. The backend is `demo/`; see `demo/README.md`.
- **How it works** — the recorded captures of the same provider on two hosts,
  a stepped walkthrough drawn from them, and the registry defect found while
  building it. Everything comes from `real/`.
- **Implementation** — a file-tree browser over the sources that implement all
  of the above, built from the shipped `FileTree` and `CodeBlock` components in
  `smthrs/ui`.
- **Proposed API** — the design reference, served whole at
  `/proposed-api.html`.

There is deliberately no `package.json` in this directory, so the app stays out
of the pnpm workspace and the `check:docs` gates, matching `apps/patterns-site`.

## Layout

| Path | What it is |
| --- | --- |
| `page/index.template.html` | Page shell, tab chrome, and all page copy. |
| `page/live.js` | Live demo tab: backend discovery, starting runs, evidence. |
| `page/evidence.js` | How it works tab: renders the committed captures. |
| `page/impl/main.jsx` | Implementation tab: the file tree and code viewer. |
| `demo/` | The service running on the demo host: guard, workflows, provider, embedded run UI, systemd units. |
| `real/` | The provider, guest runner, workflows, host scripts, and the recorded captures. |
| `tab1-source/` | Source document for the Proposed API tab. |
| `project/` | The WebContainer demo this page used to carry, kept for reference (PR #1506). It is no longer built into the site. |
| `site/` | Generated deploy output. Do not edit by hand. |
| `e2e/` | Playwright check against the deployed site. |

## Build and deploy

```sh
node apps/stereos-site/build.mjs                     # regenerate site/
cd apps/stereos-site
../status-site/node_modules/.bin/wrangler deploy
```

`build.mjs` needs a root `pnpm install`: it bundles the Implementation tab with
esbuild and tokenizes its sources with Shiki, both resolved from the workspace
install.

The page reaches the demo backend over a cloudflared tunnel, so the host never
listens on a public port. `demo/tunnel.sh` publishes the tunnel's current
hostname to the `_stereos-api.smithers.sh` TXT record and `page/live.js`
resolves it over DNS-over-HTTPS. If the host does not answer, the Live demo tab
says so and links to the recorded runs; it never falls back to a simulation.

## Test

```sh
pnpm install --frozen-lockfile                           # supplies apps/cli's Playwright dependency
node apps/stereos-site/e2e/stereos.e2e.mjs [url]
```

The check asserts that the WebContainer simulation tab is gone, that the Live
demo tab starts a real run which reaches the engine-reported `finished` state
with guest-produced evidence, that `approval-demo` parks at
`waiting-approval` and finishes after the Approve button in the embedded run UI
is clicked, that both recorded captures and the registry diagnosis are intact,
and that the Implementation tree opens a file whose highlighted contents match
the committed source. It writes screenshots next to itself. Budget 3-6 minutes:
it waits on real VM runs.
