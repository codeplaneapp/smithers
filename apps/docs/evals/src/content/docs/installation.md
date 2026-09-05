---
title: "Installation"
description: "Add @smthrs/evals to a workspace package, plus its runtime requirements and entry points."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/evals/docs/installation.md"
---

Install the current release candidate from the `next` dist-tag:

```bash
pnpm add @smthrs/evals@next
```

```json
{
  "dependencies": {
    "@smthrs/evals": "1.0.0-rc.0"
  }
}
```

## Runtime requirements

- Node.js 22.19.0 or later, from the package's `engines` field.
- `effect` 4.0.0-rc.112. Suites, runs, baselines, and gates are all `Effect`
  values, so every program composes with the `effect` library directly.
- `@smthrs/core` supplies `Flow` values. `@smthrs/scorers` supplies scorers,
  bindings, and the pure `@smthrs/scorers/ScoreGate` grading contract, including
  `ScoreGateError`. The evaluation runtime does not load `@smthrs/testing`;
  that package supplies a test facade for development consumers. To run the
  agent behind a case, add [@smthrs/agent](https://agent.smithers.sh/reference/api/) as well.

## Entry points

- `@smthrs/evals` exports the eight namespaces: `EvalError`, `Suite`,
  `CaseExecutor`, `Runner`, `Baseline`, `Regression`, `Report`, and `Gate`.
- `@smthrs/evals/<Module>` imports one namespace directly, for example
  `@smthrs/evals/Suite`.
- `@smthrs/evals/package.json` is exported. The `internal/*` modules and
  nested `*/index` subpaths are not public.
