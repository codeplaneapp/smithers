/**
 * What a failure that carries no sentence still owes an operator.
 *
 * Every `@smthrs/control` failure is a `Schema.TaggedError` whose data lives in
 * named fields. Some override `message` with a sentence — `NoMatchingWait`
 * does, and says why: "every other renderer in the tree prints `message`, so a
 * refusal with none is a refusal with no reason". The rest have none, and the
 * executable's reporter printed the class name and a bare colon for them:
 * `smithers resume` against a run another process owns answered the whole line
 * `ClaimLost: `, which names neither the run nor the stable `code` a script
 * must be able to grep for.
 *
 * It lives here rather than in `bin.ts` because importing that module runs the
 * command line: the reporter itself can only be exercised through a real
 * process, and this is the part of it that has an answer to check.
 *
 * @since 1.0.0
 */

/**
 * How much of one field a refusal line may spend, before the rest is cut.
 *
 * @category constants
 * @since 1.0.0
 */
export const fieldValueLimit = 256

/**
 * The refusal detail a failure's own fields state.
 *
 * The constant contract code leads, then every scalar field by name, each
 * bounded so one large field — an `InvalidInput` issue, say — cannot flood a
 * terminal. Structured fields are left out: a plan envelope is not a refusal
 * reason, and it is in the run's journal either way. An error carrying neither
 * a code nor a scalar field answers the empty string, which is what the
 * reporter printed for it before.
 *
 * @category getters
 * @since 1.0.0
 */
export const fields = (error: Error): string => {
  const own = error as unknown as Readonly<Record<string, unknown>>
  const scalar = (value: unknown): string | undefined =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [...String(value)].slice(0, fieldValueLimit).join("")
      : undefined
  const code = typeof own["code"] === "string" ? [own["code"]] : []
  const named = Object.keys(own).flatMap((key) => {
    if (key === "_tag" || key === "code") return []
    const value = scalar(own[key])
    return value === undefined ? [] : [`${key}=${value}`]
  })
  return [...code, ...named].join(" ")
}

/**
 * The sentence an operator reads for one failure: its own, or its fields.
 *
 * @category getters
 * @since 1.0.0
 */
export const sentence = (error: Error): string => error.message === "" ? fields(error) : error.message
