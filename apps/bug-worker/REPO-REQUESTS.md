# Community repository requests

The home page uses `https://bug.smithers.sh/api/repo-requests`. Set
`PUBLIC_REPO_REQUESTS_URL` at site build time for a preview backend.
No account is required to submit, follow, or browse repositories.

## Lifecycle and app handoff

`POST /api/repo-requests` accepts `{ "repo": "owner/repo", "email": "optional@example.com" }`.
It checks GitHub for a public, enabled repository with a recognized license,
then stores it as `smithering`. GitHub URLs and `.git` suffixes normalize to
one case-insensitive repository identity. This records a request for the team
to support the repository; it does not launch an agent or provision the app.
Every accepted request is one nomination. The response is
`{ repo, subscribed }`, and `repo.nominations` is the repository's current
nomination count, including this one.

Each public record has `name`, `url`, `status` (`smithering` or `ready`),
`appUrl` (null until ready), and `nominations`.

`GET /api/repo-requests` returns `{ repos }`: the 20 most nominated
repositories, most nominated first, ties by name. The Worker ranks the first
200 recorded repositories, so a repository beyond that scan is not listed.
`GET /api/repo-requests?repo=owner/repo` returns `{ repo }` for one
repository, 404 when nobody has requested it, and 400 for an invalid name.
The upcoming app can consume this same public catalog and use ready entries
as its supported repositories.

## Nomination counts

Each repository has one counter key, `repo-nominations:<owner/repo>`, holding
the count as a decimal string. An accepted `POST` reads it, adds one, and
writes it back; rejected requests (invalid input, private or unlicensed
repository, rate limit) never touch it. KV has no atomic increment, so two
nominations that arrive at the same moment can record as one. The tally is
public and informational, so that undercount is accepted rather than adding a
Durable Object. The list endpoint reads one counter per recorded repository,
then the record and readiness of the top 20 only.

Once the app supports a repository **and its repository view works for an
anonymous visitor**, call `POST /api/repo-requests/complete` with the existing
`x-bug-admin` secret header and this JSON body:

```json
{
  "repo": "owner/repo",
  "appUrl": "https://app.smithers.sh/repos/owner/repo"
}
```

The URL is supplied by the app integration, not inferred by the landing page.
Only HTTPS URLs on `smithers.sh`, `app.smithers.sh`, and `canary.smithers.sh`
are accepted. The completion endpoint does not test the destination's access
policy: anonymous access must be verified before publishing. Do not publish
an app URL until that repo view exists. Publishing is monotonic: new requests
cannot reset readiness, and changing a published URL returns 409.

All visitors then see **Smithered / Open in Smithers**. The current app is still
being built; this change supplies the intake, public catalog, and completion
contract, not the repository view inside that app.

## Community forks

The first accepted nomination of a repository forks it into the
[smithers-community](https://github.com/smithers-community) GitHub
organization with `POST https://api.github.com/repos/{owner}/{repo}/forks` and
the body `{ "organization": "smithers-community" }`. Set `GITHUB_FORK_TOKEN`
when deploying the Worker to a token that can create forks in that
organization. The outcome is stored under `repo-fork:<owner/repo>` as
`{ "status": "forked", "forkedAt": "..." }`, `{ "status": "failed", "error": "..." }`,
or `{ "status": "skipped" }` when the token is unset. A fork failure is logged
and recorded but never fails the nomination; the repository is still stored as
`smithering`. Fork status is not part of the public listing.

## Maintainer claims

A maintainer can claim a nominated repository. Claiming only records who
claimed it; it does not grant access or start any work yet.

`POST /api/repo-claims` accepts `{ "repo": "owner/repo", "login": "github-login", "email": "optional@example.com" }`.
It returns `200` with `{ repo, login, claimedAt }` for the first claim, `409`
if the repository is already claimed, `404` if the repository has never been
nominated, and `400` for an invalid repository, login, or email. Claims share
the per-IP throttle used by nominations.

`GET /api/repo-claims?repo=owner/repo` returns `{ repo, login, claimedAt }` or
`404`. Claims live under `repo-claim:<owner/repo>`. The claimant's email is
stored with the claim and never appears in responses.

## Notifications

Configure `RESEND_API_KEY` and `NOTIFICATION_FROM` (a verified sender) when
deploying the Worker. Subscribers receive one transactional email upon
completion. No emails are sent during development tests. Delivery uses the
[Resend send endpoint](https://resend.com/docs/api-reference/emails/send-email)
and [idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).
Receipts skip already-sent messages; a cron runs every ten minutes to retry
failed sends and catch signups concurrent with completion. Without provider
configuration the subscriptions remain pending, and completion reports
`email_not_configured`. Always supply both email variables on redeploy so
Alchemy does not remove the bindings.

Maintainers can also call `POST /api/repo-requests/notify` with `x-bug-admin`
and `{ "repo": "owner/repo" }`. A batch handles up to 50 subscriptions and
returns `sent`, `failed`, `pending`, and a next `cursor`. Pass that cursor in
the next call; retry the same page on failures. Completion remains visible
if sending fails. The cron keeps separate sweep and subscriber cursors and handles at most two
repositories per invocation to stay within Worker subrequest limits.

KV is eventually consistent. New requests, readiness, and counts may take up
to a minute to reach other locations; the page loads the most nominated list
once per visit and again after each submission. Records
and per-email subscriptions use separate keys so concurrent submissions
cannot overwrite a subscriber list or reset completed work. Provider keys
protect concurrent delivery retries for 24 hours; if a send succeeds but its
KV receipt cannot be saved for longer than that, a retry may send a duplicate.
The existing KV per-IP throttle is advisory, not an atomic rate limiter.

Email addresses never appear in public responses. They live under
`repo-subscriber:<owner/repo>:<sha256(email)>`, separate from public metadata
under `repo-request:`, counts under `repo-nominations:`, and completion under
`repo-ready:`. Notification receipts use `repo-notified:`, forks use
`repo-fork:`, and claims use `repo-claim:`. There are no additional database
bindings or migrations.

## Validation and deployment

Run `pnpm -C apps/bug-worker test` and `pnpm -C apps/site build`. Deploy the
Worker before the site; otherwise the new form gets a visible API error and
the most nominated list stays hidden. `alchemy.run.ts` is an Alchemy 2 stack
(`import * as Alchemy from "alchemy"` and `alchemy/Cloudflare`), matching the
`alchemy` version the workspace installs; deploy with
`BUG_ADMIN_TOKEN=... pnpm -C apps/bug-worker deploy`. Deployment needs the
email bindings above, `GITHUB_FORK_TOKEN` for community forks, and the
ten-minute cron.
