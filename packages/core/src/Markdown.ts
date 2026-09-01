/**
 * Parses Agent Skills documents and lowers markdown prompts into ordinary
 * flows.
 *
 * General markdown discovery belongs to `/registry`. Agent Skills
 * frontmatter is parsed with the complete failsafe YAML schema before this
 * module lowers the document to the ordinary flow shape.
 *
 * Governing contract: `packages/core/docs/api.md`, published as
 * https://smithers.sh/api/core.
 *
 * @since 0.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Effects from "./Effects.ts"
import * as Flow from "./Flow.ts"
import * as SkillFrontmatter from "./internal/skillFrontmatter.ts"
import * as Placement from "./Placement.ts"

const input = Schema.Struct({ args: Schema.String })
const output = Schema.String

/**
 * Already-parsed metadata accepted by the markdown flow loader.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface MarkdownFrontmatter {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly model?: string | undefined
  readonly flows?: ReadonlyArray<string> | undefined
  readonly capabilities?: ReadonlyArray<string> | undefined
  readonly effects?: {
    readonly reads?: ReadonlyArray<string> | undefined
    readonly writes?: ReadonlyArray<string> | undefined
    readonly mode?: "hermetic" | "expected" | undefined
    readonly onConflict?: "serialize" | "lane" | "fail" | undefined
    readonly tier?: "sealed" | "compensable" | "irreversible" | undefined
  } | undefined
  readonly placement?: "sandbox" | "remote" | "client" | "local" | undefined
}

/**
 * Parsed Agent Skills document.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface SkillDocument {
  readonly name: string
  readonly description: string
  readonly allowedTools: ReadonlyArray<string>
  readonly body: string
  readonly extra: Record<string, unknown>
}

/**
 * Stable code emitted by markdown loader failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export const MarkdownErrorCode = Schema.Literals([
  "skill_missing_frontmatter",
  "skill_invalid_frontmatter",
  "skill_missing_name",
  "skill_missing_description"
])

/**
 * Stable code emitted by markdown loader failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type MarkdownErrorCode = typeof MarkdownErrorCode.Type

/**
 * A typed markdown loader failure.
 *
 * @category errors
 * @since 0.0.0
 * @slop
 */
export class MarkdownError extends Schema.TaggedError<MarkdownError>()("flows/core/MarkdownError", {
  code: MarkdownErrorCode,
  message: Schema.String
}) {}

/**
 * Lowers parsed markdown metadata and a markdown body to an ordinary flow.
 *
 * The prompt is the markdown body. Harnesses append non-empty runtime `args`
 * when rendering that prompt, preserving the markdown-flow calling convention.
 * Flow names remain declarations at this layer; no flow implementation is
 * resolved while lowering. The `smart` model seat is the explicit fallback
 * when frontmatter declares no `model`.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const lowerMarkdown = (
  frontmatter: MarkdownFrontmatter,
  body: string
): Flow.Flow<typeof input, typeof output, never> => {
  const flow = Flow.make({
    name: frontmatter.name,
    description: frontmatter.description,
    input,
    output,
    capabilities: frontmatter.capabilities,
    ...(frontmatter.effects === undefined
      ? {}
      : {
        effects: Effects.make({
          reads: frontmatter.effects.reads ?? [],
          writes: frontmatter.effects.writes ?? [],
          mode: frontmatter.effects.mode ?? "hermetic",
          onConflict: frontmatter.effects.onConflict ?? "serialize",
          tier: frontmatter.effects.tier
        })
      }),
    model: frontmatter.model ?? "smart",
    flows: frontmatter.flows ?? [],
    prompt: body
  })

  switch (frontmatter.placement) {
    case "sandbox":
      return Flow.within(flow, Placement.sandbox())
    case "remote":
      return Flow.within(flow, Placement.remote())
    case "client":
      return Flow.within(flow, Placement.client())
    case "local":
      return Flow.within(flow, Placement.local())
    default:
      return flow
  }
}

/**
 * Parses an Agent Skills document with failsafe-schema YAML semantics.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const parseSkill = (text: string): Result.Result<SkillDocument, MarkdownError> => {
  const split = SkillFrontmatter.split(text)
  if (split.frontmatter === undefined) {
    return Result.fail(
      new MarkdownError({
        code: "skill_missing_frontmatter",
        message: "SKILL.md requires leading frontmatter"
      })
    )
  }

  const parsed = SkillFrontmatter.parse(split.frontmatter)
  if (Result.isFailure(parsed)) {
    return Result.fail(
      new MarkdownError({
        code: "skill_invalid_frontmatter",
        message: parsed.failure
      })
    )
  }

  const name = parsed.success.name
  if (typeof name !== "string" || name.trim() === "") {
    return Result.fail(
      new MarkdownError({
        code: "skill_missing_name",
        message: "SKILL.md requires a non-empty frontmatter name"
      })
    )
  }

  const description = parsed.success.description
  if (typeof description !== "string" || description.trim() === "") {
    return Result.fail(
      new MarkdownError({
        code: "skill_missing_description",
        message: "SKILL.md requires a non-empty frontmatter description"
      })
    )
  }

  const allowedToolsValue = parsed.success["allowed-tools"]
  let allowedTools: ReadonlyArray<string> = []
  if (typeof allowedToolsValue === "string") {
    allowedTools = allowedToolsValue.split(/\s+/).filter((tool) => tool.length > 0)
  } else if (
    Array.isArray(allowedToolsValue) &&
    allowedToolsValue.every((tool): tool is string => typeof tool === "string")
  ) {
    allowedTools = allowedToolsValue
  } else if (allowedToolsValue !== undefined) {
    return Result.fail(
      new MarkdownError({
        code: "skill_invalid_frontmatter",
        message: "SKILL.md allowed-tools must be a scalar or sequence of scalars"
      })
    )
  }

  const extra = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(parsed.success)) {
    if (key !== "name" && key !== "description" && key !== "allowed-tools") {
      Object.defineProperty(extra, key, {
        value,
        enumerable: true,
        writable: false,
        configurable: false
      })
    }
  }
  Object.freeze(extra)

  return Result.succeed({
    name,
    description,
    allowedTools,
    body: split.body,
    extra
  })
}

/**
 * Parses and lowers an Agent Skills document to an ordinary flow.
 *
 * Only `name`, `description`, and `allowed-tools` are lowered. Every other
 * frontmatter field remains in {@link parseSkill}'s `extra` record for the
 * caller to interpret. Agent Skills frontmatter is untyped failsafe YAML;
 * coercing extra fields here would duplicate the strict validation owned by
 * `@smthrs/registry`.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const lowerSkill = (
  text: string
): Result.Result<Flow.Flow<typeof input, typeof output, never>, MarkdownError> =>
  Result.map(parseSkill(text), (skill) =>
    lowerMarkdown({
      name: skill.name,
      description: skill.description,
      flows: skill.allowedTools
    }, skill.body))
