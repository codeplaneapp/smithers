File location is the only thing that names anything in a Smithers app. The
router walks the app root once and derives every route, every pane name, and
every flow's three layers from where a file sits.

## What each location means

- `<app>/layout.tsx` is the shell layout, and it is optional. Only the app
  root's `layout.tsx` is a shell layout: a nested one is an ordinary file the
  router ignores.
- `<app>/**/page.tsx` is the page at `/<dir>`, and `<app>/page.tsx` is `/`.
- `<app>/panes/<name>.tsx` is the pane `<name>`, and only at that exact depth.
  A file deeper than that falls through to the page rule, so
  `<app>/panes/deep/page.tsx` is the page `/panes/deep` rather than a pane
  called `page`.
- `<flows>/**/flow.ts` or `flow.mdx` is the flow named by its directory, so
  `flows/build/plan/flow.ts` is the flow `build/plan`.
- `AGENT.ts`, `SANDBOX.ts`, and `TOOLS.ts` are layers for every flow in their
  directory and below.

## The name grammar

A pane name, every directory segment of a page route, and every directory
segment of a flow id must match `/^[a-z][a-z0-9-]*$/`. A file that does not is
refused with the router's `invalid_name` code, naming the file.

The grammar applies to page segments as well as to panes and flows because
every segment reaches the generated module. Unvalidated, `app/v1.2/page.tsx`
was accepted, and any character at all in a directory name reached an import
specifier.

## Layer resolution

Each layer kind resolves to its nearest ancestor of that kind, and nothing
merges. `flows/build/AGENT.ts` moves the build flows to another seat and leaves
their sandbox and tools resolving to the root. The app root must provide all
three, which is what makes resolution terminate; a flow with no ancestor of
some kind is refused with `missing_layer`.

Both the app root and the directory being resolved are normalized before the
ancestor walk, and the directory must sit inside the root. Without that the
walk had no stopping condition: it compared raw strings, so a root carrying a
trailing separator, which shell tab completion appends, never matched, and
`dirname("/")` is `"/"`, so the walk spun forever instead of raising
`missing_layer`.

## Two files claiming one route

Two files that resolve to the same pane name, page route, or flow id are
refused with `duplicate_name`, naming both files.

## Symbolic links

Symbolic links are neither walked nor routed. The walk reads each directory
entry's own type rather than following it, so a checkout's dangling link, a
link pointing at an ancestor, and a link into a large external tree can none of
them fail, wedge, or inflate a route generation.
