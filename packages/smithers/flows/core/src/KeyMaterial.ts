/**
 * Digest-free input to `/keys`.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * Graph-local ids may occur only inside dependency references. The key
 * compiler replaces those references with dependency digests; names and tree
 * positions are never hashed directly.
 *
 * @since 0.0.0
 */

import type * as Effects from "./Effects.ts"
import type * as Placement from "./Placement.ts"

/**
 * A declared input used to identify a planned node.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type InputRef =
  | { readonly _tag: "Literal"; readonly value: unknown }
  | { readonly _tag: "Ref"; readonly from: string; readonly path: ReadonlyArray<string> }
  | { readonly _tag: "Pending"; readonly from: string }

/**
 * Digest-free key material for a planned node.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface KeyMaterial {
  readonly version: "flows/key-material/v2"
  readonly kind: "sealed" | "compensable" | "irreversible"
  readonly body: unknown
  readonly inputs: ReadonlyArray<InputRef>
  readonly layers: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly placement: Placement.Placement | undefined
}

/**
 * A graph-local association between a node and its digest-free key material.
 *
 * `nodeId` is traversal data and is never part of the material handed to the
 * key compiler.
 *
 * `/keys/StepKey.fromKeyMaterial` consumes these entries and performs
 * dependency-digest substitution before hashing.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Entry {
  readonly nodeId: string
  readonly material: KeyMaterial
}
