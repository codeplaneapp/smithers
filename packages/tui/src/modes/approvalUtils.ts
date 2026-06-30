/**
 * Approval decision helpers shared by the Tree inspector and its tests.
 *
 * The gateway's `submitApproval` RPC takes `decision: { approved, value?, note? }`
 * and (for an approve) forwards `decision.value` to the engine, which serializes
 * it to the approval's `decisionJson`. The workflow side then reads
 * `decision.selected` (select) / `decision.ranked` (rank) off that JSON. So the
 * mode-specific payload MUST be nested under `value`:
 *   - gate / decision → `{ approved }`
 *   - select          → `{ approved: true, value: { selected: <key> } }`
 *   - rank            → `{ approved: true, value: { ranked: [<keys…>] } }`
 *   - deny (any mode) → `{ approved: false }`
 * Sending the bare key (or a flat `{ selected }`) would be silently dropped or
 * rejected by the gateway's `validateApprovalDecision`, so these helpers build
 * the exact shape the gateway validates and stores.
 */

export type ApprovalMode = "gate" | "decision" | "select" | "rank";

export type ApprovalOption = { key: string; label: string };

/** Normalize the gateway's free-form `approvalMode` to a known mode (defaults to gate). */
export function approvalModeOf(raw: unknown): ApprovalMode {
  return raw === "select" || raw === "rank" || raw === "decision" ? raw : "gate";
}

/** True for modes that present a list of options to pick/order (select, rank). */
export function modeHasOptions(mode: ApprovalMode): boolean {
  return mode === "select" || mode === "rank";
}

/**
 * Normalize the gateway's `options` (typed `unknown`) into `{ key, label }[]`.
 * Tolerates rows that carry only a `key` (label falls back to the key) and drops
 * anything without a string key.
 */
export function approvalOptionsOf(raw: unknown): ApprovalOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ApprovalOption[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const key = typeof rec["key"] === "string" ? rec["key"] : undefined;
      if (!key) continue;
      const label = typeof rec["label"] === "string" ? rec["label"] : key;
      out.push({ key, label });
    } else if (typeof entry === "string") {
      out.push({ key: entry, label: entry });
    }
  }
  return out;
}

export type ApprovalDecision = {
  approved: boolean;
  value?: { selected: string } | { ranked: string[] };
};

/**
 * Build the `decision` payload for `submitApproval`. `approved=false` is a plain
 * deny regardless of mode. For an approve, select nests `{ selected }` and rank
 * nests `{ ranked }` under `value`; gate/decision carry no value. Returns null
 * when a select approve has no chosen option (caller must not submit a select
 * with an empty/invalid selection — the gateway would reject it).
 */
export function buildApprovalDecision(
  mode: ApprovalMode,
  approved: boolean,
  options: readonly ApprovalOption[],
  selectedKey: string | null,
): ApprovalDecision | null {
  if (!approved) return { approved: false };
  if (mode === "select") {
    if (!selectedKey || !options.some((o) => o.key === selectedKey)) return null;
    return { approved: true, value: { selected: selectedKey } };
  }
  if (mode === "rank") {
    if (options.length === 0) return null;
    return { approved: true, value: { ranked: options.map((o) => o.key) } };
  }
  return { approved: true };
}
