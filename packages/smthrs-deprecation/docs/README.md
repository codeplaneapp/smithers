---
title: "smthrs"
description: "The unscoped smthrs package at 1.0.0-rc.0 is a migration notice, not a runtime: importing it throws, and the message names the @smthrs/* packages that replace it."
---

`smthrs@1.0.0-rc.0` publishes no runtime. Importing it throws, and the error is
the entire package:

```text
smthrs 1.0 is a migration notice, not a runtime.
Smithers 1.0 ships as @smthrs/* packages. Install @smthrs/flows (authoring and engine)
and @smthrs/cli (the `smthrs` command), then run `smthrs migrate` in a 0.x project.
Migration guide: https://smithers.sh/migration/1.0
```

Smithers 0.x published `smthrs` as an umbrella facade over the JSX authoring
API, the renderer, and fourteen `@smthrs/*` packages. Smithers 1.0 removes that
architecture. The name keeps its place on the registry so that an upgrading
project is told where the code went, rather than resolving to a silently
different API. There is no umbrella package at 1.0, no JSX runtime, and no
compatibility shim.

## Pick your path

Two different readers reach this notice, and the right next command is not the
same for both.

### You are upgrading a Smithers 0.x project

Run the migration and let it rewrite the manifest. Install the 1.0 command
line, then plan the migration from the project directory:

```bash
npm install --global @smthrs/cli@next
smthrs migrate
```

`smthrs migrate` with no flags plans only. It writes
`.smithers-migrate/report.json` and `.smithers-migrate/report.md` and changes
nothing else. Read the report, then convert the source with
`smthrs migrate --apply --seat provider:model`.

Leave `smthrs` in `package.json` while you do. An apply run migrates the
project one unit at a time: the first unit adds the `@smthrs/*` packages at
1.0.0-rc.0 beside the old ones, and the final unit removes the 0.x packages,
the JSX settings, and the old CLI scripts once nothing depends on them.

Reaching this notice means `smthrs@1.0.0-rc.0` is installed where 0.x used to
be. Reinstall `smthrs@0.35.0` first if the project's `.tsx` sources still have
to compile: 1.0.0-rc.0 publishes no `jsx-runtime`, so nothing that resolves
through `jsxImportSource: "smthrs"` resolves at all.

The whole procedure, its two gates, and every flag are in the
[1.0 migration guide](/migration/1.0) and the [`smthrs migrate`](/cli/migrate)
reference.

### You wanted the 1.0 runtime and installed this name

Depend on the `@smthrs/*` packages directly:

```bash
npm remove smthrs
npm install @smthrs/flows@next @smthrs/cli@next
```

[`@smthrs/flows`](/pkg/flows) is the curated aggregate: the authoring
primitives, the durable engine, and the stores behind one dependency.
[`@smthrs/cli`](/pkg/cli) owns the `smthrs` command and its `smithers` alias.
Import the package you need. Nothing at 1.0 re-exports everything.

## Where to go next

- [Why importing throws](./notice.md): what the notice says, why the package
  throws instead of resolving to an empty module, and how it is published.
- [What replaced the 0.x umbrella](./replacements.md): each construct the
  facade exported and the 1.0 concept to rewrite it against.
- [Troubleshooting](./troubleshooting.md): the errors a 0.x project hits
  first, including the ones that never print the notice.
- The [1.0 migration guide](/migration/1.0): the full upgrade procedure, and
  every removed command and flag.
