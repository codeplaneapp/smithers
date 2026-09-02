# `@smthrs/ui` documentation

Every published sentence about this package has exactly one source, and that
source lives inside the package:

- **API surface and behavior** — JSDoc on the exported symbol in `src/`. The
  wildcard-free `exports` map in `package.json` is the public API; anything
  reachable only through a relative path carries no promise.
- **Package narrative** — `../README.md`, the single entry point. It links here
  rather than restating anything.
- **Layering and file layout** — [`architecture.md`](./architecture.md).
- **Failure codes and resource limits** — [`contracts.md`](./contracts.md).
- **Release history** — `../CHANGELOG.md`.

There is no page for this package under `docs/pages`, and there is no docs
generator target in `BUILD.ts`. `@smthrs/ui` is `private: true` at
`1.0.0-rc.0` (`docs/migration/disposition-ledger.md`, row `packages/ui`,
disposition `keep`): it has no registry consumer, so publishing an API page for
it on the documentation site would describe a package nobody can install. When
the Phase 4 UI port makes this package public, add the generator following the
`packages/crypto` recipe (`Package.ts` + `scripts/docs.mjs` + a
`Smithers.Generate` target + a `scripts/check-docs.mjs` line) and this note goes
away.

`src/README.md` used to hold a second copy of the layering notes and drifted
from the root README independently. It is gone; `architecture.md` is the one
copy.
