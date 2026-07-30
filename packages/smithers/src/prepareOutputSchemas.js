import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

const RESERVED_PUBLIC_OUTPUT_NAMES = [
  "__smithersSignalProvenanceHorizon",
  "__smithersAgentCheckpointHorizons",
  "__smithersAgentCheckpointProvenance",
];
const RESERVED_PUBLIC_OUTPUT_NAME_SET = new Set(RESERVED_PUBLIC_OUTPUT_NAMES);

/**
 * Snapshot capture stores internal provenance metadata under these keys and
 * snapshot parsing removes it again. A public output with the same name would
 * therefore be overwritten on capture and silently discarded on parse.
 *
 * @param {Record<string, any>} schemas
 */
export function assertNoReservedPublicOutputNames(schemas) {
  for (const name of Object.keys(schemas)) {
    if (!RESERVED_PUBLIC_OUTPUT_NAME_SET.has(name)) continue;
    throw new SmithersError(
      "INVALID_INPUT",
      `Output schema name "${name}" is reserved for Smithers snapshot metadata and cannot be used as a public output name.`,
      { outputName: name, reservedOutputNames: RESERVED_PUBLIC_OUTPUT_NAMES },
    );
  }
}

/**
 * Duplicate schema objects need distinct output refs so Task `output={outputs.foo}`
 * can still resolve the intended table by identity.
 * @param {Record<string, any>} schemas
 */
export function prepareOutputSchemas(schemas) {
  assertNoReservedPublicOutputNames(schemas);
  const counts = new Map();
  for (const [name, zodSchema] of Object.entries(schemas)) {
    if (name === "input") continue;
    counts.set(zodSchema, (counts.get(zodSchema) ?? 0) + 1);
  }
  const outputs = {
    ...schemas,
  };
  const zodToKeyName = new Map();
  const ambiguousZodSchemas = new Set();
  for (const [name, zodSchema] of Object.entries(schemas)) {
    if (name === "input") continue;
    if ((counts.get(zodSchema) ?? 0) > 1) {
      ambiguousZodSchemas.add(zodSchema);
      const aliasSchema = zodSchema.clone();
      outputs[name] = aliasSchema;
      zodToKeyName.set(aliasSchema, name);
      continue;
    }
    zodToKeyName.set(zodSchema, name);
  }
  return {
    outputs,
    zodToKeyName,
    ambiguousZodSchemas,
  };
}
