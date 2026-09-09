---
title: "Scaffold an app"
description: "Create a Smithers app from a registry-installable template: what the copy substitutes and what the command refuses."
sidebar:
  order: 4
---

`create-app` is the one verb that creates a directory instead of reading a
workspace. It takes neither `--workspace` nor `--cache-dir`.

```bash
pnpm exec smithers-build create-app my-app
```

## Pick a template

The public [`@smthrs/create-app`](/api/create-app) package ships one template:

```bash
pnpm exec smithers-build create-app my-app --template default
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

The report names the directory, app name, template, and number of files copied.
The template already pins the synchronized RC package versions, so scaffolding
does not rewrite dependencies or create local links.

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
own. Dependency versions are copied unchanged. See the
[API reference](../api.md).
