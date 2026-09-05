---
title: "Writing macros"
description: "Share target declarations with ordinary functions owned by your repository."
---

A macro is a function that creates targets and returns them in an object.
Use one when several packages repeat the same declarations. Start with explicit
targets so you can see which settings are actually shared.

## Define a test helper

```ts
// test-package.ts
import { Smithers as S } from "@smthrs/targets"

export const testPackage = ({ cwd }: { cwd: string }) => ({
  test: S.Vitest({
    tests: [S.glob("test/**/*.test.ts")],
    sources: [S.glob("src/**/*.ts")],
    deps: [],
    config: null,
    environment: "node",
    passWithNoTests: false,
    cwd
  })
})
```

Use it in a package declaration:

```ts
import { Smithers as S } from "@smthrs/targets"
import { testPackage } from "./test-package.ts"

export const Package = S.Package({
  targets: testPackage({ cwd: "packages/core" })
})
```

The `test` property becomes `//packages/core:test`. Calling `testPackage`
declares that target; `smthrs test //packages/core:test` runs it.

Keep the helper in your repository or a private workspace package. Name it for
what it declares, pass `cwd` to each target, and expose settings that callers
need to change. Review prompts, release rules, and company conventions belong
in that local configuration.

## Use a helper as a default

```ts
// Root PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"
import { testPackage } from "./test-package.ts"

export const packageDefaults = S.PackageDefaults({
  directories: "packages/*",
  macro: testPackage
})
```

Smithers supplies each matching directory as `cwd`. A directory with its own
`PACKAGE.ts` uses that declaration instead. See [Default targets](default-rules.md).

For a larger example, [build and check a package](../reference/targets/standard-package.md)
declares a build, tests, linting, formatting, and README checks. That helper is
also repository-owned example code.
