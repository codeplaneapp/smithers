# smithers-build CLI

`smithers-build` executes target graphs. A verb selects a set of targets by
label or pattern, the CLI plans them, consults a content-addressed cache, and
runs whatever is missing. Targets declare inputs, outputs, and permissions;
they never contain per-command scripts.

```sh
smithers-build install --workspace /path/to/smithers
smithers-build build //packages/...
smithers-build test //packages/smithers/flows/flow:test
smithers-build lint //packages/smithers/flows/flow:lint
smithers-build query 'deps(//packages/smithers/flows/flow:lib)'
smithers-build graph //packages/... --mermaid
smithers-build //packages/smithers/flows/flow:lint          # the bare-label form
```

Verbs execute by default. `--plan` prints the inert plan instead, `--no-cache`
bypasses cache reads, and `--jobs` bounds concurrency. `install` runs the
install Flow under the declared package manager.

Two authoring surfaces are supported and discovery picks between them: a
workspace of `PACKAGE.ts` modules, or the routed `WORKSPACE.ts` plus one
`PACKAGE.ts` per package. Both go through the same planner, the same cache, and
the same execution boundary.

This package is private. It is the implementation behind the `smithers-build`
binary, not a library anyone installs.

## Documentation

Prose lives beside the code it describes, in [`docs/`](./docs/README.md):

- [Commands](./docs/cli.md) — every command, argument, and option.
- [Build system](./docs/build-system.md) — `WORKSPACE.ts` and `PACKAGE.ts`
  discovery, the verbs it supports, and what it refuses.
- [Caching](./docs/caching.md) — the cache directory, the content-addressed
  store, and the remote cache's endpoint, credentials, and trust domain.
- [Execution](./docs/execution.md) — write-set confinement and rollback,
  sandboxing and where it is enforced, services, and the resource ceilings.

The API reference is the JSDoc on the exported declarations in `src/`; the
package's lint configuration requires a description, a `@category`, and a
`@since` on each one.
