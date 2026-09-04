---
title: "Add an error code"
description: "The procedure for adding a sixth code: decide whether it belongs here at all, add the row, update the tests and the reference page, then verify."
sidebar:
  order: 4
---

Adding a code changes a published vocabulary that other packages branch on, so
the first step is deciding not to.

## Decide whether the code belongs here

Add a code only when an integration adapter in
[`@smthrs/integrations`](/api/integrations) raises it. That is the entire
membership rule.

If the failure belongs to any other package, state it as a `Schema.TaggedError`
class on the effect that can fail. That is the convention everywhere else in
this workspace, and it gives you a checked failure channel instead of a string
a caller has to look up.
[The closed code vocabulary](../concepts/error-codes.md) has the reasoning.

If an existing code already fits, use it. A failure that a caller handles the
same way as `INVALID_INPUT` does not need a code of its own; it needs a better
summary and, where there is a field to name, a `details` key.

## Add the row

`smithersErrorDefinitions` in `packages/errors/src/ErrorCode.ts` is the runtime
source of truth. Add one row:

```ts
export const smithersErrorDefinitions = {
  // ...
  YOUR_CODE: {
    when: "The condition that raises it, in one sentence a caller can act on.",
    details: "The shape of the details record, or omit the field when there is none."
  }
} as const satisfies Record<string, SmithersErrorDefinition>
```

`SmithersErrorCode` and `smithersErrorCodes` are both derived from the keys, so
the type and the runtime list update themselves. Nothing else in
`src/` changes.

Write `when` as the condition, not as the fix. The fix belongs in the reference
page, where there is room for it.

## Update the tests

Two tests in `test/SmithersError.test.ts` pin the vocabulary and will fail:

- `documents exactly the codes the integration adapters raise` asserts the
  sorted code list. Add your code to the expected array.
- `gives every code a trigger description` and
  `keeps definition details meaningful` walk the table, so a row with an empty
  `when` or an empty `details` fails without an edit.

If your code's `details` string is one a caller must be able to rely on, add an
assertion for it next to the two that already pin `INVALID_INPUT` and
`TELEGRAM_INIT_DATA_INVALID`.

## Update the documentation

Three files describe the vocabulary, and all three are hand-maintained:

- `docs/reference/error-codes.md`: add a summary row and a section with the
  meaning, every raise site, the `details` each attaches, and what the caller
  should do.
- `docs/README.md`: add a row to the five-code table.
- The package `README.md`: add a row to its code table.

The reference section is the one that earns its length. A caller who has caught
your code needs to know which call produced it and what to do next, and
`when` alone cannot carry that.

## Verify

```bash
pnpm --filter @smthrs/errors test
pnpm --filter @smthrs/errors check
pnpm --filter @smthrs/errors lint
pnpm --filter @smithers/docs-errors sync:docs
pnpm --filter @smithers/docs-errors build
```

`sync:docs` rewrites the site copy under `apps/docs/errors/`. Commit that tree
with your source docs: continuous integration fails on drift between them.

Then update every caller. A closed union means an exhaustive `switch` over
`error.code` becomes a type error the moment your row lands, which is the
friction the closed vocabulary is for.
