---
title: "Command reference"
description: "Every flag of the two commands an app author runs: smithers-build create-app, which scaffolds an app, and smithers-routes, which writes and drift-checks the generated route tables."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/create-app/docs/reference/cli.md"
---

Two commands touch a Smithers app from the outside. `smithers-build create-app`
creates one, and `smithers-routes` keeps its generated tables current.

## smithers-build create-app

Copies a template into a new directory. The verb belongs to
[`@smthrs/build-cli`](https://build-cli.smithers.sh/); the templates ship in this package and
the CLI resolves them through Node rather than by path.

```bash
pnpm exec smithers-build create-app <dir> [--template <name>] [--no-link]
```

| Argument or option               | Default                        | Meaning                                                                        |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `<dir>`                          | required                       | Directory to create. Its name becomes the app name                             |
| `--template <name>`, `-t <name>` | `default`                      | Which template to copy: `default` or `aomi`                                    |
| `--link` / `--no-link`           | link when a checkout was found | Whether `@smthrs/*` dependencies point at the checkout the templates came from |

The command takes neither `--workspace` nor `--cache-dir`.

It reports what it did as JSON: the resolved `directory`, the `name` it
substituted, the `template`, the number of `files` copied, and the sorted list
of dependency names it `linked`.

Three refusals, each exiting non-zero:

| Message                                                                         | Cause                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `unknown template "<name>"; available: aomi, default`                           | `--template` named something that is not a directory under `template/`    |
| `"<name>" is not a usable app name; use lowercase letters, digits, ., _, and -` | The directory's base name does not match `^[a-z0-9][a-z0-9._-]*$`         |
| `<dir> is not empty`                                                            | The target directory holds something. An existing empty directory is fine |

## smithers-routes

Walks an app root and writes `routes.gen.ts` and `routes.ui.gen.ts`. Both
templates expose it as `pnpm routes` and `pnpm routes:check`.

```bash
smithers-routes [--check] [--root <dir>] [--app <dir>] [--flows <dir>] [--tools <dir>]
```

| Option          | Default               | Meaning                                            |
| --------------- | --------------------- | -------------------------------------------------- |
| `--check`       | off                   | Report drift instead of writing                    |
| `--root <dir>`  | the working directory | The app root to walk                               |
| `--app <dir>`   | `app`                 | The directory holding pages, panes, and the layout |
| `--flows <dir>` | `flows`               | The directory holding flow directories             |
| `--tools <dir>` | `tools`               | The tools directory                                |
| `--help`, `-h`  |                       | Print the usage text and exit 0                    |

Every flag takes either form: `--root <dir>` or `--root=<dir>`.

The three directory flags mirror the `dirs` field of `CreateApp`, so an app
that renamed them passes the same names here.

### Exit codes

| Code | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| 0    | The files were written, or `--check` found no drift          |
| 1    | `--check` found a stale file, or the router refused the tree |
| 2    | A flag was given without a value                             |

A successful write reports the counts:

```text
routes: 1 pages, 1 panes, 1 flows
```

`--check` writes nothing and names each stale file on stderr:

```text
routes.gen.ts is out of date; run `pnpm routes`
```

A refused tree prints the router's own message and exits 1:

```text
no TOOLS.ts found for flows/chat or any ancestor; add one at the app root
```

### Which entry point runs

`bin/routes.mjs` is a shim that decides between the compiled generator and the
source one by where the file sits, not by what exists next to it. Node refuses
to strip types from any file under a `node_modules` directory, so an installed
copy must run `dist/esm/routesBin.js`; anywhere else the TypeScript source runs
through Node's own type stripping.

An installed copy with no `dist/esm/routesBin.js` says so and exits 1, rather
than failing on a type-stripping error that names neither cause nor cure.

A pnpm `link:` install resolves to its real path in the checkout, so a
scaffolded app linked at a source checkout runs that checkout's source. That is
why an edit to the router shows up in the linked app's next `pnpm routes` run
without a rebuild.

### Drift, three ways

```bash
pnpm routes:check                 # smithers-routes --check
smithers-build lint '//:routes'   # what the build graph runs
smithers-build '//:routes'        # the write form; checks nothing
```

`--check` is the standalone convenience. The build graph checks drift by
running the generator in write mode and comparing the `routes` target's
declared changes. See
[The generated route tables](/concepts/generated-routes/).

### Running it from code

The executable's whole body is exported, so a test or another host can drive it
and read exactly what a user would see:

```ts
import { runRoutesBin, usage } from "@smthrs/create-app/routesBin"

const lines: Array<string> = []
const code = runRoutesBin(["--check"], {
  io: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
  cwd: "/work/ledger"
})
```
