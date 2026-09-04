---
title: "Installation"
description: "Add @smthrs/errors as a workspace dependency, import it from the root entry point or a module subpath, and know why it is not on npm at 1.0.0-rc.0."
---

`@smthrs/errors` is a private workspace package. At `1.0.0-rc.0` it is not
published to npm, because `@smthrs/integrations` is its only consumer.

## Add the dependency

Inside this workspace, depend on it by protocol:

```json
{
  "dependencies": {
    "@smthrs/errors": "workspace:*"
  }
}
```

The package has no runtime dependencies. Its only requirement is Node.js
22.19.0 or later, declared in `engines`.

## Import it

The root entry point exports everything:

```ts
import {
  ERROR_REFERENCE_URL,
  getSmithersErrorDefinition,
  hasSmithersErrorShape,
  isSmithersError,
  isSmithersErrorCode,
  SmithersError,
  type SmithersErrorCode,
  smithersErrorCodes,
  type SmithersErrorDefinition,
  smithersErrorDefinitions,
  type SmithersErrorOptions
} from "@smthrs/errors"
```

Each of the two modules is also importable on its own, which is the form
`@smthrs/integrations` uses so a file pulls in only the module it names:

```ts
import { isSmithersErrorCode, smithersErrorDefinitions } from "@smthrs/errors/ErrorCode"
import { hasSmithersErrorShape, SmithersError } from "@smthrs/errors/SmithersError"
```

`@smthrs/errors/package.json` is exported. `@smthrs/errors/internal/*` and
`@smthrs/errors/*/index` are not: both resolve to `null` in the exports map, so
a deep import fails at resolution rather than compiling against a private path.

The published build ships ESM at `dist/esm` and CommonJS at `dist/cjs`, so a
`require` and an `import` both resolve. Inside the workspace, the `exports` map
points at `src/*.ts` and TypeScript reads the sources directly.

## Choose this package or a tagged error

Reach for `SmithersError` only when you are writing an integration adapter that
talks to a third-party API. Everywhere else in this workspace, state a failure
as a `Schema.TaggedError` class on the effect that can fail. There is no single
error registry, and [The closed code vocabulary](./concepts/error-codes.md)
explains the reasoning.

## Verify the install

```bash
pnpm --filter @smthrs/errors test
pnpm --filter @smthrs/errors check
pnpm --filter @smthrs/errors lint
```
