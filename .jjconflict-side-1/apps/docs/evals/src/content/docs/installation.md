---
title: "Installation"
description: "Add @smthrs/evals to a workspace package, plus its runtime requirements and entry points."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/evals/docs/installation.md"
---

`@smthrs/evals` is workspace-private at 1.0.0-rc.0: its `package.json` marks it
`"private": true`, so it is not published to npm and cannot be installed from
the registry. It is consumed from inside the smithers repository.

## Add it to a workspace package

Declare a workspace dependency, the same form `evals/agent` uses:

```json
{
  "dependencies": {
    "@smthrs/evals": "workspace:*"
  }
}
```

Then install:

```bash
pnpm install
```

## Runtime requirements

- Node.js 22.19.0 or later, from the package's `engines` field.
- `effect` 4.0.0-rc.108. Suites, runs, baselines, and gates are all `Effect`
  values, so every program composes with the `effect` library directly.
- `@smthrs/core`, `@smthrs/scorers`, and `@smthrs/testing` are declared
  dependencies, and pnpm links them with the package. You import from them for
  the pieces the pipeline composes: `Flow` values from
  [@smthrs/core](https://core.smithers.sh/reference/api/), scorers and bindings from
  [@smthrs/scorers](https://scorers.smithers.sh/reference/api/), gate arithmetic from
  [@smthrs/testing](https://testing.smithers.sh/reference/api/).

## Entry points

- `@smthrs/evals` exports the eight namespaces: `EvalError`, `Suite`,
  `CaseExecutor`, `Runner`, `Baseline`, `Regression`, `Report`, and `Gate`.
- `@smthrs/evals/<Module>` imports one namespace directly, for example
  `@smthrs/evals/Suite`.
- `@smthrs/evals/package.json` is exported. The `internal/*` modules and
  nested `*/index` subpaths are not public.
