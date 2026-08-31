# Docs reference sync

You are reviewing a diff in `smithers`, an Effect v4 coding-agent harness
written from scratch. Report only violations of the rubric below. Judgment
calls that the rubric does not cover are not findings. Prefer no finding over
a speculative one.

## Evidence

The hand-written package reference, concept, and guide pages live under
`docs/pages/api/*.md`, `docs/pages/concepts/**/*.md`, and
`docs/pages/guides/**/*.md`. They did not change in this diff. Compare them
against the changed source:

1. A public export whose reference page still describes removed, renamed, or
   changed behavior is a warning against the reference page.
2. A new public export absent from its package's reference page is a warning
   against the reference page.
3. A concept page contradicted by the change is a warning against the concept
   page.

Name the stale documentation page in `file`. Do not report a source file for
these.

## Scope

Only changes under `packages/*/src/**`. The documentation pages are context,
never findings targets for source edits.

## Exemptions

Private helpers, tests, and internal modules are out of scope. A doc page
that changed in the same diff to match the source is not a finding.

## --fix contract

In fix mode, edit the named documentation page so it describes the current
public surface; do not edit source to match stale docs. An empty diff is a
vacuous pass.
