/**
 * Read an output-row column that holds an array. loadOutputs returns json-mode
 * columns already parsed (an array); the raw sqlite path and older rows can
 * still surface a JSON string, so accept both shapes. Anything else yields [].
 */
export function parseJsonColumn<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
