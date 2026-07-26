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

/**
 * A mutable single-slot in-flight guard (the shape a React `useRef<string | null>`
 * gives you). Used as a SYNCHRONOUS duplicate-submit guard: React state updates
 * are async, so two key events processed in the same tick both read the same
 * stale `busy` state and would each fire a `submitApproval`. A ref flips
 * immediately, so the second claim in the same tick is rejected.
 */
export type InFlightRef = { current: string | null };

/**
 * Synchronously claim the in-flight slot for `key`. Returns true when the caller
 * may proceed (slot was free) and false when a submission for the SAME key is
 * already running. Must be called BEFORE starting the submit promise.
 */
export function claimInFlight(ref: InFlightRef, key: string): boolean {
  if (ref.current === key) return false;
  ref.current = key;
  return true;
}

/** Release the in-flight slot for `key` (no-op if a different key holds it). */
export function releaseInFlight(ref: InFlightRef, key: string): void {
  if (ref.current === key) ref.current = null;
}

/** Stable `${nodeId}:${iteration}` identity for in-flight + resolved tracking. */
export function approvalRowKey(row: { nodeId: string; iteration?: number }): string {
  return `${row.nodeId}:${row.iteration}`;
}

/**
 * Select the pending approval row for the focused node. Matches by node id AND
 * iteration so loops/retries resolve the request for the attempt currently in
 * view; container nodes carry no iteration, so they fall back to id-only.
 * `resolvedKeys` suppresses rows whose decision we just submitted successfully
 * but whose `refetchApprovals` hasn't landed yet — without this a fast second
 * [a]/[d] after a successful submit (the in-flight guard already released in
 * onSettled) would resubmit an already-decided gate.
 */
export function selectNodeApproval<T extends { nodeId: string; iteration?: number }>(
  approvals: readonly T[],
  focusedNode: { id: string; iteration?: number } | null | undefined,
  resolvedKeys?: ReadonlySet<string>,
): T | undefined {
  if (!focusedNode) return undefined;
  return approvals.find((a) => {
    if (a.nodeId !== focusedNode.id) return false;
    if (focusedNode.iteration !== undefined && a.iteration !== focusedNode.iteration) return false;
    if (resolvedKeys && resolvedKeys.has(approvalRowKey(a))) return false;
    return true;
  });
}

/**
 * Prune resolved-approval keys down to the ones still present in `approvals`.
 * Once a successfully-decided row actually leaves the pending set (the refetch
 * landed), we drop its key so the set can't grow unbounded or wrongly suppress a
 * brand-new approval that happens to reuse the same `nodeId:iteration`. Returns
 * the SAME set when nothing changed so a React state updater bails out without a
 * re-render.
 */
export function pruneResolvedKeys(
  resolved: ReadonlySet<string>,
  approvals: readonly { nodeId: string; iteration?: number }[],
): ReadonlySet<string> {
  if (resolved.size === 0) return resolved;
  const live = new Set(approvals.map(approvalRowKey));
  let changed = false;
  const next = new Set<string>();
  for (const k of resolved) {
    if (live.has(k)) next.add(k);
    else changed = true;
  }
  return changed ? next : resolved;
}

/**
 * Slice window for the approval banner's option list. The banner renders at
 * most `maxRows` lines; cycling wraps through ALL options, so the rendered
 * slice must follow the highlighted index or the selection walks off-screen
 * (invisible pick submitted on [a]). When the list overflows, ONE of the
 * `maxRows` lines is reserved for a "+N more" indicator (`hiddenCount` > 0)
 * so hidden entries are announced for both select and rank.
 */
export function approvalOptionWindow(
  count: number,
  selectedIdx: number,
  maxRows: number,
): { start: number; end: number; hiddenCount: number } {
  const rows = Math.max(2, maxRows);
  if (count <= rows) return { start: 0, end: count, hiddenCount: 0 };
  const visible = rows - 1; // reserve one line for the "+N more" indicator
  const sel = Math.min(Math.max(selectedIdx, 0), count - 1);
  let start = sel - visible + 1;
  if (start < 0) start = 0;
  if (start > count - visible) start = count - visible;
  return { start, end: start + visible, hiddenCount: count - visible };
}

/** An approval-banner control action routed from a raw key. */
export type ApprovalKeyAction = { kind: "approve" } | { kind: "deny" } | { kind: "cycle"; dir: 1 | -1 };

/**
 * Route a raw key to an approval-banner action, INDEPENDENT of which pane (tree
 * or inspector) is focused. The approval banner advertises `a`/`d` (approve/deny)
 * and `[`/`]` (cycle a select's options) and renders inside the inspector, so
 * those controls must fire wherever focus sits — the caller invokes this before
 * any pane-specific early return. Returns null when the key isn't an approval
 * control, or the action isn't currently allowed: no pending approval, a human
 * request (resolved only via the CLI), a submit already in flight (`busy`), or
 * option-cycling in a mode without a per-option pick (only `select` has one —
 * gate has no options and rank submits the listed order).
 */
export function routeApprovalKey(
  key: string,
  ctx: { hasApproval: boolean; isHumanRequest: boolean; mode: ApprovalMode; busy: boolean },
): ApprovalKeyAction | null {
  if (!ctx.hasApproval || ctx.isHumanRequest) return null;
  const normalizedKey = key.length === 1 ? key.toLowerCase() : key;
  if ((normalizedKey === "[" || normalizedKey === "]") && ctx.mode === "select") {
    return { kind: "cycle", dir: normalizedKey === "]" ? 1 : -1 };
  }
  if (ctx.busy) return null;
  if (normalizedKey === "a") return { kind: "approve" };
  if (normalizedKey === "d") return { kind: "deny" };
  return null;
}

/**
 * Drive one approval submission's side effects in a fixed order, pure of React:
 * await `submit()`, and ONLY on success run `onSuccess` (the approvals refetch
 * that clears the resolved gate's banner so a second [a]/[d] can't resubmit a
 * decided request); a rejection routes to `onError` instead. `onSettled` always
 * runs last (clears the in-flight guard). `onSuccess`/`onError` are isolated so a
 * refetch failure can't surface as a submit error. Extracted so the
 * submit→refetch ordering is unit-testable without a live gateway.
 */
export async function runApprovalSubmit(args: {
  submit: () => Promise<unknown>;
  onSuccess: () => void;
  onError: (err: unknown) => void;
  onSettled: () => void;
}): Promise<void> {
  try {
    await args.submit();
    try {
      args.onSuccess();
    } catch {
      // a refetch failure must not be reported as a submit failure
    }
  } catch (err) {
    args.onError(err);
  } finally {
    args.onSettled();
  }
}
