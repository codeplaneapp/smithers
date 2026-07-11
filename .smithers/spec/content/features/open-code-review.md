# Open code review

> **Status:** Partial | **Priority:** P1 | **Owner:** smithers-maintainers | **Group:** Ship & review

The open-code-review workflow and `apps/review` generate agent review findings, normalize diffs, render story-form HTML walkthroughs, and publish PR review artifacts for local or hosted review flows.

## What you can do

Run an agent review pass over a pull request and produce actionable findings plus a browsable walkthrough of the changes.

## Capabilities

### Review workflow

Seeded workflow invokes reviewers, verifies findings, and writes structured results.

### Diff assets

`apps/review` collects changed files, extracts diff assets, renders prose, charts, and per-file walkthrough HTML.

### Publishing service

Review publish tests cover local service paths and artifact output; cloud deployment remains separately gated.

## Endpoints and commands

- `CLI smithers review` ([docs](docs/cli/overview.mdx))
- `WORKFLOW open-code-review` ([docs](docs/workflows/review.mdx))

## Related docs

- [Review workflow](docs/workflows/review.mdx)

## Test cases

- `.smithers/tests/open-code-review.test.ts`
- `.smithers/tests/open-code-review-ui.e2e.test.ts`
- `apps/review/tests/reviewWorkflow.e2e.test.ts`
- `apps/review/tests/buildPullRequestReview.test.ts`
- `apps/review/tests/collectChanges.test.ts`
- `apps/review/tests/publishService.e2e.test.ts`
- `apps/review/tests/renderWalkthroughHtml.test.ts`
- `apps/review/tests/verifyFindings.test.ts`

## Observability

- Review outputs include structured findings and generated walkthrough artifacts that can be inspected from workflow `output/UI` state.
- Publish service e2e tests exercise the local artifact publication path.

## Debugging

- Run `apps/review` tests for `rendering/publishing` regressions and .smithers open-code-review tests for `workflow/UI` regressions.
- Use smithers review or workflow run review against a known diff before changing review prompts or finding verification.

## Architecture

- `apps/review` backs the review-specific artifact generation and publishing code.
- .`smithers workflows/tests` cover the Smithers workflow and UI wrapper around the review app.

## Fixes and diffs

- 2026-07-06 refresh: read README.md, package exports, selected package entry points, `docs/how-it-works.mdx`, `docs/cli/overview.mdx`, `docs/agents/overview.mdx`, `docs/integrations/custom-ui.mdx`, `docs/integrations/mcp-server.mdx`, `docs/deployment/production-hardening.mdx`, `docs/deployment/control-plane.mdx`, and targeted test inventories.
- `apps/review/src`
- `apps/review/tests`
- `.smithers/workflows/open-code-review.tsx`
- `.smithers/tests/open-code-review.test.ts`

## Open gaps

- `Hosted/cloud` review path is blocked on funded provider credentials and deployment-specific verification.
- Review quality still depends on live agent behavior; CI can prove structure and local paths but not every model-quality regression.
