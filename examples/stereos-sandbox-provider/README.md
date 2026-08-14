# @stereos/smithers

The worked example behind
[custom-sandbox.smithers.sh](https://custom-sandbox.smithers.sh): how to add a
custom sandbox to Smithers, using stereOS mixtape microVMs as the case study.

Smithers runs a `<Sandbox>` body wherever you can reach. First-class providers
ship for Microsandbox (`smthrs/microsandbox`), Daytona (`smthrs/daytona`),
Vercel (`smthrs/vercel`), AWS (`smthrs/aws`), GCP (`smthrs/gcp`), and Cloudflare
(`smthrs/cloudflare`); `bubblewrap` and `docker` run sandboxes on the local
machine. Anything else plugs into the same seam.

This package is what a sandbox vendor would ship for that seam: a
`SandboxProvider` for [stereOS](https://stereos.ai) microVMs, the guest runtime
it needs, three workflows that use it, a hosted demo that drives real VMs, and
the guide that publishes all of it.

It is named `@stereos/smithers` and marked `private`. It is not published to
npm; `examples/` is outside the pnpm workspace, so the name is a label on the
integration, not a registry entry.

Read `real/stereos-provider.ts` first. It is the whole integration: a
`createCommandSandboxProvider` plus an SSH `SandboxSession` that bundles the
child workflow, uploads it, and runs it in the guest.

## Layout

| Path | What it is |
| --- | --- |
| `real/` | The provider, the guest runner, the child workflow, the host scripts, and the raw run captures the site renders. See `real/README.md`. |
| `demo/` | The service on the demo host: gateway, guard, tunnel, VM unit, and the embedded run UI. See `demo/README.md`. |
| `page/` | Page shell, the Live demo controller, the capture renderer, and the Implementation tab's React sources. |
| `tab1-source/` | The `@stereos/smithers` API reference document, rendered verbatim. |
| `project/` | An earlier experiment: the engine under plain Node in a WebContainer with an in-container transport. Kept for reference, not deployed. |
| `site/` | Generated deploy output. Do not edit by hand. |
| `e2e/` | Playwright check against the deployed site. |

`package.json` here is a label only. `examples/` is not in
`pnpm-workspace.yaml`, so the directory stays out of the workspace and the root
`check:docs` gates, matching `apps/patterns-site`.

`pnpm typecheck:examples` covers the provider, the guard, and the guest modules.
The four host workflows and `project/` are excluded in `examples/tsconfig.json`:
`<Sandbox workflow>` is typed `WorkflowDefinition<unknown>`, and a
`WorkflowDefinition<TSpec>` built from a Zod spec is not assignable to it.
Widening that prop is a change to `packages/components`, not to this example.

## The site

One page, five tabs:

- **Tasks & sandboxes** is the concept: a workflow renders to tasks, a task runs
  in the host process by default, and `<Sandbox provider={...}>` moves one task
  into its own sandbox. Two inline SVG diagrams carry it.
- **Build your own** is the tutorial. Eight steps, each with a code pane sliced
  out of a real file in this package by anchor text. The recorded evidence sits
  under it behind disclosures.
- **Live demo** starts `hello`, `pipeline`, or `approval-demo` on the demo host.
  Every run boots its sandbox body in a real stereOS VM and returns facts only
  the guest can produce. If the host is unreachable the tab says so.
- **Implementation** is a `FileTree` and `CodeBlock` from `smthrs/ui` over every
  source file in this package, highlighted by Shiki at build time.
- **Documenting your API** is the reference document you would ship with a
  provider package.

## Build and deploy

```sh
node examples/stereos-sandbox-provider/build.mjs      # regenerate site/
cd examples/stereos-sandbox-provider
../../apps/status-site/node_modules/.bin/wrangler deploy
```

The build reads `real/`, `demo/`, `page/`, and `tab1-source/` and writes
`site/`. Tutorial panes and walkthrough excerpts are located in their sources by
anchor text, so a file that no longer contains an anchor fails the build instead
of shipping a paraphrase.

The site does not send `Cross-Origin-Embedder-Policy`. The Live demo tab embeds
the run UI served by the demo host, and `require-corp` would block that frame.

## Test

```sh
pnpm install --frozen-lockfile                        # supplies apps/cli's Playwright
node examples/stereos-sandbox-provider/e2e/stereos.e2e.mjs [url]
```

The check starts a real `approval-demo` run through the demo host, waits for it
to park at its gate, clicks Approve inside the embedded run UI, and asserts the
engine-reported `finished`. It also asserts the five tabs and their order, that
Tasks & sandboxes is the default, that both concept diagrams render, that the
tutorial panes are the real source, that the Implementation tree opens a file
whose text matches this repository, that an `#impl/<path>` deep link lands on
that file, that no tab scrolls sideways in a 390px viewport, and that
`stereos.smithers.sh` no longer serves this site. Budget five minutes; a run
waits on a real VM. Screenshots land next to the script.

## Demo host

`demo/README.md` documents the systemd units, the guard's rules, and the
latency numbers. The gateway never leaves loopback and the host opens no
inbound port: `cloudflared` dials out, and the guard is the entire public
surface.
