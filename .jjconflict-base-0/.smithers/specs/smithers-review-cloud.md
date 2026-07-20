# smithers review cloud: hosted PR reviews, one workflow file, zero secrets

`apps/review` already reviews PRs from CI, but only for this repo: the
workflow runs from the monorepo checkout and brings its own agent
credentials. Codex is the preferred engine whenever it is usable; Claude is
kept as the unavailable-Codex fallback. smithers review cloud turns it into a product. A user adds one
GitHub Actions workflow file to their repo. No secrets, no Anthropic account,
no smithers checkout. The service authenticates the repo, runs the agents
through our metered inference proxy, posts the review, and hosts the
walkthrough.

## Product shape

- **Setup**: copy one workflow file that uses the composite action
  `smithersai/smithers/apps/review/action@main`. The only permissions it
  needs are `id-token: write`, `contents: read`, `pull-requests: write`.
- **Plans**: subscriptions are quota-based, N reviewed PRs per repo per
  calendar month. Re-reviews of an already-counted PR in the same month are
  free. v0 has no payment flow; the operator registers subsidized repos by
  hand and Stripe billing is a tracked issue.
- **Modes**: each registered repo is `auto` (review every non-draft PR push)
  or `comment` (review only when a collaborator comments the magic phrase
  on the PR). `comment` is the default. The mode lives server-side so
  changing it never requires editing the user's workflow.
- **Magic phrase**: a PR comment starting with `@smithers review`. Only
  comments whose author association is OWNER, MEMBER, or COLLABORATOR
  trigger a review.
- **Accounts and keys**: v0 is operator-issued. The operator registers repos
  and mints API keys with admin endpoints. API keys (`srk_` prefix) exist
  for CLI and local use; GitHub Actions never needs one because OIDC proves
  repo identity. Self-serve signup is a tracked issue.

## Architecture

Three pieces: a composite GitHub Action, the service (the existing
Cloudflare Worker grown an identity, proxy, and metering plane), and the
observability path into Grafana Cloud.

```
user repo workflow ──uses──▶ composite action (in this repo)
        │                          │ 1. OIDC token from GitHub
        │                          │ 2. POST /api/sessions ──▶ service: verify JWT,
        │                          │      look up repo, check quota, mint session
        │                          │ 3. run smithers review --pr N with
        │                          │      ANTHROPIC_BASE_URL=<service>/anthropic
        │                          │      ANTHROPIC_API_KEY=<session token>
        │                          ▼
        │                    service /anthropic/v1/* ──▶ api.anthropic.com
        │                          │  (inject real key, stream, meter tokens)
        ▼                          ▼
   review posted on PR       D1 usage rows ──▶ GET /metrics ──▶ Grafana Cloud
```

### Composite action (`apps/review/action/action.yml`)

A composite action referenced as `smithersai/smithers/apps/review/action@main`.
GitHub materializes the whole repo at the action path, so the action installs
its own toolchain (bun, pnpm install at the action checkout) and runs the CLI
from there. The user's workflow checks out only the user's repo.

Steps, in order:

1. **Gate the event.** `pull_request`: skip drafts and forks. `issue_comment`:
   require a PR comment starting with `@smithers review` from an author whose
   association is OWNER, MEMBER, or COLLABORATOR; resolve the PR head and
   check it out. Anything else: neutral skip with a notice.
2. **Authenticate.** Request the GitHub OIDC token
   (audience `smithers-review`), POST it to `/api/sessions`. The reply
   carries the session token, the repo's mode, and quota state.
3. **Apply the mode.** `pull_request` event on a `comment`-mode repo: neutral
   skip with a notice naming the magic phrase. `issue_comment` trigger works
   on both modes.
4. **Review.** Run `bun <action>/../src/cli/main.ts <workspace> --pr <n>
   --publish`. If `CODEX_AUTH_JSON` is present, materialize an isolated
   `$CODEX_HOME/auth.json`, install Codex, and select the Codex engine. Codex
   uses GPT-5.6 Sol for review/verification and GPT-5.6 Luna for
   narration/quiz. Without usable Codex, use the caller's
   `CLAUDE_CODE_OAUTH_TOKEN` or point `ANTHROPIC_BASE_URL` and
   `ANTHROPIC_API_KEY` at the metered proxy session. In every mode,
   `SMITHERS_REVIEW_PUBLISH_URL`/`_TOKEN` point at the service with the same
   session token, and `GH_TOKEN` comes from the workflow's `github.token`.
   The review posts onto the PR exactly as the in-repo CI does today.
5. **Quota exceeded** (402 from `/api/sessions`): neutral skip plus a notice
   telling the user the monthly PR quota is spent.

Action inputs: `service-url` (default `https://review.jjhub.tech`). Nothing
else; everything behavioral is server-side.

**Bring your own subscription (the default for self-owned repos).** A repo
owned by a subscription holder can run the review agents on that
subscription instead of the metered proxy. Two engines:

- **Codex / ChatGPT (recommended).** The job carries a `CODEX_AUTH_JSON`
  secret holding the contents of `~/.codex/auth.json` from a local
  `codex login` (`auth_mode: "chatgpt"`, OAuth `tokens`, null
  `OPENAI_API_KEY`). The action writes it to `$CODEX_HOME/auth.json`,
  installs the `codex` CLI, sets `SMITHERS_REVIEW_ENGINE=codex`, and the
  review and verification stages run `CodexAgent` on `gpt-5.6-sol`; the
  narration and quiz stages run it on `gpt-5.6-luna` with explicit medium
  reasoning effort. ChatGPT's device flow makes this credential easy to mint
  off a CI box.
- **Claude / setup-token (fallback).** When Codex is unavailable, a
  `CLAUDE_CODE_OAUTH_TOKEN` secret (from `claude setup-token`) keeps the
  engine on Claude with no `ANTHROPIC_*` overrides, so `ClaudeCodeAgent` uses
  subscription auth.

In both cases the OIDC session is still minted, the PR still counts against
quota, and the walkthrough still publishes through the session token; only
inference leaves the proxy, so metered platform spend stays zero. This is
strictly for repos the subscription holder owns. A personal Claude or
ChatGPT subscription must not back the hosted service for third parties:
consumer terms on both providers forbid powering a multi-tenant service
from one personal seat. The funded platform API key is the only licensed
path for serving other people's repos.

Engine selection lives in `createReviewAgents`, keyed on
`SMITHERS_REVIEW_ENGINE` (`codex` | `claude`). With no explicit override it
selects Codex when the CLI is installed and authenticated, otherwise Claude.
The action prefers Codex when `CODEX_AUTH_JSON` is present (including when both
subscription secrets are present); Claude is selected only for a
`CLAUDE_CODE_OAUTH_TOKEN` fallback or the service's metered Anthropic proxy.

The README documents the two-trigger workflow template
(`pull_request` + `issue_comment`) that covers both modes. It must stay on
`pull_request`, never `pull_request_target`, because review agents execute
the PR's code.

### Service (Cloudflare Worker, `apps/review/src/server/`)

The worker keeps its existing routes (`GET /`, `GET /w/<id>`,
`POST /api/walkthroughs`) and gains:

- **`POST /api/sessions`** body `{ oidcToken }` or `{ apiKey }`.
  - OIDC path: verify signature against the GitHub Actions JWKS
    (`https://token.actions.githubusercontent.com/.well-known/jwks`, cached),
    check `aud=smithers-review`, `iss`, expiry, then read the `repository`
    claim. The claim must match a registered repo.
  - API-key path: hash and look up an operator-minted key; the key's owner
    must be authorized for the repo named in the request.
  - Quota: count distinct `(repo, pr)` usage in the current calendar month;
    if the PR is new and the count is at the plan limit, 402.
  - Reply `{ token, expiresAt, mode, plan: { prsPerMonth, used },
    anthropicBaseUrl, publishUrl }`. Session tokens are random 256-bit
    values stored hashed in D1 with TTL 2 hours, scoped to repo + PR, with a
    per-session spend cap (USD, plan-configured) as a runaway brake.
- **`POST|GET /anthropic/v1/*`** Anthropic-compatible proxy. Auth: session
  token or API key as the `x-api-key`/`authorization` value. The worker
  swaps in the real `ANTHROPIC_API_KEY` secret, forwards to
  `api.anthropic.com`, streams the response through, and parses usage
  (`input_tokens`, `output_tokens`, model) from message_start/message_delta
  frames (SSE) or the response body (non-streaming). Each call appends a
  usage row. Over-cap sessions get 402.
- **`GET /metrics`** Prometheus text exposition, Bearer `METRICS_TOKEN`.
  Gauges/counters aggregated from D1: `review_tokens_total{repo,model,kind}`,
  `review_spend_usd_total{repo,model}`, `review_prs_reviewed_total{repo}`,
  `review_quota_remaining{repo}`, `review_proxy_errors_total{repo,status}`,
  `review_sessions_total{repo,result}`. Designed for Grafana Cloud's
  Metrics Endpoint scrape.
- **Admin, Bearer `ADMIN_TOKEN`:**
  - `POST /api/admin/repos` `{ repo, mode, prsPerMonth, spendCapUsd }`
    upsert a registration.
  - `GET /api/admin/repos` list registrations with month-to-date usage.
  - `POST /api/admin/keys` `{ owner, repos }` mint an `srk_` API key
    (returned once, stored hashed).
  - `GET /api/admin/usage` usage summary by repo/model/day.
- **`POST /api/walkthroughs`** additionally accepts session tokens and API
  keys; the legacy `REVIEW_PUBLISH_TOKEN` keeps working.

Storage: a D1 database (Alchemy-provisioned, like the existing R2 bucket)
with tables `repos`, `api_keys`, `sessions`, `usage_events`, `reviewed_prs`.
Token costs come from a small static price table per model, good enough for
spend dashboards; the invoice of record is Anthropic's.

Worker secrets: `ANTHROPIC_API_KEY` (funded; the one in the current shell
has no credits), `ADMIN_TOKEN`, `METRICS_TOKEN`, plus the existing
`REVIEW_PUBLISH_TOKEN`.

### CLI

No flag changes. The action selects Codex through `SMITHERS_REVIEW_ENGINE` and
an isolated `CODEX_HOME` whenever usable; the Claude fallback honors
`ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` for the metered proxy.
`createReviewAgents` defaults to Codex when it is installed and authenticated:
GPT-5.6 Sol for review and verdict verification, GPT-5.6 Luna for narration and
quiz generation. Claude remains the unavailable-Codex fallback. When both
Anthropic proxy variables are set, build that Claude fallback in API-key mode
instead of subscription mode so zero-secret hosted CI runs under the proxy
deterministically.

## Observability (Grafana Cloud)

Two feeds, one dashboard:

1. **Billing truth**: Grafana Cloud's Metrics Endpoint integration scrapes
   `GET /metrics` with the bearer token. This is the per-repo spend, quota,
   and error view, and the alert source (daily spend threshold).
2. **Run-level traces** (optional, later): engine runs export OTLP when
   `SMITHERS_OTEL_ENABLED=1` and `OTEL_EXPORTER_OTLP_ENDPOINT` point at the
   Grafana Cloud OTLP gateway. The native `smithers observability` compose
   stack stays the local-dev path.

Operator setup (cannot be automated from here): create the free Grafana
Cloud stack, add the Metrics Endpoint scrape against
`https://review.jjhub.tech/metrics` with the `METRICS_TOKEN`, import the
spend dashboard (panels: spend by repo/day, tokens by model, PRs reviewed vs
quota, proxy error rate).

## Security

- OIDC verification pins issuer, audience, expiry, and signature; the
  repository claim is the identity. Nothing in the user repo is a secret.
- Comment-triggered runs execute PR code. The collaborator-association gate
  on the magic comment is what stands between a drive-by fork PR and our
  inference spend; sessions are additionally PR-scoped and spend-capped.
- Session tokens and API keys are stored hashed (SHA-256), compared in
  constant time, and never logged.
- The proxy forwards only `api.anthropic.com` paths under `/v1/`; it is not
  a general egress.

## v0 cut list (tracked as issues, not built now)

- Stripe subscriptions and a pricing page (operator subsidizes v0).
- Self-serve signup/dashboard with GitHub OAuth key management.
- `review.smithers.sh` custom domain (blocked on Cloudflare zone perms and
  an expired Vercel token; service stays on review.jjhub.tech).
- OTLP trace export from action runs into Grafana Cloud.

## Rollout

1. Worker v2 + D1 + tests, deployed to review.jjhub.tech.
2. Composite action + workflow template; this repo dogfoods it by switching
   `.github/workflows/pr-review.yml` to the action (auto mode, registered
   first).
3. Grafana Cloud scrape + dashboard (operator step).
4. First subsidized users: operator registers their repos, they paste the
   workflow file.
