export function normalizeState(raw: string | undefined) {
  return (raw ?? "unknown").trim().toLowerCase().replace(/[_\s]/g, "-");
}
