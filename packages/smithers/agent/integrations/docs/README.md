# Package-owned documentation

Every published sentence about `@smthrs/integrations` has one source, and it is
inside this package.

- **JSDoc in `src/`** is the API reference. `scripts/docs.mjs` reads the
  barrels, walks the modules they re-export, and builds the export table from
  the exports carrying an `@category` tag.
- **`docs/api.md`** is the prose body of the published API page: what the
  package is, the shape of an integration, and the properties each part
  guarantees.
- **`package.json` `description`** is the page's frontmatter description. The
  generator quotes it and adds the sentence-ending period the manifest field
  does not carry.

`docs/pages/api/integrations.md` in the repository root is a generated output.
Editing it by hand is how the same claim ended up in two files and then stopped
being true in one of them: three of this package's headline promises were
printed in both the README and that page while the code did neither.

The package `README.md` is still written by hand, which is the shape the
canonical and crypto pilots landed with. It is deliberately a shorter, orienting
document rather than a second copy of `api.md`: a claim that belongs to the API
contract goes in `api.md` and reaches the site from there.

## Running it

From the repository root:

```sh
node packages/smithers/agent/integrations/scripts/docs.mjs           # write the pages
node packages/smithers/agent/integrations/scripts/docs.mjs --check   # report drift, exit 1
```

`PACKAGE.ts` declares the same two forms as a `Smithers.Generate` target, so
`smithers-build run` writes and `smithers-build lint` drift-checks, and the
workspace `ci` step runs the lint form.

## The rules the generator enforces

- `docs/Manifest.ts` and `package.json` must agree on the package name.
- Every module the barrels re-export must parse, and at least one export must
  carry an `@category`. An export with no category is silently absent from the
  table, which is the one failure mode worth knowing about.
- Generated content carries no em-dash.
- Every page in `Package.references` must still mention the package and link to
  `/api/integrations`, so a reference cannot quietly become a restatement.
