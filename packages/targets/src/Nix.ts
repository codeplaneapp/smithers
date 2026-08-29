/**
 * Nix dev-shell version authority and tool references.
 *
 * @since 0.1.0
 */
/* eslint-disable jsdoc/require-description, jsdoc/no-restricted-syntax */
import type * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Toolchain from "./Toolchain.ts"

/** */
export interface DevShellDeclaration extends Toolchain.Declaration<"NixDevShell"> {
  readonly flake: Input.File
  readonly lock: Input.File
}

/** */
export const DevShell = (options: { readonly flake: Input.File; readonly lock: Input.File }): DevShellDeclaration => {
  if (typeof options !== "object" || options === null) throw new TypeError("Nix.DevShell options must be an object")
  for (const key of Object.getOwnPropertyNames(options)) {
    if (key !== "flake" && key !== "lock") {
      throw new TypeError(`Nix.DevShell received unknown option ${JSON.stringify(key)}`)
    }
  }
  if (options.flake?._tag !== "File" || options.lock?._tag !== "File") {
    throw new TypeError("Nix.DevShell flake and lock must be S.file declarations")
  }
  return Toolchain.declare({ _tag: "NixDevShell", flake: options.flake, lock: options.lock })
}

/** */
export const bin = Reference.nixBin
