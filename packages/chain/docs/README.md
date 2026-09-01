# Documentation owned by `@smthrs/chain`

Every published sentence about this package has one source inside the
package. There are three:

- **JSDoc in `src/`** — what each export is, what it promises, and why. The
  `@category` tag on an export is what makes it part of the documented
  surface.
- **`docs/` fragments** — the prose that does not belong to any single
  export: `api.md` (the guided tour of the nineteen namespaces) and
  `contract.md` (the governing design, the failure taxonomy, the resource
  limits, and the determinism and JSON-boundary rules every host inherits).
- **`package.json` "description"** — the one-line summary every index that
  lists the package quotes.

`@smthrs/chain` is private at 1.0.0-rc.0, so it publishes no page under
`docs/pages`. The repository's pages may summarize it in one line; they must
not restate the contract, because a second copy is a copy that drifts. A
reader who needs more than the one line comes here.

`test/Docs.test.ts` is the drift gate: it fails when a namespace exported
from `src/index.ts` is missing from `api.md`, when `contract.md` states a
default that the source no longer carries, or when the package README stops
pointing at these files.
