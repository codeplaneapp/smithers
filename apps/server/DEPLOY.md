# Deploying `smithers-mvp-web`

The deployable is one Cloudflare Worker, `smithers-mvp-web`, serving the
`smithers-ui` Vite build as static assets and the `/api`, `/v1`, `/workflows`
seams. The only live deployment today is the canary Worker on
`canary.smithers.sh`.

## Frozen identity — read this before touching `wrangler.jsonc`

The Worker's `name` (`smithers-mvp-web`) and its `routes` binding to
`canary.smithers.sh` (`wrangler.jsonc:1-9`) are deliberately frozen:

- Two Durable Objects (`TURN_CANCELS`, `GATEWAY_SESSIONS`) hold state keyed to
  this Worker's identity. Renaming it, or deploying under a different name,
  creates a **fresh** Worker with **fresh, empty** Durable Object storage —
  the existing state is orphaned, not migrated.
- The `canary.smithers.sh` custom-domain binding follows the `routes` entry
  in whichever Worker config declares it. Changing or removing that entry
  detaches the domain from this Worker.

Never edit `wrangler.jsonc`'s `name` or `routes` as part of a routine deploy.
If the identity or domain genuinely needs to change, that is a separate,
deliberate decision — not a side effect of a deploy.

## Scripted deploy (this repo's one repeatable path)

`scripts/deploy.ts` builds the SPA (`vite build` in `apps/ui`), then runs
`wrangler deploy` for this Worker, and writes a receipt (git sha + UTC
timestamp + wrangler version id) to `deploy-receipts/`.

```sh
# Dry run — real vite build, `wrangler deploy --dry-run`, no credentials
# needed, nothing published. Receipt lands in deploy-receipts/dry-run/.
pnpm run deploy:dry            # from the repo root
# or, equivalently:
pnpm --filter smithers-server run deploy:dry

# Real deploy — requires a Cloudflare credential (see below). Receipt lands
# in deploy-receipts/.
pnpm --filter smithers-server run deploy
```

## Credentialed human run

1. **Secret required:** `CLOUDFLARE_API_TOKEN` (a Cloudflare API token scoped
   to the `dd3525a4132493566aeb38de533c8827` account, Workers Scripts + Workers
   Routes edit permissions). Export it in the shell running the deploy, or
   `wrangler login` interactively — either satisfies `wrangler`'s auth.
2. **Account id required:** `CLOUDFLARE_ACCOUNT_ID=dd3525a4132493566aeb38de533c8827`.
   `wrangler.jsonc` declares no `account_id`, so if the token can reach more
   than one Cloudflare account, `wrangler deploy` cannot pick one
   non-interactively and aborts. Export it alongside the token.
3. **Build + deploy:**
   ```sh
   CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=dd3525a4132493566aeb38de533c8827 pnpm --filter smithers-server run deploy
   ```
4. **Verify:** the command prints the new Version ID and the receipt file's
   path (`apps/server/deploy-receipts/latest.json`). Confirm
   `https://canary.smithers.sh` serves the new build (check a UI string you
   just changed, or the Worker's `Current Version ID` against the receipt).

### CI (tag-triggered)

`.github/workflows/apps-deploy.yml` runs the same script on push of a tag
matching `apps-v*` (e.g. `apps-v0.1.0`). It only attempts a real deploy when
the `CLOUDFLARE_API_TOKEN` repository secret is configured; otherwise (and
always for a manual `workflow_dispatch` run) it runs the dry-run path. Set the
secret in the repo's Settings → Secrets and variables → Actions before
cutting a tag that should actually publish.

## The seams this Worker proxies

Sign-in, balance, chat turns, and recommendations resolve in sibling
Workers that live in a different repository (`smithersai/ui`, under
`workers/`).
Deploying this Worker does not deploy them, and a broken sign-in is more
often theirs than ours. `apps/UPSTREAMS.md` names each one, its source, its
hostname, and how to deploy it with a receipt.

### The engine gateway relay needs an identity upstream

When `GATEWAY_UPSTREAM_URL` is set, this Worker relays `/rpc`, `/projections`,
`/sync`, and any WebSocket upgrade to the engine gateway under its own
`GATEWAY_AUTH_TOKEN`, which that gateway honours as the operator. Every one of
those relays therefore requires the same validated, allowlisted session the
workflow routes require, so `IDENTITY_UPSTREAM_URL` must be set on any
deployment that sets `GATEWAY_UPSTREAM_URL`.

Configuring the gateway upstream without the identity upstream fails closed:
the relay answers `501` naming `IDENTITY_UPSTREAM_URL`, never an anonymous
forward. Ordinary `GET` and `HEAD` requests to the exact `/health` mount stay
anonymous, so a supervisor can still ask which workspace a gateway belongs to.
A WebSocket upgrade at that path still requires a session.

## Rollback

Cloudflare Workers keep prior versions. To roll back to the version recorded
in an older receipt:

```sh
bun x wrangler rollback --message "rollback to <git sha from receipt>"
```

run from `apps/server`, with the same `CLOUDFLARE_API_TOKEN` set. This
targets the immediately-prior version; for a specific historical version, use
`bun x wrangler deployments list` to find its Version ID and
`bun x wrangler rollback <version-id>`. Rollback does not touch Durable
Object state — `TURN_CANCELS` and `GATEWAY_SESSIONS` storage is unaffected
either way, since it is keyed to the (unchanged) Worker identity, not to a
version.

### What the receipt records, and why every receipt on disk says `null`

`scripts/deploy.ts` captures wrangler's stdout (`capture: true`) and pulls the
version id out of it with `/Current Version ID:\s*([0-9a-f-]{36})/i`. Wrangler
4.123.0 prints `Current Version ID: <uuid>` through `logger.log`, which is
`console.log`, which is stdout — so a **real** deploy does record the id. A
`--dry-run` returns at `--dry-run: exiting now.` before printing any id, which
is why every receipt in `deploy-receipts/dry-run/` carries
`"wranglerVersionId": null`. The mechanism is sound; it has simply never been
exercised by a credentialed run.

Two residual risks remain, and `scripts/deploy.ts` does not guard either one
today: wrangler could move the id to stderr (only stdout is captured), or
rename the label between versions. Either turns a real deploy into a receipt
that says `null`, and rollback then has nothing to target. The rollback probe
below is what catches it — a real deploy whose receipt names no version fails
the probe.

### Probe it: `scripts/canary/rollback-probe.ts`

```sh
CLOUDFLARE_API_TOKEN=<token> bun scripts/canary/rollback-probe.ts
```

It asserts three things about `smithers-mvp-web`:

1. the newest receipt (`deploy-receipts/latest.json`, or `--receipt <path>`)
   names a wrangler version id,
2. that version is the one Cloudflare is actually serving
   (`GET /accounts/<account>/workers/scripts/smithers-mvp-web/deployments`),
3. a prior version is still in Cloudflare's version list
   (`GET .../versions`), so `wrangler rollback <id>` has a target. The probe
   prints the exact rollback command for that version.

Both response shapes were read back from the live account on 2026-08-18:
`/versions` answers `{ success, result: { items: [{ id, number, metadata: {
created_on }, annotations }] } }` newest first, and `/deployments` answers
`{ success, result: { deployments: [{ versions: [{ version_id, percentage }] }] } }`
newest first. Cloudflare lists 10 versions for `smithers-mvp-web`, and the
version serving 100% of traffic is `dffd4070-e5c6-4fd0-86b6-73ebedff5600`
(created 2026-08-13T06:21:59Z) — so a rollback target exists today even though
no receipt on disk names the deployed version.

**"Reachable" means rollback-eligible, not fetchable.** A prior Worker version
has no public URL; nothing can HTTP it. The probe never claims otherwise.

It skips (exit 0, `skip:` lines) when `CLOUDFLARE_API_TOKEN` is unset or no
receipt is on disk, and reports `INCONCLUSIVE` rather than `PASS` when it
verified nothing. It fails when a receipt exists but cannot support a
rollback. Receipts are gitignored and exist only on the machine that deployed,
so this belongs in the deploy workflow after a real deploy, not in a scheduled
canary that has no receipt to read.

### The drill — do this once, by hand, and keep the receipt

A rollback plan nobody has ever exercised is not a rollback plan. Rolling back
and forward swaps the live deployment, so it is a human drill and is
deliberately not automated.

1. Deploy for real, so a receipt names a version:
   `CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=dd3525a4132493566aeb38de533c8827 pnpm --filter smithers-server run deploy`.
   Record `deploy-receipts/latest.json` — call this version **N**.
2. Run `bun scripts/canary/rollback-probe.ts`. It must pass and must name the
   prior version, **N-1**.
3. `bun x wrangler@4.123.0 rollback <N-1 id> --message "CN-24 drill"` from
   `apps/server`.
4. Confirm `https://canary.smithers.sh` serves the older build, and that
   `bun x wrangler@4.123.0 deployments list` shows N-1 at 100%.
5. Roll forward: `bun x wrangler@4.123.0 rollback <N id> --message "CN-24 drill, forward"`.
6. Confirm the canary serves N again and re-run the probe.
7. Write the drill up in an `apps/WAVE*-RECEIPT.md` note with both version ids
   and the timestamps, so the next person can see it was really done.
