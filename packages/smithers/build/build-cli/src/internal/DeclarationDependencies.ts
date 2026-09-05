/**
 * Checks the physical runtime selected by ordinary Node package resolution.
 *
 * `findPackageJSON` uses Node's default resolver on the supported runtimes,
 * independently of installed resolve hooks. A bootstrap alias therefore cannot
 * hide a conflicting workspace installation from this check. This is a physical
 * installation check, not proof of identity across arbitrary loader namespaces.
 *
 * @since 1.0.0
 */
import { realpathSync } from "node:fs"
import { findPackageJSON } from "node:module"
import { dirname } from "node:path"
import { pathToFileURL } from "node:url"
import { PackageError } from "../PackageError.ts"

const sharedPackages = ["effect", "@smthrs/targets", "@smthrs/plan", "@smthrs/core", "@smthrs/flow"] as const

/**
 * Refuses a declaration closure that would select another physical runtime.
 *
 * Missing packages remain admissible only when the caller explicitly requests
 * the existing dependency-free bootstrap contract. Installed conflicts and
 * resolution errors always fail, including in bootstrap mode.
 *
 * @category validation
 * @since 1.0.0
 */
export const assertDeclarationDependencies = (
  files: ReadonlyArray<string>,
  options: { readonly bootstrap: boolean }
): void => {
  const directories = new Set<string>()
  for (const file of files) {
    const directory = dirname(file)
    if (directories.has(directory)) continue
    directories.add(directory)
    for (const dependency of sharedPackages) {
      let expected: string
      let actual: string
      try {
        const cli = findPackageJSON(dependency, import.meta.url)
        if (cli === undefined) throw new Error(`the CLI cannot locate ${dependency}`)
        expected = realpathSync(cli)
        let declared: string | undefined
        try {
          declared = findPackageJSON(dependency, pathToFileURL(file))
        } catch (cause) {
          if (
            options.bootstrap && typeof cause === "object" && cause !== null &&
            "code" in cause && cause.code === "ERR_MODULE_NOT_FOUND"
          ) continue
          throw cause
        }
        if (declared === undefined) {
          if (options.bootstrap) continue
          throw new Error(`the declaration cannot locate ${dependency}`)
        }
        actual = realpathSync(declared)
      } catch (cause) {
        throw new PackageError(
          "declaration_dependency_unresolved",
          `cannot resolve ${dependency}; install the workspace dependencies and run its local CLI`,
          { path: file, cause }
        )
      }
      if (actual !== expected) {
        throw new PackageError(
          "declaration_dependency_mismatch",
          `${dependency} resolves to ${actual}, but the CLI uses ${expected}; ` +
            "install matching workspace dependencies and run the workspace-local CLI; " +
            "remove linked packages' private runtime copies",
          { path: file }
        )
      }
    }
  }
}
