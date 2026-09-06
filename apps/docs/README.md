# Package documentation sites

One Astro Starlight site per published package, each on its own subdomain:
`@smthrs/flow` documents at `flow.smithers.sh`, `@smthrs/agent` at
`agent.smithers.sh`, and so on for every entry in `shared/manifest.mjs`.

**Do not edit anything in this directory by hand.** Every site here is
generated, and every page in it is stitched from the package it documents.

## Where the content actually lives

A package's documentation is colocated with its source, in `<pkg>/docs/`.
That tree is the only thing an author writes. `shared/sync-content.mjs`
copies it into `apps/docs/<slug>/src/content/docs/`, completing frontmatter
and rewriting links to site routes on the way.

The committed copy under `src/content/docs/` is a cache, not a source. It is
committed so a site builds from a clean checkout without running the
generator first, and CI fails on drift between the two.

`shared/AUTHORING.md` is the contract for writing those docs: file placement,
frontmatter, the link forms, and how the sidebar is computed. Read it before
adding a page.

## Where the scaffolding comes from

`shared/manifest.mjs` is the roster: one `[slug, npm name, package dir]` row
per site. Everything else is derived from it.

`shared/gen-sites.mjs` writes each site's `package.json`, `astro.config.mjs`,
`tsconfig.json`, `PACKAGE.ts`, and `alchemy.run.ts` from that roster. To
change how every site is configured, edit the generator and rerun it; to
change one site, you almost certainly want the generator too.

```bash
node apps/docs/shared/gen-sites.mjs           # write the scaffolding
node apps/docs/shared/gen-sites.mjs --check    # fail if it drifted
```

Adding a package's site is one row in `manifest.mjs`, a generator run, and a
`pnpm install` to enrol the new workspace member.

## Everyday commands

From the repo root:

```bash
pnpm run docs:sync     # restitch every site from its package's docs/
pnpm run docs:check    # the drift gate: scaffolding and content both current
pnpm run docs:build    # astro build for every site
pnpm run docs:deploy   # alchemy deploy for every configured site
```

One site at a time, by its slug:

```bash
pnpm --filter @smithers/docs-flow sync:docs
pnpm --filter @smithers/docs-flow build
pnpm --filter @smithers/docs-flow check:docs
pnpm --filter @smithers/docs-flow dev
```

Through the build graph, which is what CI runs:

```bash
pnpm exec smithers-build ci '//apps/docs/...'
```

Each site's `PACKAGE.ts` declares `check`, `build`, and `contentSync`.
`contentSync` takes the source package's `docsFiles` filegroup as a labelled
input rather than a glob, because input globs are package scoped and a glob
declared in `apps/docs/<slug>` could never reach the package it documents.

## Deploying

Each site declares an Alchemy 2 `Cloudflare.Website.StaticSite` stack serving
its `dist/` directory. The CLI evaluates the default export to plan, deploy,
or destroy it. Importing the configuration does not deploy anything.

Set `<SLUG>_WORKER_NAME` to the existing physical Cloudflare Worker name. The
slug is uppercased with dashes replaced by underscores, for example
`PLATFORM_NODE_WORKER_NAME`. A new site also needs an explicit, unique name.
Alchemy 1 and 2 derive names differently, so guessing the old name would
create another Worker and orphan the original.

For an existing Alchemy 1 deployment, retain a backup of its `.alchemy`
state before using Alchemy 2. Alchemy 2 uses its own local state under
`.alchemy/state`; do not treat the old state as an Alchemy 2 migration.
From the site's directory, archive the old directory separately, preserve
the existing Worker name, and review an adoption plan before deploying:

```bash
cd apps/docs/flow
export FLOW_WORKER_NAME="existing-worker-name"
# Configure CLOUDFLARE_API_TOKEN through your usual secret mechanism.
pnpm exec alchemy plan --adopt
pnpm run deploy --adopt
```

The initial `--adopt` explicitly admits an existing Worker into the new state.
Keep the resulting local state for future deploys and destroys. A hostname
already attached to a different Worker is refused; transfers require a
separate explicit operation. This includes `flows.smithers.sh`: the former
Alchemy 1 `overrideExistingOrigin` shortcut is not part of this configuration.

`<SLUG>_SITE_DOMAIN` selects a preview domain and
`CLOUDFLARE_SMITHERS_ZONE_ID` pins its zone. Use a separate Worker name for a
preview. The main site follows the same stack contract, with the existing
Worker name `smithers-site` from `apps/site/wrangler.jsonc`.
`SMITHERS_SITE_WORKER_NAME` is required when `SMITHERS_SITE_DOMAIN` selects a
preview domain. Both configurations disable workers.dev URLs and use 404-page
asset handling.

Run `node --test apps/site/scripts/deployment.test.mjs` for offline import and
type checks against the declared Alchemy dependency. These checks do not
exercise credentials, Cloudflare APIs, or an actual deployment.

## One slug is not its package name

`@smthrs/build` documents at `smithers-build.smithers.sh`, not
`build.smithers.sh`: that hostname belongs to the build remote cache in
production. The manifest is the authority on every slug; nothing derives a
hostname from a package name.

## Relationship to smithers.sh

`apps/site` is the product site, and it mirrors each package's `docs/api.md`
into an aggregate API reference under `/docs/reference/api/`. That is a
reference index; the package's own site is its complete documentation. Each
aggregate page links out to it.
