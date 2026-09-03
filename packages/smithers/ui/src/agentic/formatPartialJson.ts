/**
 * Pretty-print possibly-partial streaming JSON. On a successful parse the
 * value is reprinted with two-space indentation and `complete: true`; on any
 * parse failure the raw fragment is returned VERBATIM with `complete: false`
 * -- never repaired, never re-quoted.
 */
export function formatPartialJson(text: string): { text: string; complete: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), complete: true };
  } catch {
    return { text, complete: false };
  }
}
