# Documentation contract for `@smthrs/build-cli`

Every published sentence about this package has one source inside the package.

- **API reference** comes from the JSDoc on the exported declarations in
  `src/`. `eslint.jsdoc.js` requires a description, `@category`, and `@since`
  on every export, so the reference cannot drift from the code.
- **Behaviour prose** lives here, in `packages/build-cli/docs/`, one file per
  subject:
  - [`cli.md`](./cli.md) — every command, its arguments, and its options.
  - [`package-mode.md`](./package-mode.md) — PACKAGE.ts / WORKSPACE.ts
    discovery, which verbs it supports, and what it refuses.
  - [`caching.md`](./caching.md) — the cache directory, the content-addressed
    store, and the remote cache's endpoint and credentials.
  - [`execution.md`](./execution.md) — write-set confinement and its rollback
    semantics, sandboxing and where it is enforced, and the resource ceilings
    the artifact, fetch, service, and agent paths hold to.
- **The one-line summary** is `package.json`'s `description`.

`README.md` is the entry point and links here; it repeats no detail these files
own. The package's `docs` target (`Smithers.DocsParity` in `BUILD.ts`) keeps the
README present and substantive and re-keys the package when it changes.

This package is `private: true` and publishes nothing, so it has no page under
the repository's `docs/pages`. The colocation rule is the same either way: the
package owns its prose, and any shared page that describes it references this
directory rather than restating it.
