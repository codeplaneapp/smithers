# Documentation sources for `@smthrs/create-app`

Every sentence about this package lives inside the package: JSDoc in `src/`,
the prose in this directory, and the `description` field of `package.json`.
Nothing under `docs/pages` is written for this package at all.

That is one step short of the shape `packages/smithers/flows/canonical` and `packages/smithers/flows/crypto`
landed, and this file says so rather than implying otherwise. There, a
`Smithers.Generate` target projects the page out of the JSDoc, so a claim in the
page cannot drift from the code. Here the files below are written and reviewed
by hand: `@smthrs/create-app` is private at 1.0.0-rc.0 and owns no page under
`docs/pages`, so there is nothing yet to generate into.

What holds them to the code meanwhile is `test/docsParity.test.ts`, which fails
when `api.md` names a subpath the package does not serve, a constructor it does
not export, or a `smithers-routes` flag the bin's own usage text does not
document. It cannot check that a paragraph is true; a reviewer does that.

When the package publishes, follow the shape `packages/smithers/flows/crypto` landed:

1. Add `Package.ts` exporting the api source, its target page, the snippet
   fragments and the pages that must keep pointing at `/api/create-app`.
2. Add `scripts/docs.mjs`, which parses the `src/index.ts` barrel's module
   JSDoc, collects every export carrying an `@category` tag into a summary
   table, writes `docs/pages/api/create-app.md` whole from `docs/api.md`, and
   supports `--check` for drift.
3. Declare a `Smithers.Generate` target in `PACKAGE.ts` beside the
   `StandardPackage` destructure, listing `Package.ts`, `src/**/*.ts`,
   `docs/*.md` and `package.json` as data and the page paths as changes. The
   `run` verb writes, the `lint` verb drift-checks, and the workspace `ci` step
   already runs the lint form.
4. Add the sidebar entry in `docs/sidebar.ts`. Nothing registers the generator
   with `pnpm -C apps/site check:docs`: that gate discovers every
   `packages/*/scripts/docs.mjs` on disk and runs it with `--check`.

## Files

| File         | What it is                                                       |
| ------------ | ---------------------------------------------------------------- |
| `api.md`     | The body of the future `/api/create-app` page                    |
| `routing.md` | The routing grammar, as a fragment a shared page can also inject |
