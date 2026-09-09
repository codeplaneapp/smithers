/**
 * Structured memory namespaces and tag-group matching.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Stable namespace lifetimes.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Kind = Schema.Literals(["flow", "agent", "user", "global"])

/**
 * Stable namespace lifetime.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Kind = typeof Kind.Type

/**
 * Structured memory namespace.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Namespace = Schema.Struct({
  kind: Kind,
  id: Schema.NonEmptyString
})

/**
 * Structured memory namespace.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Namespace = typeof Namespace.Type

/**
 * Maximum number of tags accepted on one record or tag-group leaf.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const MAX_TAGS = 16

/**
 * Maximum root-inclusive depth of one tag-group expression.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_TAG_GROUP_DEPTH = 8

/**
 * Maximum number of expression nodes in one tag-group tree.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_TAG_GROUP_NODES = 64

/**
 * Stable tag prefixes.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const TagPrefix = Schema.Literals(["branch:", "stream:", "source:", "scope:"])

/**
 * Stable tag prefix.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TagPrefix = typeof TagPrefix.Type

/**
 * A vocabulary-constrained memory tag.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Tag = Schema.TemplateLiteral([TagPrefix, Schema.NonEmptyString])

/**
 * A vocabulary-constrained memory tag.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Tag = typeof Tag.Type

/**
 * A bounded collection of memory tags.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const Tags = Schema.Array(Tag).pipe(
  Schema.check(Schema.isMaxLength(MAX_TAGS)),
  Schema.check(
    Schema.makeFilter(
      (tags) => new Set(tags).size === tags.length ? undefined : "invalid_tag: memory tags must be unique",
      { identifier: "invalid_tag" }
    )
  )
)

/**
 * A bounded collection of memory tags.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Tags = typeof Tags.Type

/**
 * Tag comparison modes inherited from the Smithers memory contract.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const MatchMode = Schema.Literals(["any", "all", "any_strict", "all_strict", "exact"])

/**
 * Tag comparison mode.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type MatchMode = typeof MatchMode.Type

/**
 * Recursive tag-group query expression.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TagGroup =
  | {
    readonly tags: Tags
    readonly match?: MatchMode | undefined
  }
  | {
    readonly and: ReadonlyArray<TagGroup>
  }
  | {
    readonly or: ReadonlyArray<TagGroup>
  }
  | {
    readonly not: TagGroup
  }

const TagGroupSchema: Schema.Codec<TagGroup> = Schema.suspend(
  (): Schema.Codec<TagGroup> =>
    Schema.Union([
      Schema.Struct({
        tags: Tags,
        match: Schema.optional(MatchMode)
      }),
      Schema.Struct({
        and: Schema.Array(TagGroupSchema)
      }),
      Schema.Struct({
        or: Schema.Array(TagGroupSchema)
      }),
      Schema.Struct({
        not: TagGroupSchema
      })
    ])
)

const isTags = Schema.is(Tags)
const isMatchMode = Schema.is(MatchMode)

const isTagGroupShape = (input: unknown): input is TagGroup => {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: input, depth: 1 }]
  let nodes = 0
  while (pending.length > 0) {
    const { depth, value: current } = pending.pop()!
    nodes += 1
    if (depth > MAX_TAG_GROUP_DEPTH || nodes > MAX_TAG_GROUP_NODES) return true
    if (typeof current !== "object" || current === null) return false
    if ("tags" in current) {
      if (!isTags(current.tags)) return false
      if ("match" in current && current.match !== undefined && !isMatchMode(current.match)) return false
      continue
    }
    if ("and" in current) {
      if (!Array.isArray(current.and)) return false
      if (nodes + pending.length + current.and.length > MAX_TAG_GROUP_NODES) return true
      for (let index = current.and.length - 1; index >= 0; index--) {
        pending.push({ value: current.and[index], depth: depth + 1 })
      }
      continue
    }
    if ("or" in current) {
      if (!Array.isArray(current.or)) return false
      if (nodes + pending.length + current.or.length > MAX_TAG_GROUP_NODES) return true
      for (let index = current.or.length - 1; index >= 0; index--) {
        pending.push({ value: current.or[index], depth: depth + 1 })
      }
      continue
    }
    if ("not" in current) {
      pending.push({ value: current.not, depth: depth + 1 })
      continue
    }
    return false
  }
  return true
}

const tagGroupBudgetIssue = (root: TagGroup): string | undefined => {
  const pending: Array<{ readonly group: TagGroup; readonly depth: number }> = [{ group: root, depth: 1 }]
  let nodes = 0
  while (pending.length > 0) {
    const { depth, group } = pending.pop()!
    nodes += 1
    if (depth > MAX_TAG_GROUP_DEPTH) {
      return `invalid_tag: tag-group depth exceeds ${MAX_TAG_GROUP_DEPTH}`
    }
    if (nodes > MAX_TAG_GROUP_NODES) {
      return `invalid_tag: tag-group node count exceeds ${MAX_TAG_GROUP_NODES}`
    }
    if ("and" in group) {
      if (nodes + pending.length + group.and.length > MAX_TAG_GROUP_NODES) {
        return `invalid_tag: tag-group node count exceeds ${MAX_TAG_GROUP_NODES}`
      }
      for (let index = group.and.length - 1; index >= 0; index--) {
        pending.push({ group: group.and[index]!, depth: depth + 1 })
      }
    } else if ("or" in group) {
      if (nodes + pending.length + group.or.length > MAX_TAG_GROUP_NODES) {
        return `invalid_tag: tag-group node count exceeds ${MAX_TAG_GROUP_NODES}`
      }
      for (let index = group.or.length - 1; index >= 0; index--) {
        pending.push({ group: group.or[index]!, depth: depth + 1 })
      }
    } else if ("not" in group) {
      pending.push({ group: group.not, depth: depth + 1 })
    }
  }
  return undefined
}

const TagGroupPreflight = Schema.declare<TagGroup>(isTagGroupShape, {
  identifier: "TagGroup"
}).pipe(
  Schema.check(
    Schema.makeFilter(
      tagGroupBudgetIssue,
      { identifier: "invalid_tag" },
      true
    )
  )
)

/**
 * Recursive Schema for tag-group queries.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const TagGroup = TagGroupPreflight.pipe(Schema.decodeTo(TagGroupSchema))

/**
 * Evaluates a tag-group against a record's tags.
 *
 * Non-strict `any` and `all` preserve Smithers' wildcard behavior for
 * untagged records. Strict modes require the record to carry at least one tag.
 * The walk is iterative and returns `false` for an undecoded expression that
 * exceeds {@link MAX_TAG_GROUP_DEPTH} or {@link MAX_TAG_GROUP_NODES}, keeping
 * the boolean signature used by store consumers without exposing a defect.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const matches = (tagGroup: TagGroup, tags: ReadonlyArray<string>): boolean => {
  const actual = new Set(tags)
  const evaluateLeaf = (group: Extract<TagGroup, { readonly tags: Tags }>): boolean => {
    const expected = new Set(group.tags)
    switch (group.match ?? "any") {
      case "all":
        return tags.length === 0 || group.tags.every((tag) => actual.has(tag))
      case "any_strict":
        return tags.length > 0 && group.tags.some((tag) => actual.has(tag))
      case "all_strict":
        return tags.length > 0 && group.tags.every((tag) => actual.has(tag))
      case "exact":
        return actual.size === expected.size && group.tags.every((tag) => actual.has(tag))
      case "any":
        return tags.length === 0 || group.tags.some((tag) => actual.has(tag))
    }
  }

  type Frame = { readonly group: TagGroup; readonly depth: number; readonly expanded: boolean }
  const pending: Array<Frame> = [{ group: tagGroup, depth: 1, expanded: false }]
  const values: Array<boolean> = []
  let nodes = 0
  // Expanded frames wait on `pending` for their children's values, so they are
  // not part of the node budget: the lookahead counts only unvisited frames,
  // matching the decoder's count so a schema-valid group is never refused here.
  let unvisited = 1
  while (pending.length > 0) {
    const frame = pending.pop()!
    const group = frame.group
    if (!frame.expanded) {
      nodes += 1
      unvisited -= 1
      if (frame.depth > MAX_TAG_GROUP_DEPTH || nodes > MAX_TAG_GROUP_NODES) return false
      if ("tags" in group) {
        if (!isTags(group.tags) || (group.match !== undefined && !isMatchMode(group.match))) return false
        values.push(evaluateLeaf(group))
        continue
      }
      pending.push({ ...frame, expanded: true })
      const children = "and" in group ? group.and : "or" in group ? group.or : "not" in group ? [group.not] : undefined
      if (children === undefined || !Array.isArray(children)) return false
      if (nodes + unvisited + children.length > MAX_TAG_GROUP_NODES) return false
      for (let index = children.length - 1; index >= 0; index--) {
        pending.push({ group: children[index]!, depth: frame.depth + 1, expanded: false })
      }
      unvisited += children.length
      continue
    }
    if ("not" in group) {
      const value = values.pop()
      if (value === undefined) return false
      values.push(!value)
      continue
    }
    const children = "and" in group ? group.and : "or" in group ? group.or : undefined
    if (children === undefined) return false
    const childValues = values.splice(values.length - children.length, children.length)
    if (childValues.length !== children.length) return false
    values.push("and" in group ? childValues.every(Boolean) : childValues.some(Boolean))
  }
  return values.length === 1 ? values[0]! : false
}
