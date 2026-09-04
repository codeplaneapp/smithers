---
title: "Scaffold an app"
description: "Create a Smithers app from a template with create-app: what the copy substitutes, when dependencies are rewritten to link: paths, and what the command refuses."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/build-cli/docs/guides/scaffold-an-app.md"
---

`create-app` is the one verb that creates a directory instead of reading a
workspace. It takes neither `--workspace` nor `--cache-dir`.

```bash
pnpm exec smithers-build create-app my-app
```

## Pick a template

Two templates ship in [`@smthrs/create-app`](https://create-app.smithers.sh/reference/api/):

```bash
pnpm exec smithers-build create-app my-app --template default
pnpm exec smithers-build create-app my-app --template aomi
```

`--template, -t` defaults to `default`. An unknown name fails and lists the
templates the resolved package actually offers, so the error tells you what is
available rather than what was expected.

The CLI resolves the template directory through Node from the installed
`@smthrs/create-app`, so it never hardcodes a path. If that package is not
installed, the command fails with
`create-app templates ship in @smthrs/create-app; install it and try again`.

## What the copy does

Scaffolding is a file copy plus one substitution.

- The directory's own base name becomes the app name. `__APP_NAME__` is
  replaced with it in every `.css`, `.html`, `.json`, `.jsonc`, `.md`, `.mjs`,
  `.ts`, and `.tsx` file. Other files are copied byte for byte.
- Four directories are never copied, however dirty the checkout is:
  `node_modules`, `dist`, `.wrangler`, and `.flows`. A template is an ordinary
  directory, so anything a tool leaves in it would otherwise be copied;
  running a template's own suite writes `node_modules/.vite`, and that debris
  used to land in every scaffolded app. `.smithers` is deliberately not on
  that list, because templates ship one.

The report names the directory, the app name, the template, the number of
files copied, and the dependencies it rewrote.

## Linking against a checkout

The `@smthrs/*` packages a template depends on are not published, so a scaffold
cut from a source checkout rewrites those specifiers to `link:` paths into
that checkout:

```json
{
  "dependencies": {
    "@smthrs/flow": "link:/path/to/smithers/packages/smithers/flows/flow"
  }
}
```

`--link` is on by default when the templates came from a checkout and off when
they came from a registry install under `node_modules`. `--no-link` keeps the
declared versions in either case.

Two details decide whether linking finds anything, and both are about a tree
whose shape is not fixed:

- The checkout is found by walking up from the template directory for a
  directory named `packages`, not by counting segments off it. Packages nest,
  so this one at `<repo>/packages/smithers/create-app` would have answered
  `<repo>/packages/smithers` under a fixed two-segment rule.
- Each package is identified by the `name` its manifest declares, found by
  walking the whole `packages` tree. A package's directory is not its
  identity: `@smthrs/flow` lives at `packages/smithers/flows/flow` and
  `@smthrs/targets` at `packages/smithers/build/targets`, so
  `packages/<name after the scope>` finds neither.

A dependency the checkout does not carry keeps its declared version, so a
template naming a published package is left alone. When nothing is rewritten,
`linked` is empty. Seeing an empty `linked` from a source checkout means the
walk found no `packages` directory above the templates.

## What the command refuses

| Refusal                                           | Cause                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `unknown template "x"; available: ...`            | `--template` names a directory the template root does not hold.      |
| `"My-App" is not a usable app name; ...`          | The directory's base name is not `[a-z0-9][a-z0-9._-]*`.             |
| `<dir> is not empty`                              | The target directory holds something. An existing empty one is fine. |
| `create-app templates ship in @smthrs/create-app` | `@smthrs/create-app` is not resolvable from the CLI.                 |

A non-empty directory is refused rather than merged into, because a merge
would touch a tree the caller did not expect it to touch.

## Programmatically

```ts
import { scaffold } from "@smthrs/build-cli/CreateApp"

const report = await scaffold({ directory: "./ledger", template: "default" })
```

`scaffold` also takes `templateRoot` to point at a template directory of your
own, and `link` to force the rewrite on or off. See the
[API reference](/reference/api/).
