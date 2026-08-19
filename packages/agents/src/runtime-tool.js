/** @param {Record<string, unknown>} schema @param {{ validate?: (value: unknown) => Promise<unknown> }} [options] */
export const jsonSchema = (schema, options = {}) => ({ jsonSchema: schema, ...options });
/** @param {unknown} schema */
export const zodSchema = (schema) => schema;
/** @template T @param {T} definition @returns {T} */
export const dynamicTool = (definition) => definition;
/** @template T @param {T} definition @returns {T} */
export const tool = (definition) => definition;
