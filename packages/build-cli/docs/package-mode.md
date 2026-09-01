# Package mode

The CLI has two authoring surfaces. BUILD.ts is the original one: a workspace of
`BUILD.ts` modules exporting targets, selected by Bazel-style labels. PACKAGE.ts
is the routed one: a root `WORKSPACE.ts` naming the workspace, its cache, its
runtime, and its package manager, plus one `PACKAGE.ts` per package exporting
`S.Package({ targets })`.

Which mode a command runs in is discovery, not a flag. Every workspace command
first looks for a `WORKSPACE.ts` at or above the resolved workspace root. Found,
the command runs in package mode; absent, it falls back to BUILD.ts discovery.

## What package mode supports

`query`, `graph`, `build`, `test`, `lint`, `run`, and the bare-label form
(`smithers-build //pkg:target`, or `target //pkg:target`).

`install`, `ci`, and `docs` refuse in a package-mode workspace with a
`NotImplemented` message naming the surface that does work. The refusal is
deliberate: a verb that cannot execute a PACKAGE.ts target must not report
green.

## Discovery

Discovery asks git for tracked, non-ignored files and skips `node_modules` and
the resolved cache directory. Outside a git worktree it falls back to a walker
driven by the root `.gitignore` that skips the same paths. No path inside the
cache directory is ever listed, so cache contents cannot feed input discovery or
a digest.

An exact label loads one declaration module. A recursive pattern loads the
modules in the selected subtree. A direct import evaluates a dependency's module
through the normal ESM module graph.

## Repository targets

A `Repo.Target` names a target in a child workspace. Resolution asks the child
CLI for its inert plan. When the child cannot answer — the label does not exist
there, or the child refuses — the row carries a `refusal`, which both `query`
and `graph` render for a person and carry in the JSON envelope.
