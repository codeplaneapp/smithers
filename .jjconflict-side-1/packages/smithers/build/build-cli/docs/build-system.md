# Build system

The CLI loads `.smithers/WORKSPACE.ts` (or the root `WORKSPACE.ts`) and the
workspace's `PACKAGE.ts` modules. The workspace declaration names shared
services such as runtimes, package managers, toolchains, and caching. Each
package exports exactly one `S.Package({ targets })` value, selected through
Bazel-style labels.

## What build system supports

`query`, `graph`, `build`, `test`, `lint`, `run`, and the bare-label form
(`smithers-build //pkg:target`, or `target //pkg:target`).

Every verb resolves targets from this same index. A verb that cannot execute a
particular target reports the unsupported rule instead of returning a false
green result.

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
