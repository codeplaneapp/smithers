import { describe, expect, test } from "bun:test";
import { parseTicketFleetDispositionRows, ticketFleetDisposition, type TicketFleetLaneFacts } from "../lib/ticketFleetDisposition";

const lane = (issueNumber: number, overrides: Partial<TicketFleetLaneFacts> = {}): TicketFleetLaneFacts => ({
  issueNumber,
  landed: false,
  simulated: false,
  evictionCount: 0,
  ...overrides,
});

describe("ticketFleetDisposition", () => {
  test("hydrates and validates DB JSON disposition rows", () => {
    const value = JSON.stringify([
      { issueNumber: 40, kind: "landed", reason: "Landed on main.", terminal: true },
      { issueNumber: 41, kind: "unlanded", reason: "No push occurred.", terminal: true },
      { issueNumber: "invalid", kind: "landed", reason: "bad", terminal: true },
    ]);

    expect(parseTicketFleetDispositionRows(value)).toEqual([
      { issueNumber: 40, kind: "landed", reason: "Landed on main.", terminal: true },
      { issueNumber: 41, kind: "unlanded", reason: "No push occurred.", terminal: true },
    ]);
    expect(parseTicketFleetDispositionRows("not-json")).toEqual([]);
  });

  test("accounts for all 17 selected issues when only four land", () => {
    const landed = new Set([564, 594, 632, 789]);
    const issueNumbers = [564, 594, 632, 789, 801, 802, 803, 804, 805, 806, 807, 808, 809, 810, 811, 812, 813];
    const result = ticketFleetDisposition(issueNumbers.map((issueNumber) => landed.has(issueNumber)
      ? lane(issueNumber, { landed: true, landedSha: `sha-${issueNumber}`, readiness: { ready: true } })
      : lane(issueNumber, { readiness: { ready: false, reason: `#${issueNumber} failed readiness` } })), {
      maxEvictions: 2,
      finalizeUnresolved: true,
    });

    expect(result.counts).toEqual({
      selected: 17,
      accounted: 17,
      terminal: 17,
      landed: 4,
      parked: 0,
      failedReadiness: 13,
      unlanded: 0,
      pending: 0,
    });
    expect(result.rows).toHaveLength(17);
    expect(result.rows.filter((row) => row.kind === "failed-readiness")).toHaveLength(13);
    expect(result.successful).toBe(false);
    expect(result.allTerminal).toBe(true);
  });

  test("parks a lane only after it reaches the eviction limit", () => {
    const result = ticketFleetDisposition([
      lane(41, { readiness: { ready: true }, evictionCount: 2 }),
    ], { maxEvictions: 2, finalizeUnresolved: false });

    expect(result.rows).toEqual([{
      issueNumber: 41,
      kind: "parked",
      reason: "Parked after 2 merge-train evictions.",
      terminal: true,
    }]);
    expect(result.counts.parked).toBe(1);
    expect(result.allTerminal).toBe(true);
    expect(result.successful).toBe(false);
  });

  test("records a denied required approval as terminal unlanded", () => {
    const result = ticketFleetDisposition([
      lane(42, {
        readiness: { ready: true },
        needsApproval: true,
        approval: { approved: false, reason: "Risk owner declined the merge." },
      }),
    ], { maxEvictions: 2, finalizeUnresolved: false });

    expect(result.rows[0]).toEqual({
      issueNumber: 42,
      kind: "unlanded",
      reason: "Risk owner declined the merge.",
      terminal: true,
    });
    expect(result.counts.unlanded).toBe(1);
    expect(result.allTerminal).toBe(true);
  });

  test("settles a simulated dry-run landing without counting it as landed", () => {
    const result = ticketFleetDisposition([
      lane(43, {
        readiness: { ready: true },
        simulated: true,
        landedSha: "simulated-43",
      }),
    ], { maxEvictions: 2, finalizeUnresolved: false });

    expect(result.rows).toEqual([{
      issueNumber: 43,
      kind: "unlanded",
      reason: "Dry run simulated a merge-train landing at simulated-43; no push to main occurred.",
      terminal: true,
    }]);
    expect(result.counts).toMatchObject({ landed: 0, unlanded: 1, pending: 0 });
    expect(result.allTerminal).toBe(true);
    expect(result.successful).toBe(false);
  });

  test("actual landing outranks contradictory simulated provenance", () => {
    const result = ticketFleetDisposition([
      lane(44, { landed: true, simulated: true, landedSha: "actual-44" }),
    ], { maxEvictions: 2, finalizeUnresolved: false });

    expect(result.rows[0]).toMatchObject({ kind: "landed", terminal: true });
    expect(result.counts).toMatchObject({ landed: 1, unlanded: 0 });
    expect(result.successful).toBe(true);
  });

  test("keeps unresolved lanes pending until final accounting", () => {
    const selected = [
      lane(50),
      lane(51, { readiness: { ready: true } }),
      lane(52, { readiness: { ready: true }, needsApproval: true }),
    ];
    const active = ticketFleetDisposition(selected, { maxEvictions: 2, finalizeUnresolved: false });
    const final = ticketFleetDisposition(selected, { maxEvictions: 2, finalizeUnresolved: true });

    expect(active.rows.map((row) => row.kind)).toEqual(["pending", "pending", "pending"]);
    expect(active.rows.map((row) => row.terminal)).toEqual([false, false, false]);
    expect(active.counts.pending).toBe(3);
    expect(active.allTerminal).toBe(false);

    expect(final.rows.map((row) => row.kind)).toEqual(["unlanded", "unlanded", "unlanded"]);
    expect(final.rows.map((row) => row.terminal)).toEqual([true, true, true]);
    expect(final.counts.unlanded).toBe(3);
    expect(final.counts.pending).toBe(0);
    expect(final.allTerminal).toBe(true);
    expect(final.successful).toBe(false);
  });
});
