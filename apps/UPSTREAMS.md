# The seams this product runs on

`smithers-mvp-web` (`apps/server`) is a proxy for most of what a user does.
Sign-in, balance, and chat turns all resolve in **sibling
Cloudflare Workers that are not in this repository** — they live in
`~/flows/ui/workers/`, a separate checkout. Nothing in `apps/**` can deploy,
roll back, or even name a version of them.

That is a real operational gap during an alpha: a user reports that sign-in
broke, and the first question — _what is deployed on identity right now?_ —
had no answer here. This file is the answer, and the deploy script named below
is how you change one and leave a record.

Verified 2026-08-18.

## The inventory

| Seam                                                                                        | Worker env var (`apps/server/wrangler.jsonc`) | Cloudflare Worker         | Source                        | Custom domain          |
| ------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------- | ----------------------------- | ---------------------- |
| Identity — GitHub OAuth, sessions, the allowlist, the watched-repos chooser, the jjhub cloud-token door | `IDENTITY_UPSTREAM_URL`                       | `smithers-cloud-identity` | `~/flows/ui/workers/identity` | `identity.smithers.sh` |
| Billing — balances, grants, the admin grant surface                                         | `BILLING_UPSTREAM_URL`                        | `smithers-cloud-billing`  | `~/flows/ui/workers/billing`  | `billing.smithers.sh`  |
| Chat — the metered turn upstream                                                            | `SMITHERS_CHAT_URL`                           | `smithers-cloud-chat`     | `~/flows/ui/workers/chat`     | `chat.smithers.sh`     |
| Smithers Cloud (jjhub) — gateway provisioning and the relay                                 | `SMITHERS_CLOUD_API_BASE_URL`                 | _(not a Worker)_          | `~/plue`                      | `api.jjhub.tech`       |

The recommendations worker (`smithers-cloud-reco`, `reco.smithers.sh`) was
deleted on 2026-08-24: the first-run digest and the one ranked recommendation
are no longer a feature, and the watched-repos chooser moved onto the identity
worker (`GET /api/identity/repos`, `GET/PUT /api/identity/watched`). The ops
teardown — deleting the Cloudflare Worker, the `reco.smithers.sh` custom
domain, and its secrets (`RECO_SERVICE_TOKEN`, its `ADMIN_SERVICE_TOKEN`,
its `IDENTITY_SERVICE_TOKEN` copy) — is an operator step, not a code change.

Four more workers exist in that tree and this product does not call them
today: `connectors-catalog`, `cron`, `status`, `sync`, `webhooks`.

## Deploying one

```sh
cd ~/flows/ui
node workers/deploy.mjs --list                  # every deployable worker
node workers/deploy.mjs identity --dry-run      # no credentials, nothing published
node workers/deploy.mjs identity                # real deploy; writes a receipt
```

Receipts land in `workers/<name>/deploy-receipts/`, with `latest.json` naming
the git sha, the timestamp, and the Cloudflare version id — the same shape
`apps/server/deploy-receipts/` uses, so both halves of a deploy can be read the
same way.

Each Worker's `name` and `routes` are its identity. Renaming one deploys a
fresh Worker with empty Durable Object storage and detaches its custom domain;
the deploy script never edits either.

## Two things to know before you touch these

**The `smithers.sh` hostnames are live, and this repo does not use them.**
`apps/server/wrangler.jsonc` still points identity at
`smithers-cloud-identity.willcory10.workers.dev`, because when wave 7 shipped,
the `smithers.sh` CNAMEs still pointed at dead Vercel records
(`apps/WAVE7-DEPLOY-RECEIPT.md` §1). That is no longer true: on 2026-08-18
`identity.smithers.sh`, `billing.smithers.sh`, `connectors.smithers.sh`, and
`status.smithers.sh` all answer `/healthz` from Cloudflare, and identity's
custom domain returns a byte-identical health payload to its `workers.dev`
twin — the same Worker, reached two ways.

So the alpha depends on a personal `workers.dev` subdomain for sign-in, and no
longer has to. Repointing that var at the custom domain is a one-line change
to `apps/server/wrangler.jsonc` plus a deploy. It is deliberately not made
here: it changes production routing on the next deploy, and that is the
operator's call, not a side effect of writing this
file. GitHub OAuth callbacks are registered against the _product_ origin, not
these, so they are unaffected.

**The source tree is a working branch.** `~/flows/ui` was on
`wave5-billing-bridge` with uncommitted changes to the identity worker when
this was written. Commit or stash before deploying anything from it: a deploy
ships the working tree, and the receipt's git sha will not describe what
actually went out.
