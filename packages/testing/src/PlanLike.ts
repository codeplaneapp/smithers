/**
 * Read-only plan introspection types.
 *
 * @since 0.0.0
 */

/**
 * A serializable projection of a node's placement directive: the placement
 * tag plus its option payload (image/profile/target style host selection).
 *
 * @since 0.0.0
 * @category models
 */
export interface PlanPlacementLike {
  readonly tag: string
  readonly options: Readonly<Record<string, unknown>>
}

/**
 * One plan node, in the shape the plan assertions read.
 *
 * @category models
 * @since 0.0.0
 */
export interface PlanNodeLike {
  readonly id: string
  readonly key: string
  readonly kind: string
  readonly placement?: PlanPlacementLike
  /** Declared `read:<path>` / `write:<path>` entries from fromGraph; empty when undeclared. */
  readonly effects: ReadonlyArray<string>
  /** Effect mode from the node's own declaration, absent when undeclared (`hermetic` | `expected`). */
  readonly mode?: string
  /** Effect tier from the node's own declaration, absent when undeclared (`sealed` | `compensable` | `irreversible`). */
  readonly tier?: string
  /** Conflict strategy from the node's own declaration, absent when undeclared (`serialize` | `lane` | `fail`). */
  readonly onConflict?: string
  readonly sealed: boolean
  /** Effective effects, including inherited admission, when projected by fromGraph. */
  readonly envelope?: Record<string, unknown>
}

/**
 * A compiled plan, in the shape the plan assertions read.
 *
 * @category models
 * @since 0.0.0
 */
export interface PlanLike {
  readonly nodes: ReadonlyArray<PlanNodeLike>
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>
  readonly envelope?: Record<string, unknown>
  readonly digest?: string
}
