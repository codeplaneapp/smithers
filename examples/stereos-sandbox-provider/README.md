# Example: a custom sandbox provider

Smithers runs a `<Sandbox>` body wherever you can reach. First-class providers
ship for Microsandbox (`smthrs/microsandbox`), Daytona (`smthrs/daytona`),
Vercel (`smthrs/vercel`), AWS (`smthrs/aws`), GCP (`smthrs/gcp`), and Cloudflare
(`smthrs/cloudflare`); `bubblewrap` and `docker` run sandboxes on the local
machine. Anything else plugs into the same seam.

This example builds one of those "anything else" cases end to end: a
`SandboxProvider` for [stereOS](https://stereos.ai) mixtape microVMs, the guest
runtime it needs, three workflows that use it, a hosted demo that drives real
VMs, and the page that publishes all of it at https://stereos.smithers.sh.

Read `real/stereos-provider.ts` first. It is the whole integration: a
`createCommandSandboxProvider` plus an SSH `SandboxSession` that bundles the
child workflow, uploads it, and runs it in the guest.

## Layout

| Path | What it is |
| --- | --- |
| `real/` | The provider, the guest runner, the child workflow, the host scripts, and the raw run captures the site renders. See `real/README.md`. |
| `demo/` | The service on the demo host: gateway, guard, tunnel, VM unit, and the embedded run UI. See `demo/README.md`. |
| `page/` | Page shell, the Live demo controller, the capture renderer, and the Implementation tab's React sources. |
| `tab1-source/` | The Proposed API reference document, rendered verbatim. |
| `project/` | An earlier experiment: the engine under plain Node in a WebContainer with an in-container transport. Kept for reference, not deployed. |
| `site/` | Generated deploy output. Do not edit by hand. |
| `e2e/` | Playwright check against the deployed site. |

There is deliberately no `package.json` here, so the example stays out of the
pnpm workspace and the root `check:docs` gates, matching `apps/patterns-site`.

`pnpm typecheck:examples` covers the provider, the guard, and the guest modules.
The four host workflows and `project/` are excluded in `examples/tsconfig.json`:
`<Sandbox workflow>` is typed `WorkflowDefinition<unknown>`, and a
`WorkflowDefinition<TSpec>` built from a Zod spec is not assignable to it.
Widening that prop is a change to `packages/components`, not to this example.

## The site

Four tabs:

- **Live demo** starts `hello`, `pipeline`, or `approval-demo` on the demo host.
  Every run boots its sandbox body in a real stereOS VM and returns facts only
  the guest can produce. If the host is unreachable the tab says so.
- **How it works** is the recorded evidence: result cards per host, a stepped
  walkthrough whose excerpts are sliced out of the raw captures at build time,
  and the full captures behind disclosures.
- **Implementation** is a `FileTree` and `CodeBlock` from `smthrs/ui` over every
  source file in this directory, highlighted by Shiki at build time.
- **Proposed API** is the design reference for a first-class stereOS provider.

## Build and deploy

```sh
node examples/stereos-sandbox-provider/build.mjs      # regenerate site/
cd examples/stereos-sandbox-provider
../../apps/status-site/node_modules/.bin/wrangler deploy
```

The build reads `real/`, `demo/`, `page/`, and `tab1-source/` and writes
`site/`. Walkthrough excerpts are located in the captures by anchor text, so a
capture that no longer contains an excerpt fails the build instead of shipping
a paraphrase.

## Test

```sh
pnpm install --frozen-lockfile                        # supplies apps/cli's Playwright
node examples/stereos-sandbox-provider/e2e/stereos.e2e.mjs [url]
```

The check starts a real `approval-demo` run through the demo host, waits for it
to park at its gate, clicks Approve inside the embedded run UI, and asserts the
engine-reported `finished`. It also asserts the four tabs, the absence of the
old simulation tab, the recorded evidence, and that the Implementation tree
opens a file whose text matches this repository. Budget five minutes; a run
waits on a real VM. Screenshots land next to the script.

## Demo host

`demo/README.md` documents the systemd units, the guard's rules, and the
latency numbers. The gateway never leaves loopback and the host opens no
inbound port: `cloudflared` dials out, and the guard is the entire public
surface.
