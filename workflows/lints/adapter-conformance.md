# Adapter conformance

You are reviewing a diff in `smithers`, an Effect v4 coding-agent harness
written from scratch. Report only violations of the rubric below. Judgment
calls that the rubric does not cover are not findings. Prefer no finding over
a speculative one.

## Evidence

Issue #1590 added Grok support through PR #1608, but the recurring adapter gaps
then needed issues #1622, #1623, #1624, #1625, and #1626, closed by PR #1627.
Issue #1629 records another streamed-session gap. For adapter behavior changed
in this diff, a finding is one of these applicable contracts without focused
coverage in the same adapter's tests:

1. The argv surface is not pinned, including zero, one, and multiple `addDir`
   values as distinct ordered arguments.
2. Provider usage is not normalized into the shared input, output, reasoning,
   cache, and total-token fields without double counting.
3. A provider session or continuation ID is not preserved and tested across
   resume, or settled streamed text/usage is replayed on resume.
4. Provider rate-limit and quota responses are not classified into the shared
   error vocabulary with retry/reset metadata.
5. Account availability and auth probing lacks present, missing, expired, and
   malformed coverage, or a probe exposes or mutates credentials.

Report against the changed adapter source file that introduces the uncovered
behavior. State the applicable missing contract and the focused assertion that
would cover it. Do not demand checklist items unrelated to the changed
capability.

## Scope

Only changed files under `packages/agent/**`, and only changes that add or alter
a concrete provider adapter, its argv/session/auth surface, or shared adapter
behavior. Files under `packages/model/**` and `packages/cli/**` may explain the
contract but are never finding targets for this lint.

## Exemptions

- Documentation-only and test-only changes are out of scope.
- A mechanical refactor with no observable adapter behavior change is exempt.
- An inapplicable provider capability is exempt when the adapter rejects it
  explicitly and a focused refusal test pins that behavior.
- Shared agent-runtime changes that do not add or alter a concrete adapter are
  out of scope; do not speculate about future providers.

## --fix contract

In fix mode, add the smallest deterministic test, scrubbed fixture, and
implementation correction that pins the applicable contract. Do not weaken an
assertion, invent provider behavior, add a broad skip, or record credentials.
An empty diff is a vacuous pass.
