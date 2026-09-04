---
title: "Troubleshooting"
description: "The errors a 0.x project hits when smthrs@1.0.0-rc.0 is installed, including the ones that never print the notice: subpath resolution failures, a jsxImportSource pragma, a missing command, and an install that silently stays on 0.x."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smthrs-deprecation/docs/troubleshooting.md"
---

Most projects never see the notice first. Something else fails earlier, and
this page is how to recognize those failures as the same thing. Every fix ends
at the same place: the [1.0 migration guide](https://smithers.sh/docs/migration/1.0/).

## ERR_PACKAGE_PATH_NOT_EXPORTED on a `smthrs/...` subpath

**Symptom.** An import of a 0.x subpath fails to resolve, with no migration
text anywhere in the message:

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './jsx-runtime' is not defined by "exports" in .../node_modules/smthrs/package.json
```

**Cause.** Only the root specifier `smthrs` throws the notice. The package
exports `.` and nothing else, so `smthrs/jsx-runtime`,
`smthrs/jsx-dev-runtime`, `smthrs/ui`, `smthrs/gateway-react`, and every other
0.x subpath fail at resolution, before any module of this package evaluates.

**Fix.** Read it as the notice. Smithers 1.0 publishes no JSX runtime and no
umbrella subpaths, so there is nothing behind those specifiers to import.
Migrate the project: `smthrs migrate` rewrites the imports and drops the JSX
settings for you.

## TypeScript fails on `smthrs/jsx-runtime` before anything imports `smthrs`

**Symptom.** A 0.x project fails to typecheck or build the moment
`smthrs@1.0.0-rc.0` is installed, and the failing specifier is one nothing in
your source wrote.

**Cause.** `jsxImportSource: "smthrs"` makes every `.tsx` file resolve
`smthrs/jsx-runtime`, so the compiler reaches that subpath before your first
import statement runs. This is the error most 0.x projects see first.

**Fix.** It means what the notice means. If the project's `.tsx` sources still
have to compile while you work, reinstall `smthrs@0.35.0` first: 0.x is on the
`latest` dist-tag and still publishes the JSX runtime. Then migrate, and let
the migration's final unit remove the pragma along with the dependency.

## `npm install smthrs` installed 0.35.0, not the notice

**Symptom.** You expected the 1.0 packages, and got a 0.x install.

**Cause.** `smthrs@0.35.0` keeps the `latest` dist-tag until Smithers 1.0.0 is
final. Release candidates publish under `next`.

**Fix.** This is working as intended, and it is why an unattended
`npm install smthrs` cannot break a 0.x project. To reach 1.0, install the
packages by name: `@smthrs/flows@next` for the engine and `@smthrs/cli@next`
for the command.

## `smthrs: command not found` after installing this package

**Symptom.** The package installed, and no `smthrs` executable appeared.

**Cause.** This package ships no `bin`. That is deliberate: a binary here would
shadow the real one on every machine that installs both.

**Fix.** Install the command line, which owns both spellings of the
executable:

```bash
npm install --global @smthrs/cli@next
```

## The build succeeded and the notice never printed

**Symptom.** A bundled application still imports `smthrs`, nothing throws, and
the import appears to have vanished from the output.

**Cause.** A bundler that treats the module as side-effect free may drop an
import whose binding is unused, and dropping the import drops the notice. The
manifest declares `sideEffects: true` for exactly this reason, so a bundler
that dropped it was told otherwise by its own configuration.

**Fix.** Take the missing throw as the finding. The import resolves to a
package with no runtime, so remove it and depend on the `@smthrs/*` package
the code actually needs. Check the bundler's side-effect settings for a rule
that overrides package manifests.

## `smthrs migrate` refuses the project

**Symptom.** The command exits without migrating and names 0.x run state, an
unsafe construct, or a project under no version control.

**Cause.** Each is a gate, not a bug: a decision the tool will not make for
you.

**Fix.** The three refusals, the flags that accept each one, and the exit
codes are documented in the [1.0 migration guide](https://smithers.sh/docs/migration/1.0/) and the
[`smthrs migrate`](https://smithers.sh/docs/reference/cli/migrate/) reference. Run-state refusals have no
override: finish, archive, or discard those runs with the 0.x CLI first.
