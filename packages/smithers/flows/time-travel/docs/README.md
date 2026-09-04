# Package-owned documentation

Every published sentence about `@smthrs/time-travel` has exactly one source,
and that source lives inside this package:

| Source                               | What it feeds                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| module and export JSDoc in `../src/` | the summary paragraph and the `Exports` table of the API page                |
| `api.md`                             | the body of the API page: entry point, operations, failure behaviour, limits |
| `concepts.md`                        | the generated region of `docs/pages/concepts/time-travel.md`                 |
| `package.json` `description`         | the API page frontmatter                                                     |

`docs/pages/api/time-travel.md` is a generated output. Do not edit it, and do
not restate any of it in `../README.md`: the package README links to the
published page instead of copying it.

Regenerate and drift-check from the repository root:

```sh
node packages/smithers/flows/time-travel/scripts/docs.mjs
node packages/smithers/flows/time-travel/scripts/docs.mjs --check
```

`packages/smithers/flows/time-travel/PACKAGE.ts` declares the same script as a `Generate`
target, so `smithers-build run //packages/smithers/flows/time-travel:docsPages` writes the
pages and `smithers-build lint //packages/smithers/flows/time-travel:docsPages` fails on
drift. `pnpm -C apps/site check:docs` discovers this generator automatically.

The generator is not a formatter. It refuses to write when the documentation
disagrees with the code, so these are hard failures rather than silent
rewrites:

- an export carrying no `@category` never reaches the table, and a package with
  no documented export at all is an error;
- every `TimeTravelErrorCode` literal must appear in the failure-behaviour
  table of `api.md`, and every code named there must exist in
  `src/TimeTravelError.ts`;
- a page named in `Package.references` must still point at `/api/time-travel`;
- generated content may not contain an em-dash, which is the repository house
  style that `pnpm -C apps/site check:docs` enforces across the whole site.
