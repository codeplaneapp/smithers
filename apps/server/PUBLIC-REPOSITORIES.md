# Public repository reads

Public repository data is readable without an account. Writes and reads of
account or workspace data continue through the authenticated app API. The
Cloud backend decides whether a repository is public; anonymous requests
never borrow a user's bearer token or cookie.

## Available repositories

`GET /api/public/repos` is the public site's catalog, served by the app Worker
at `https://canary.smithers.sh`. The shared roster in
`src/publicRepoCatalog.ts` lists `smithersai/smithers` first, then its direct
production dependencies (`wevm/incur`, `Effect-TS/effect`). The response keeps
the roster order. Repository requests do not change this roster.

The endpoint fetches public GitHub repository metadata on the server, one
concurrent request per repository, using the same upstream resource as the
app's account-scoped GitHub metadata route.
It projects only stars, forks, open issues plus pull requests, language, and
license. GitHub's `open_issues_count` includes pull requests, so the card labels
that statistic **Issues + PRs**.

Successful metadata is cached for five minutes in the Worker and Cloudflare's
edge cache. Concurrent requests share a fetch. Metadata failures return the
affected repository with `stats: null` while the other repositories keep their
counts; the whole catalog is then cached for 30 seconds. Availability does not
disappear and missing counts are never presented as zero. This endpoint
allows credential-free cross-origin GETs from the landing page.

The Astro card fetches at runtime. Set `PUBLIC_AVAILABLE_REPOS_URL` at site
build time to select a preview app backend. Deploy the app Worker before the
site so the public endpoint is present when the card loads.

## Existing repository APIs

Anonymous GETs to the app's repository metadata, contents, topics, stargazers,
bookmarks, changes, issues, labels, and Git object read routes now reach the
Cloud backend without an identity-service round trip. Both `/api/repos/...`
and `/api/cloud/api/repos/...` use this path. Every read checks the Cloud
backend, so a repository becoming private takes effect on the next request.
These mutable documents and their refusals use `private, no-store`; upstream
`Vary` headers are preserved. Only the separate curated catalog is cached.

Requests carrying a session use the existing authenticated path, preserving
access to private repositories. An expired or non-allowlisted session falls
back to an anonymous repository read. Authenticated answers never enter the public
cache. The existing same-origin rule applies to these app APIs; only the
curated catalog is cross-origin.

Workspace sessions, gateway provisioning, account data, secrets, and write
methods remain outside the anonymous read routes. The app's existing UI
sign-in requirements are independent of this API policy.

## Checks

```sh
bun test ./apps/server/src/publicRepos.test.ts ./apps/server/src/publicRepositoryReads.test.ts ./apps/server/src/index.test.ts
pnpm --filter smithers-server run typecheck
pnpm --filter @smithers/site run check
pnpm --filter @smithers/site run build
```
