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

2. **Start from the canonical workflow.** The checked-in
   [`.github/workflows/pr-review.yml`](../../.github/workflows/pr-review.yml)
   dogfoods the action in this repository. Downstream repositories must pin
   the Smithers action/publisher source to an immutable released commit rather
   than reusing this repository's base-SHA checkout literally. Its three jobs
   are a security boundary, not boilerplate:

   - `policy` reads only GitHub's event payload and classifies credential trust;
   - `analyze` has read-only repository authority plus OIDC, checks out the PR
     without persisted credentials, and uploads an untrusted JSON result;
   - `publish` never checks out PR content and is the only job with
     `pull-requests: write`; it validates repository, PR, head SHA, schema,
     changed-file paths, and size before posting.

Keep the workflow on base-controlled `pull_request_target` and
`issue_comment`. The target checkout is safe only because the analysis job is
read-only, credentials are not persisted, and publication is isolated; do not
collapse those jobs or pass `github.token` to the analysis CLI. Fork and
same-repository changes both use the metered/OIDC path.

3. **Trigger a review.** Comment on any PR:

```
@smithers review
```

Only owners, members, and collaborators can trigger reviews. Repos registered
in `auto` mode review non-draft same-repository PRs and trusted-collaborator
forks on each diff update. Other forks still require the maintainer comment so
an external actor cannot consume repository review quota. `comment` mode is the
default. The mode is a server-side setting on your registration, so switching
never touches your workflow file.

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
your registration; the action log shows remaining quota.
Re-reviewing a PR that already counted this month is free. When the quota
is spent, the action skips with a notice instead of failing your checks.

### Subscription credentials are local-only

The PR workflow intentionally never references personal subscription
credentials. A same-repository PR can change a `pull_request` workflow before
any runtime gate executes, so storing `CODEX_AUTH_JSON` or
`CLAUDE_CODE_OAUTH_TOKEN` as repository secrets would make them reachable from
untrusted workflow edits. Remove legacy copies if this workflow was previously
configured with them:

```sh
gh secret delete CODEX_AUTH_JSON
gh secret delete CLAUDE_CODE_OAUTH_TOKEN
```

The terminal CLI can still use a locally logged-in provider because local code
and credentials share one explicit trust boundary. CI always uses the
short-lived, repository-scoped metered/OIDC session. The trusted action keeps
that real token in memory behind a random-key loopback broker, then launches the
CLI and all review agents under a distinct unprivileged OS user with an empty,
explicitly rebuilt environment. Agents run non-yolo with read-only
filesystem/tool policies and never inherit the publisher token, GitHub token,
OIDC request token, real inference token, or the job's general environment.

## Run it from the terminal

The CLI runs through the main Smithers binary against any repo on your machine.
It prefers your logged-in Codex CLI (Sol for review/verification, Luna for
narration/quiz) and falls back to Claude when Codex is unavailable. Run
`codex login` for the default path; the fallback accepts a logged-in `claude`
CLI, a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or an
`ANTHROPIC_API_KEY`:

```sh
bunx smithers-orchestrator review --help
```

```sh
# review the working tree of a repo, write .smithers-review/walkthrough.html
bunx smithers-orchestrator review /path/to/repo

# review a branch against main, open the walkthrough when done
bunx smithers-orchestrator review /path/to/repo --from main --to HEAD --open

# review one commit
bunx smithers-orchestrator review /path/to/repo --commit abc1234

# review GitHub PR #123 and post the review onto it (via gh)
bunx smithers-orchestrator review /path/to/repo --pr 123

# publish the walkthrough to the share service and print an unlisted URL
bunx smithers-orchestrator review /path/to/repo --pr 123 --publish

# no agents: deterministic story, no review findings (works offline)
bunx smithers-orchestrator review /path/to/repo --no-review --no-narrate
```

The standalone package bin, `smithers-review`, accepts the same options and
remains useful for package-level testing in this monorepo.

The repo path defaults to the current directory. Run `bunx smithers-orchestrator review --help` for all
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
