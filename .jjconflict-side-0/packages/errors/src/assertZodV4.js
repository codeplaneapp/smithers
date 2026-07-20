import { SmithersError } from "./SmithersError.js";

/**
 * Assert that a user-supplied schema is a Zod v4 schema, failing fast and clearly
 * when it is a Zod v3 (or otherwise pre-v4) schema.
 *
 * smithers introspects schemas through Zod v4 runtime internals (`schema._zod`)
 * and the v4-only static `z.toJSONSchema()`. A Zod v3 schema has no `_zod`, so
 * without this guard it would (a) silently degrade every output column to a JSON
 * text column in `zodToTable` (optional chaining swallows the missing `_zod`),
 * then (b) detonate later, deep inside `z.toJSONSchema`, with the cryptic
 * `undefined is not an object (evaluating 'schema._zod.def')`. This converts both
 * failure modes into one actionable error at the earliest boundary — workflow
 * construction.
 *
 * Detection signal: every Zod v4 schema instance carries
 * `schema._zod.version.major === 4`; Zod v3 schemas have no `_zod` at all.
 *
 * @param {unknown} schema - the candidate schema
 * @param {string} [where] - name of the schema (e.g. an output key) for the message
 * @returns {void}
 */
export function assertZodV4(schema, where) {
    if (!schema || typeof schema !== "object")
        return;
    const internal = /** @type {{ _zod?: { version?: { major?: number } } }} */ (schema);
    // Zod v4 fast-path: accept and return. Verified robust across object/string/
    // array/union/enum/optional plus refine/transform/pipe/lazy/brand/coerce —
    // every v4 schema instance carries _zod.version.major === 4.
    if (internal._zod?.version?.major === 4)
        return;
    // Only error on things that are recognizably a Zod schema, so a plain config
    // object that happens to flow through here is never rejected. NOTE: this is
    // purely an "is this Zod-shaped at all" gate — Zod v4 schemas ALSO carry
    // `_def`/`parse`, so this clause does NOT discriminate the version; the
    // `_zod.version` check above is the version discriminator.
    const candidate = /** @type {{ parse?: unknown }} */ (schema);
    const looksLikeZod = typeof candidate.parse === "function" || "_def" in schema || "shape" in schema;
    if (!looksLikeZod)
        return;
    const target = where ? ` for "${where}"` : "";
    throw new SmithersError("INVALID_INPUT", `smithers requires Zod v4 schemas${target}, but received what looks like a Zod v3 (or pre-v4) schema. ` +
        `Upgrade your project to "zod": "^4" and import schemas from "zod". ` +
        `smithers reads Zod v4 internals (schema._zod) and uses z.toJSONSchema(), neither of which exists on a Zod v3 schema.`, where ? { schema: where } : undefined);
}
