# Public repository reads

Public repository data is readable without an account. Writes and reads of
account or workspace data continue through the authenticated app API. The
Cloud backend decides whether a repository is public; anonymous requests
never borrow a user's bearer token or cookie.

## Available repositories

`GET /api/public/repos` is the public site's catalog, served by the app Worker
at `https://canary.smithers.sh`. The shared roster in
`src/publicRepoCatalog.ts` lists `smithersai/smithers` alone at launch. The
roster grows as maintainers claim their repositories, and the response keeps
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

Each card's primary link opens the repository in the web app at
`<PUBLIC_APP_ORIGIN>/?repo=owner/name`; the default origin is
`https://canary.smithers.sh`. The web app honours the name only when this
catalog carries it, makes that repository the active selection, and states it
as the active repository in the agent's per-turn runtime context. It strips
the `repo` parameter from the URL either way, so a reload does not reselect.
Set `PUBLIC_APP_ORIGIN` at site build time to point the cards at a preview app.

## Existing repository APIs

Anonymous GETs to the app's repository metadata, contents, topics, stargazers,
bookmarks, changes, issues, labels, and Git object read routes now reach the
Cloud backend without an identity-service round trip. Both `/api/repos/...`
and `/api/cloud/api/repos/...` use this path. Every read checks the Cloud
backend, so a repository becoming private takes effect on the next request.
These mutable documents and their refusals use `private, no-store`; upstream
`Vary` headers are preserved. Only the separate curated catalog is cached.

The Cloud backend serves each catalog repository's public mirror under its
own namespace, not under the GitHub name: `smithersai/smithers` is mirrored as
`smithers-canary/smithers`, and the backend refuses the GitHub name without
credentials. Each `AVAILABLE_REPOS` entry names that mirror in `cloudRepo`,
and anonymous reads substitute it for the owner and name segments before
forwarding; the document path and query are unchanged, and the catalog name
matches case-insensitively. A repository outside the catalog is forwarded
under the name the browser asked for. `cloudRepo` is server-side only and
never appears in the `GET /api/public/repos` response. Signed-in requests
keep the GitHub name and the user's own bearer.

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
