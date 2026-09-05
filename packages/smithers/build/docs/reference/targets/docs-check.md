---
title: "Docs.Check"
description: "Fails when a committed agent-written page is older than its inputs, was edited by hand after it was stamped, or carries no stamp."
---

Fails when a committed agent-written page is older than the inputs that
produced it, was edited by hand after it was stamped, or has no stamp.

```ts
import { Smithers } from "@smthrs/targets"

const references = Smithers.Filegroup({ srcs: [Smithers.glob("//apps/site/references/**")] })

export const fresh = Smithers.Docs.Check({
  stamp: Smithers.file("//apps/site/pages/intro/stamp.json"),
  output: Smithers.file("//apps/site/src/content/docs/docs/intro.mdx"),
  inputs: [
    Smithers.file("//apps/site/pages/intro/brief.md"),
    Smithers.file("//apps/site/prompts/style.md"),
    Smithers.glob("//packages/greeter/src/**/*.ts"),
    references
  ],
  producer: "claude-opus-5 prompts/tutorial.md"
})
```

Check it with:

```sh
smithers-build lint //apps/site:fresh
smithers-build ci //apps/site/...
```

Stamp the page after regenerating it with:

```sh
smithers-build docs //apps/site:fresh --write
```

## Attributes

| Name       | Type                                                     | Default  | Description                                                     |
| ---------- | -------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| `stamp`    | `Input.File`                                             | required | The committed JSON sidecar that records what produced the page  |
| `output`   | `Input.File`                                             | required | The generated page                                              |
| `inputs`   | `Array<Input.File \| Input.Glob \| Target>` (nestable)   | required | Everything the writer read: files, globs, and Filegroup targets |
| `producer` | `string`                                                 | none     | Provenance written into the stamp, a model id or a prompt path  |

Paths resolve the way every declared input does: `//` from the workspace root,
otherwise from the declaring package. A git diff is not a producer of a page
and is refused by shape. A target in `inputs` must be a `Filegroup`; any other
rule is refused at plan time. The stamp and the page may not be listed as
inputs, and may not be the same file.

## The stamp

```json
{
  "format": 1,
  "producer": "claude-opus-5 prompts/tutorial.md",
  "output": { "path": "apps/site/src/content/docs/docs/intro.mdx", "digest": "…" },
  "closure": "…",
  "inputs": [
    { "path": "apps/site/pages/intro/brief.md", "digest": "…" },
    { "path": "apps/site/prompts/style.md", "digest": "…" }
  ]
}
```

`inputs` is every file the closure reached, sorted by path, with its sha256;
`null` records a declared file that did not exist. `closure` is the key over
those rows, and it is not a hash this rule invents: it is the planner's own
per-input encoding (`digestText` over the JSON of the sorted `{path, digest}`
rows) applied to the union of the rows the `inputs` attr resolved to at plan
time. The verdict and the node's cache key are therefore computed from the
same bytes by construction, rather than by a second digest pass that could
disagree with the key the node was admitted under. Confinement, symlink policy,
size limits, and ignore rules all live in the planner's expansion.

It is deliberately not the node's key preview. That folds in the executor
implementation fingerprint, the attrs schema identity, and the execution mode,
so a committed stamp equal to it would go stale on every build-tool release
rather than only when an input moved.

`producer` is written for the record and never compared. A stamp of another
`format` is treated as no stamp.

## Policy

Under `lint` the executor digests the page and every file the `inputs` reach,
through nested filegroups, reads the stamp, and judges the page:

| Reason     | Meaning                                              | Named path                    |
| ---------- | ---------------------------------------------------- | ----------------------------- |
| `stale`    | An input changed, was added, or was removed          | The first such input, sorted  |
| `modified` | The page was edited after it was stamped             | The page                      |
| `missing`  | There is no stamp, or the page itself is absent      | The stamp, or the page        |

A closure mismatch wins over a modified page: regeneration answers both, and
the input that moved is the more useful thing to name. Every reason is answered
the same way: regenerate the page (the `docs`-verb agent target that wrote it,
or a person editing the brief or prompt and regenerating) and re-stamp it.

Under `docs --write`, or the bare label with `--write`, the executor writes
the stamp for the page as it stands through the shared atomic generated-file
write. It refuses to stamp a page that does not exist. Plain `docs`, and
therefore `ci`, only checks.

## Channels and status

| Property  | Value                                                                                 |
| --------- | ------------------------------------------------------------------------------------- |
| Kinds     | `lint`, `docs`                                                                        |
| Cacheable | Check form; the stamp, the page, and every input file are key material               |
| Success   | `void`                                                                                |
| Error     | `StaleError`, `{page, stamp, reason, path, message}`                                  |
| Executes  | Yes, through the package executor's `docs-check` lane                                 |

`ci` merges `lint` first, so the aggregate verb plans the checking form. No
agent is spawned on either path: the check is a pure function of committed
bytes, which is what lets CI gate pages an agent wrote.

One sidecar per page rather than one manifest per package: a shared manifest
makes every regeneration a merge conflict and every stale page a site-wide red,
while a sidecar fails one page and diffs beside it.

## See also

- [Docs.Page](docs-page.md), the agent rule that writes the page this one checks
- [Running targets](../../workspace/running-targets.md)
- [Writing target definitions](../../extending/writing-targets.md)
- [DocsParity](docs-parity.md)
