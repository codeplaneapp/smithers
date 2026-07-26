export type TicketFleetLaneFacts = {
  issueNumber: number;
  readiness?: {
    ready: boolean;
    reason?: string | null;
  };
  approval?: {
    approved: boolean;
    reason?: string | null;
  };
  needsApproval?: boolean;
  landed: boolean;
  simulated: boolean;
  landedSha?: string | null;
  evictionCount: number;
};

export type TicketFleetDispositionKind = "landed" | "parked" | "failed-readiness" | "unlanded" | "pending";

export type TicketFleetDispositionRow = {
  issueNumber: number;
  kind: TicketFleetDispositionKind;
  reason: string;
  terminal: boolean;
};

export type TicketFleetDispositionAccounting = {
  rows: TicketFleetDispositionRow[];
  counts: {
    selected: number;
    accounted: number;
    terminal: number;
    landed: number;
    parked: number;
    failedReadiness: number;
    unlanded: number;
    pending: number;
  };
  allTerminal: boolean;
  successful: boolean;
};

const dispositionKinds = new Set<TicketFleetDispositionKind>([
  "landed",
  "parked",
  "failed-readiness",
  "unlanded",
  "pending",
]);

export function parseTicketFleetDispositionRows(value: unknown): TicketFleetDispositionRow[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  const rows: TicketFleetDispositionRow[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    if (!Number.isInteger(row.issueNumber)) continue;
    if (typeof row.kind !== "string" || !dispositionKinds.has(row.kind as TicketFleetDispositionKind)) continue;
    if (typeof row.reason !== "string" || typeof row.terminal !== "boolean") continue;
    rows.push({
      issueNumber: row.issueNumber as number,
      kind: row.kind as TicketFleetDispositionKind,
      reason: row.reason,
      terminal: row.terminal,
    });
  }
  return rows;
}

function reason(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

function classifyLane(
  lane: TicketFleetLaneFacts,
  maxEvictions: number,
  finalizeUnresolved: boolean,
): TicketFleetDispositionRow {
  if (lane.landed) {
    const sha = lane.landedSha?.trim();
    return {
      issueNumber: lane.issueNumber,
      kind: "landed",
      reason: sha ? `Landed on main at ${sha}.` : "Landed on main.",
      terminal: true,
    };
  }

  if (lane.simulated) {
    const sha = lane.landedSha?.trim();
    return {
      issueNumber: lane.issueNumber,
      kind: "unlanded",
      reason: sha
        ? `Dry run simulated a merge-train landing at ${sha}; no push to main occurred.`
        : "Dry run simulated a merge-train landing; no push to main occurred.",
      terminal: true,
    };
  }

  if (lane.readiness?.ready === false) {
    return {
      issueNumber: lane.issueNumber,
      kind: "failed-readiness",
      reason: reason(lane.readiness.reason, "Readiness did not pass."),
      terminal: true,
    };
  }

  if (lane.evictionCount >= maxEvictions) {
    return {
      issueNumber: lane.issueNumber,
      kind: "parked",
      reason: `Parked after ${lane.evictionCount} merge-train eviction${lane.evictionCount === 1 ? "" : "s"}.`,
      terminal: true,
    };
  }

  if (lane.needsApproval && lane.approval?.approved === false) {
    return {
      issueNumber: lane.issueNumber,
      kind: "unlanded",
      reason: reason(lane.approval.reason, "Merge approval was denied."),
      terminal: true,
    };
  }

  let pendingReason = "Readiness has not completed.";
  if (lane.readiness?.ready === true) {
    pendingReason =
      lane.needsApproval && !lane.approval
        ? "Merge approval is pending."
        : "Ready candidate is awaiting merge-train landing.";
  }

  return {
    issueNumber: lane.issueNumber,
    kind: finalizeUnresolved ? "unlanded" : "pending",
    reason: pendingReason,
    terminal: finalizeUnresolved,
  };
}

export function ticketFleetDisposition(
  selectedLanes: readonly TicketFleetLaneFacts[],
  options: { maxEvictions: number; finalizeUnresolved: boolean },
): TicketFleetDispositionAccounting {
  const maxEvictions = Math.max(1, Math.floor(options.maxEvictions));
  const rows = [...selectedLanes]
    .sort((left, right) => left.issueNumber - right.issueNumber)
    .map((lane) => classifyLane(lane, maxEvictions, options.finalizeUnresolved));
  const count = (kind: TicketFleetDispositionKind) => rows.filter((row) => row.kind === kind).length;
  const counts = {
    selected: selectedLanes.length,
    accounted: rows.length,
    terminal: rows.filter((row) => row.terminal).length,
    landed: count("landed"),
    parked: count("parked"),
    failedReadiness: count("failed-readiness"),
    unlanded: count("unlanded"),
    pending: count("pending"),
  };

  return {
    rows,
    counts,
    allTerminal: rows.length > 0 && rows.every((row) => row.terminal),
    successful: rows.length > 0 && rows.every((row) => row.kind === "landed"),
  };
}
