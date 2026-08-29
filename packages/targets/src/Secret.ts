/**
 * Declared secrets for BUILD.ts targets.
 *
 * A secret declaration names the environment variable a value is read from. It
 * is inert: `Secret("SMITHERS_CACHE_TOKEN")` performs no read, so BUILD.ts
 * evaluation stays pure and a BUILD.ts file never contains a credential.
 *
 * The value is resolved lazily, at execution, and only for a target that
 * declared the secret. It is never placed in a child process's environment.
 * Instead the target is given an unguessable **placeholder**, minted per run,
 * and the substituting proxy replaces that placeholder with the real value on
 * outbound requests. A tool therefore holds a token-shaped string that is
 * worthless anywhere except through the proxy, and a tool that logs its
 * environment leaks nothing.
 *
 * Three properties follow, and each is the reason for one design choice.
 *
 * - **Explicit dependency.** A target reaches a secret only by declaring it in
 *   attrs. Placeholders are minted per run and handed only to the target that
 *   declared the secret, so a target cannot spell a placeholder itself and have
 *   the proxy substitute a credential it was never given.
 * - **No value in key material.** The declaration carries a variable name.
 *   Keys record the name; they never record the value, and a cache entry
 *   therefore cannot carry a credential between machines.
 * - **Lazy resolution.** The host variable is read when a request needs it, not
 *   when BUILD.ts is evaluated and not when a target is planned. A workspace
 *   that plans a graph it does not execute never touches the credential.
 *
 * This replaces the previous model, where a target hardcoded an environment
 * variable name and the exec runner deleted it from every child's environment.
 * Withholding is a blunt instrument: it makes a secret unusable rather than
 * usable safely, which is why the remote cache had to reach around it.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Maximum length of a declared environment-variable name.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumNameLength = 256

/**
 * Schema for one declared secret.
 *
 * The declaration is the variable name and nothing else. A placeholder is not
 * part of it: placeholders are minted per run by the executor, so two runs of
 * the same graph never reuse one and a declaration can be cached without ever
 * pinning a substitution token.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Declaration = Schema.TaggedStruct("Secret", {
  /** The environment variable the value is read from at execution time. */
  env: Schema.NonEmptyString,
  /** Public fallback used only when the environment variable is absent. */
  fallback: Schema.optional(Schema.NonEmptyString)
})

/**
 * One declared secret.
 *
 * @category models
 * @since 0.1.0
 */
export type Secret = typeof Declaration.Type

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Declares one secret, read lazily from the named environment variable.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const cacheToken = Smithers.Secret("SMITHERS_CACHE_TOKEN")
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Secret = (env: string, options: { readonly fallback?: string | undefined } = {}): Secret => {
  if (typeof env !== "string") throw new TypeError("Secret name must be a string")
  if (env.length > maximumNameLength || !env.isWellFormed()) {
    throw new Error("Secret name must be bounded well-formed text")
  }
  const trimmed = env.trim()
  if (!environmentName.test(trimmed)) {
    throw new Error(`Secret name must be an environment variable name: ${JSON.stringify(env)}`)
  }
  if (typeof options !== "object" || options === null) throw new TypeError("Secret options must be an object")
  for (const key of Object.getOwnPropertyNames(options)) {
    if (key !== "fallback") throw new TypeError(`Secret received unknown option ${JSON.stringify(key)}`)
  }
  if (options.fallback !== undefined && options.fallback === "") {
    throw new TypeError("Secret fallback must be non-empty text")
  }
  return Declaration.make({ env: trimmed, ...(options.fallback === undefined ? {} : { fallback: options.fallback }) })
}

/**
 * Checks whether a value is a declared secret.
 *
 * @category guards
 * @since 0.1.0
 */
export const isSecret = (value: unknown): value is Secret => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { readonly _tag?: unknown; readonly env?: unknown; readonly fallback?: unknown }
  return candidate._tag === "Secret" && typeof candidate.env === "string" &&
    (candidate.fallback === undefined || typeof candidate.fallback === "string")
}

/**
 * The fixed prefix every minted placeholder carries.
 *
 * The prefix exists so a placeholder that escapes into a log is recognisable
 * as a placeholder rather than mistaken for a leaked credential, and so the
 * substituting proxy can cheaply skip requests that contain no placeholder at
 * all.
 *
 * @category constants
 * @since 0.1.0
 */
export const placeholderPrefix = "smithers-build-secret-"

/**
 * Number of random bytes in a minted placeholder.
 *
 * A placeholder is an unguessable capability: holding one is what entitles a
 * request to substitution. 32 bytes puts guessing beyond reach for the
 * lifetime of a run.
 *
 * @category constants
 * @since 0.1.0
 */
export const placeholderBytes = 32

/**
 * Matches any minted placeholder.
 *
 * @category constants
 * @since 0.1.0
 */
export const placeholderPattern = new RegExp(`${placeholderPrefix}[0-9a-f]{${placeholderBytes * 2}}`, "g")
