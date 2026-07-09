# Smithers Landing Page

Next.js landing page for Smithers. This app is intentionally separate from:

- `docs/`, which owns the Mintlify documentation at `smithers.sh`.
- `apps/smithers/`, which owns the local-only Smithers control surface.

This package is deployable as a normal Next.js app, but it does not include
provider-specific deployment configuration. The repository owner can choose the
target host and domain wiring independently.

Set `NEXT_PUBLIC_SITE_URL` in the deployment environment so metadata, sitemap,
and generated social images use the public landing page URL.

## Run it

```bash
pnpm -C apps/landing-page dev
```

## Check it

```bash
pnpm -C apps/landing-page typecheck
pnpm -C apps/landing-page lint
pnpm -C apps/landing-page build
```
