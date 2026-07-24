/**
 * Render the mandatory effect-boundary summary for human CLI output.
 *
 * @param {{ blocking?: unknown[]; revertible?: unknown[]; warnings?: unknown[] } | null | undefined} report
 * @returns {string}
 */
export function renderEffectBoundaryReport(report) {
  const normalized = report ?? { blocking: [], revertible: [], warnings: [] };
  const rows = [
    ...(normalized.blocking ?? []).map((effect) => ({
      effect,
      disposition: effect.reason?.startsWith("Forced crossing")
        ? effect.reason
        : effect.reason
          ? `blocked: ${effect.reason}`
          : "blocked",
    })),
    ...(normalized.revertible ?? []).map((effect) => ({ effect, disposition: effect.reason ?? "reverted" })),
    ...(normalized.warnings ?? []).map((effect) => ({ effect, disposition: effect.reason ?? "warning" })),
  ];
  if (rows.length === 0) return "Effect boundary: clean (0 crossed effects)\n";
  const lines = ["Effect boundary:"];
  for (const { effect, disposition } of rows) {
    const kind = effect?.kind ?? "tool";
    const name = kind === "task" ? effect?.nodeId : effect?.toolName;
    lines.push(
      `  ${kind} ${name ?? "unknown"} node=${effect?.nodeId ?? "unknown"} ` +
      `status=${effect?.effectStatus ?? "unknown"} disposition=${disposition}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
