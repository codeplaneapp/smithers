# smithers review

Agent code review that reads like a story.

`smithers review` runs one review agent per changed file, then a narrator
agent writes a walkthrough of the whole change: chapters in logical reading
order, prose explaining why each group of files changed, diffs embedded at
the right point in the narrative, and Mermaid diagrams wherever structure
changed. The output is a single self-contained HTML file you can open,
share, or publish to a hosted URL.

Pointed at a GitHub pull request, it also posts the review onto the PR: the
narrative summary as the review body, and every finding as an inline comment
with a ` ```suggestion ` block when there is replacement code to apply.

Findings never fail the build. smithers review reports; humans decide.

## Add it to your repo

One workflow file. No secrets, no Anthropic account, no smithers checkout.
The service authenticates your repo through GitHub OIDC, runs the agents on
our metered inference, posts the review, and hosts the walkthrough.

1. **Register your repo.** v0 accounts are operator-issued while billing is
   built out (early repos are subsidized). Open an issue titled
   `review access: <org>/<repo>` on
   [smithersai/smithers](https://github.com/smithersai/smithers/issues) or
   contact the maintainers.

2. **Add `.github/workflows/smithers-review.yml`:**

```yaml
name: smithers review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  id-token: write       # proves your repo's identity to the review service
  contents: read        # check out the PR
  pull-requests: write  # post the review

concurrency:
  group: smithers-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: smithersai/smithers/apps/review/action@main
```

Keep the workflow on `pull_request`. Never switch it to
`pull_request_target`: the review agents execute the PR's code, and
`pull_request_target` would hand that code elevated credentials.

3. **Trigger a review.** Comment on any PR:

```
@smithers review
```

Only owners, members, and collaborators can trigger reviews. Repos
registered in `auto` mode skip the comment and review every non-draft PR
push; `comment` mode is the default. The mode is a server-side setting on
your registration, so switching never touches your workflow file.

### Reviewer quiz

High-impact changes get a short comprehension quiz: 3–6 multiple-choice
questions a reviewer can answer only if they actually read and understood
the change. It is honor-system — nothing blocks a merge on the score.

The quiz auto-triggers when the assessed impact is **high** or
**critical** (security-sensitive paths, schema/migration changes, risky
added code, critical findings, sheer size, …); the specific reasons behind
the assessment are listed in the walkthrough. Force it with `--quiz on`,
disable it with `--quiz off` (CLI), or set the `quiz:` action input.

After taking the quiz in the walkthrough, copy the attestation (your
score) into a PR comment so the author knows the review was earned.

### Plans and quota

Subscriptions meter reviewed PRs — a monthly per-repo PR allotment set on
your registration; the status comment shows remaining quota.
Re-reviewing a PR that already counted this month is free. When the quota
is spent, the action skips with a notice instead of failing your checks.

### Use your own subscription (optional)

If you own the repo and have a Claude or ChatGPT subscription, the review
agents can run on your subscription instead of the service's metered
inference. Repo registration, quota counting, and walkthrough hosting work
exactly as before; only the inference moves to your seat, so your metered
spend on the service stays zero.

**ChatGPT (Codex) — recommended.** Log in once on any machine and copy the
credential into a repo secret:

```sh
codex login                      # opens the ChatGPT device-auth flow
gh secret set CODEX_AUTH_JSON < ~/.codex/auth.json
```

Then pass it through in the job:

```yaml
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
    steps:
      - uses: smithersai/smithers/apps/review/action@main
```

**Claude.** Mint a token with `claude setup-token` and set it as the
`CLAUDE_CODE_OAUTH_TOKEN` repo secret, passed through the same way. The
action prefers Codex when both secrets are present.

Use this only for repos you own. A personal subscription must not serve
other people's repos: both providers' consumer terms forbid backing a
multi-tenant service from one seat. For that, fund the platform API key.

## Run it from the terminal

The CLI runs through the main Smithers binary against any repo on your machine.
It prefers your logged-in Codex CLI (Sol for review/verification, Luna for
narration/quiz) and falls back to Claude when Codex is unavailable. Run
`codex login` for the default path; the fallback accepts a logged-in `claude`
CLI, a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or an
`ANTHROPIC_API_KEY`:

```sh
bunx smthrs review --help
```

```sh
# review the working tree of a repo, write .smithers-review/walkthrough.html
bunx smthrs review /path/to/repo

# review a branch against main, open the walkthrough when done
bunx smthrs review /path/to/repo --from main --to HEAD --open

# review one commit
bunx smthrs review /path/to/repo --commit abc1234

# review GitHub PR #123 and post the review onto it (via gh)
bunx smthrs review /path/to/repo --pr 123

# publish the walkthrough to the share service and print an unlisted URL
bunx smthrs review /path/to/repo --pr 123 --publish

# no agents: deterministic story, no review findings (works offline)
bunx smthrs review /path/to/repo --no-review --no-narrate
```

The standalone package bin, `smithers-review`, accepts the same options and
remains useful for package-level testing in this monorepo.

The repo path defaults to the current directory. Run `bunx smthrs review --help` for all
options. `--publish` needs a publish service URL in
`SMITHERS_REVIEW_PUBLISH_URL` and an API key (`srk_…`, operator-issued) in
`SMITHERS_REVIEW_PUBLISH_TOKEN`; both can also be set in
`~/.smithers-review.json`.

## The service

The hosted side is a Cloudflare Worker at `https://review.jjhub.tech`:
session minting from GitHub OIDC tokens, an Anthropic-compatible metered
inference proxy, walkthrough hosting on R2, usage accounting in D1, and a
Prometheus `/metrics` endpoint feeding Grafana Cloud spend dashboards.
Design: `.smithers/specs/smithers-review-cloud.md`.

Not built yet, tracked as issues: Stripe subscriptions, self-serve signup
and key management, the `review.smithers.sh` domain.

## Contributing

Architecture, the publish service, self-hosted CI setup with your own
credentials, diff rendering exports, and the test suites are documented in
[CONTRIBUTING.md](CONTRIBUTING.md).
