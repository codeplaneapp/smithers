/** Serialize untrusted prompt metadata as one physical JSON line.
 * JSON permits C1 controls and U+2028/U+2029 unescaped, but model transports
 * and renderers may still treat them as control or line boundaries. Escape
 * them explicitly so a record's structure is stable end to end. */
export function promptJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("prompt JSON value is not serializable");
  return serialized.replace(/[\u007f-\u009f\u2028\u2029]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  ));
}
