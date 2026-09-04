# Write a package reference page

You write one reference page for one published `@smthrs/*` package. Follow
`apps/site/prompts/reference-style.md` for voice, entry format, code, links,
and the truthfulness rule. This prompt fixes the inputs, the output, and the
section skeleton.

## Inputs

- The package's `src/**/*.ts`: the truth. `src/index.ts` names the public
  namespaces; each namespace module's exports and their JSDoc (`@since`,
  `@category`, `@deprecated`) are the entries.
- The package's `README.md` and `docs/*.md`: vocabulary and worked examples.
  Prefer them for wording; prefer the source for facts. Where they disagree
  with the source, the source wins.
- `apps/site/prompts/reference-style.md`.

The package name and version come from the package's `package.json` when it
is in the inputs; otherwise from the README's install line.

## Output

One file: the path in your write-set, `docs/reference/<slug>.md` inside the
package. Frontmatter:

```md
---
title: "@smthrs/<name>"
description: "What @smthrs/<name> exports: <the namespaces>, with types and defaults from source."
area: api
order: <10 for @smthrs/flow, 20 for @smthrs/engine, 30 for @smthrs/targets, 100 otherwise>
---
```

## Skeleton

Sections in this order, no others:

1. Install: one `bash` fence with the `pnpm add` line from the README,
   including the exact `effect` pin when the README states one.
2. `## Entry points`: a table of `Import`, `Source`, and `Platform` rows, one
   per subpath the package's `exports` map or README table lists.
3. `## Namespaces`: a table with `Namespace` and `Summary` rows, one per
   `export * as` in `src/index.ts`, in the order the index declares them.
   The summary is the index file's own JSDoc sentence.
4. One `## <Namespace>` section per namespace, in index order. Under it, one
   `### \`Namespace.member\`` entry per public export of that module, in
   source order, using the entry format from the style rubric. A type-only
   export gets a `Type` row; a function gets a `Signature` row copied from
   the definition. Group nothing; skip nothing that the module exports
   without `@internal`. A namespace with more than 40 exports may list the
   models and schemas in one table (`Name`, `Kind`, `Summary`) and give
   headings only to constructors, combinators, layers, and errors; say so in
   one sentence at the top of the section.
5. `## Errors`: a table of every `TaggedError` or coded refusal the package
   defines, with `Tag`, `Raised when`, and `Fields` columns. Read the raise
   sites.
6. `## Example`: one `ts` fence, 15 to 40 lines, that imports from the
   package and compiles. Take it from the README or `docs/api.md` when one
   exists; adapt it only to compile. Introduce it with one sentence.
7. `## See also`: links to the sibling package pages this package depends on
   or is implemented by, using `/docs/reference/api/<slug>/`, and to the
   concept pages in the brief's route map that own the rationale.
8. `## Sources`: the workspace-relative paths you read.

## Verification before you finish

- Every `Namespace.member` heading matches an `export` in that module. Grep
  each one. Report the count in your final note: entries written, exports
  found, and any export you left out with the reason.
- Every `Signature` and `Type` row is copied from the definition. Effect
  schemas: write the schema constant's shape as the definition spells it
  (`Schema.Struct({...})` fields), not the decoded TypeScript type, unless
  the module exports the type alias too.
- Every `Since` row is the `@since` tag on that export.
- The `ts` example compiles under strict `tsc` with only the imports it
  names.
- No H1, no em dash, sentence-case headings, every fence tagged, every link
  absolute with a trailing slash.
