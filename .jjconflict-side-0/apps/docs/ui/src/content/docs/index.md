---
title: "@smthrs/ui"
description: "Shared shadcn-anatomy component library for Smithers UIs. Radix primitives + CVA variant APIs styled with the ui-styleguide theme tokens, shipped as CSS-in-TS strings so components bundle through the gateway's Bun.build and follow light/dark (prefers-color-scheme and data-theme) with zero configuration."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/ui/docs/README.md"
---

Every published sentence about this package has exactly one source, and that
source lives inside the package:

- **API surface and behavior** — JSDoc on the exported symbol in `src/`. The
  wildcard-free `exports` map in `package.json` is the public API; anything
  reachable only through a relative path carries no promise.
- **Package narrative** — `../README.md`, the single entry point. It links here
  rather than restating anything.
- **Layering and file layout** — [`architecture.md`](/architecture/).
- **Failure codes and resource limits** — [`contracts.md`](/contracts/).
- **Release history** — `../CHANGELOG.md`.

`tests/docs-links.test.ts` is the gate over these files: every relative link
here has to resolve, and nothing in the package may name the unscoped
`smthrs` specifier.

There is no page for this package under `docs/pages`, and there is no docs
generator target in `PACKAGE.ts`. `@smthrs/ui` is `private: true` and has no
registry consumer, so publishing an API page for it on the documentation site
would describe a package nobody can install. If the package becomes public,
add the generator following the
`packages/smithers/flows/crypto` recipe (`Package.ts` + `scripts/docs.mjs` + a
`Smithers.Generate` target; `scripts/check-docs.mjs` discovers the generator on
disk and needs no line of its own) and this note goes away.

`src/README.md` used to hold a second copy of the layering notes and drifted
from the root README independently. It is gone; `architecture.md` is the one
copy.
