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

`GET /api/repo-requests` returns `{ repos, cursor }`. Each public record has
`name`, `url`, `status` (`smithering` or `ready`), and `appUrl` (null until ready).
Pass `?cursor=...` to get another page. The upcoming app can consume this same
public catalog and use ready entries as its supported repositories.

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

KV is eventually consistent. New requests and readiness may take up to a
minute to reach other locations; the page refreshes every 30 seconds. Records
and per-email subscriptions use separate keys so concurrent submissions
cannot overwrite a subscriber list or reset completed work. Provider keys
protect concurrent delivery retries for 24 hours; if a send succeeds but its
KV receipt cannot be saved for longer than that, a retry may send a duplicate.
The existing KV per-IP throttle is advisory, not an atomic rate limiter.

Email addresses never appear in public responses. They live under
`repo-subscriber:<owner/repo>:<sha256(email)>`, separate from public metadata
under `repo-request:` and completion under `repo-ready:`. Notification receipts
use `repo-notified:`. There are no additional database bindings or migrations.

## Validation and deployment

Run `pnpm -C apps/bug-worker test` and `pnpm -C apps/site build`. Deploy the
Worker before the site; otherwise the new form gets a visible API error.
Use the package's existing deployment command after resolving the repository's
Alchemy version mismatch: the checked-in deployment scripts use Alchemy 1.x
imports while the workspace currently installs 2.x. Deployment needs that
existing migration, the email bindings above, and the ten-minute cron.
