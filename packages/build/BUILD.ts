/**
 * Targets for the `@smthrs/build` package plus the declarations it
 * carried as a standalone workspace root:
 *
 * - `lib`, `check`, `test`, `lint`, `fmt`, and `docs` are this package's own
 *   standard targets. This BUILD.ts suppresses default-target synthesis, so
 *   they must be declared here explicitly.
 * - `template` is the inert shared manifest every package merges under.
 * - `packageDefaults` synthesizes a standard package's targets, and its
 *   manifest targets, for any `packages/*` directory without a BUILD.ts.
 *   Its glob anchors at this package, so in the Smithers monorepo it matches
 *   nothing; the workspace-wide declaration lives in the root BUILD.ts.
 * - `newPackage` is the `run` target that creates such a directory.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

const standard = Smithers.StandardPackage({ packageManager, cwd: "packages/build" })

export const lib = standard.lib
export const check = standard.check
export const test = standard.test
export const lint = standard.lint
export const fmt = standard.fmt
export const docs = standard.docs
export const circular = standard.circular

/**
 * The manifest fields every package in this workspace shares.
 *
 * Scripts here are literal commands: a template is workspace wide and cannot
 * name one package's targets. A package binds its own targets in its own
 * `scripts`, where the command is derived from the resolved label.
 */
export const template = Smithers.PackageJsonTemplate.make({
  type: "module",
  license: "MIT",
  author: "Smithers",
  sideEffects: [],
  engines: { node: ">=22.19.0" },
  scripts: Smithers.PackageJsonTemplate.standardScripts
})

/**
 * Standard package defaults.
 *
 * A directory under `packages/` with a `package.json` and no `BUILD.ts` gets
 * the six conventional targets plus `packageJsonCheck`, `packageJsonWrite`,
 * and `packageJsonRefresh`. `packageJsonCheck` runs under `lint` and `ci`; the
 * two writing targets run under `run` alone.
 */
export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  marker: "package.json",
  macro: (attrs: { readonly cwd: string }) => {
    const standard = Smithers.StandardPackage({ packageManager, deps: [], cwd: attrs.cwd })
    return {
      ...standard,
      packageJson: Smithers.PackageJson({
        name: `@smthrs/${attrs.cwd.split("/").at(-1) ?? attrs.cwd}`,
        version: "0.1.0",
        template,
        scripts: { build: standard.lib, lint: standard.lint },
        publish: { entry: standard.lib }
      })
    }
  }
})

/**
 * Scaffolds a new workspace package.
 *
 * ```sh
 * smithers-build run //:newPackage --name @smthrs/widget
 * ```
 */
export const newPackage = Smithers.NewPackage({
  directory: "packages",
  version: "0.1.0",
  license: "MIT",
  fields: template.fields,
  tsconfigExtends: "../../tsconfig.json"
})
