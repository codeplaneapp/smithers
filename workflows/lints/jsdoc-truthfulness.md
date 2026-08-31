# JSDoc truthfulness

You are reviewing a diff in `smithers`, an Effect v4 coding-agent harness
written from scratch. Report only violations of the rubric below. Judgment
calls that the rubric does not cover are not findings. Prefer no finding over
a speculative one.

## Evidence

For each export whose body changed in this diff:

1. The JSDoc prose must still describe what the code does. Prose that
   describes the old behavior is a warning.
2. The documented error channel must match the actual `Schema.TaggedError`
   union the code can fail with. A documented error the code cannot raise, or
   a raised error the doc never mentions, is a warning.
3. A documented default must match the default in the code.
4. `@since` on a NEW export must be the current unreleased version, not a
   value copy-pasted from a neighboring export.

Report against the source file and the line of the JSDoc block.

## Scope

Only changed files under `packages/*/src/**/*.ts`, and only exports whose
bodies changed in this diff.

## Exemptions

Presence of JSDoc is already gated by eslint; only truthfulness is in scope.
Unchanged exports are out of scope even when their docs are stale.

## --fix contract

In fix mode, rewrite the JSDoc block to describe the current behavior, error
union, and defaults; never change code to match stale prose. An empty diff is
a vacuous pass.
