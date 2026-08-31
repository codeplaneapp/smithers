// Deep reviewed and polished by a human on 2026-08-10.

/**
 * RFC 8785 canonical JSON, the serialization every digest in `@smthrs/flows`
 * is taken over.
 *
 * ```ts
 * import { Canonical } from "@smthrs/canonical"
 * import * as Schema from "effect/Schema"
 *
 * const document = Schema.decodeUnknownSync(Canonical)({ b: 1, a: 2 })
 * // => `{"a":2,"b":1}`
 * ```
 *
 * @since 0.1.0
 */

/**
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export * from "./Canonical.ts"
