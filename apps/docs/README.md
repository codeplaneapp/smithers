# Package documentation sites

One Astro Starlight site per published package, each on its own subdomain:
`@smthrs/flow` documents at `flow.smithers.sh`, `@smthrs/agent` at
`agent.smithers.sh`, and so on for all 53.

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
pnpm run docs:build    # astro build for all 53
pnpm run docs:deploy   # alchemy deploy for all 53
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

Each site is an assets-only Cloudflare Website serving its `dist/`, defined by
`shared/alchemy-site.mjs` and mirroring `apps/site/alchemy.run.ts`. Resources
are adopted, so a deploy over an existing site takes it over rather than
failing.

```bash
CLOUDFLARE_API_TOKEN=... ALCHEMY_PASSWORD=... pnpm -C apps/docs/flow deploy
```

Optional environment: `<SLUG>_SITE_DOMAIN` overrides the domain for a preview
deploy (the slug uppercased with dashes as underscores, so
`PLATFORM_NODE_SITE_DOMAIN`), and `CLOUDFLARE_SMITHERS_ZONE_ID` pins the zone
when the domain does not resolve it.

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
