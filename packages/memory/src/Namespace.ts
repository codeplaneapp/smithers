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
export const Tags = Schema.Array(Tag).pipe(Schema.check(Schema.isMaxLength(MAX_TAGS)))

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

/**
 * Recursive Schema for tag-group queries.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const TagGroup = TagGroupSchema

/**
 * Evaluates a tag-group against a record's tags.
 *
 * Non-strict `any` and `all` preserve Smithers' wildcard behavior for
 * untagged records. Strict modes require the record to carry at least one tag.
 *
 * @category predicates
 * @since 0.1.0
 * @slop
 */
export const matches = (tagGroup: TagGroup, tags: ReadonlyArray<string>): boolean => {
  if ("and" in tagGroup) {
    return tagGroup.and.every((child) => matches(child, tags))
  }
  if ("or" in tagGroup) {
    return tagGroup.or.some((child) => matches(child, tags))
  }
  if ("not" in tagGroup) {
    return !matches(tagGroup.not, tags)
  }
  const expected = new Set(tagGroup.tags)
  const actual = new Set(tags)
  switch (tagGroup.match ?? "any") {
    case "all":
      return tags.length === 0 || tagGroup.tags.every((tag) => actual.has(tag))
    case "any_strict":
      return tags.length > 0 && tagGroup.tags.some((tag) => actual.has(tag))
    case "all_strict":
      return tags.length > 0 && tagGroup.tags.every((tag) => actual.has(tag))
    case "exact":
      return actual.size === expected.size && tagGroup.tags.every((tag) => actual.has(tag))
    case "any":
      return tags.length === 0 || tagGroup.tags.some((tag) => actual.has(tag))
  }
}
