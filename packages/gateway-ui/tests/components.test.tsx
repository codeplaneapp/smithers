import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusPill } from "../src/StatusPill";
import { statusClass, statusColor } from "../src/theme";

/**
 * Pure-component + helper tests. These render with `renderToStaticMarkup` (no
 * DOM, no gateway context) so they run on CI's headless box. The hook-driven
 * components (RunList, RunTree, ApprovalPanel, …) require a live
 * `SyncProvider`/gateway and are exercised by the gateway-react integration
 * suite and the real-backend e2e, not here.
 */
describe("statusColor", () => {
  test("maps known statuses to accent colors", () => {
    expect(statusColor("running")).toBe("#bf7100");
    expect(statusColor("ok")).toBe("#0f8f78");
    expect(statusColor("failed")).toBe("#e5484d");
    expect(statusColor("waiting")).toBe("#bf7100");
  });

  test("is case-insensitive and falls back to neutral", () => {
    expect(statusColor("RUNNING")).toBe("#bf7100");
    expect(statusColor("something-unknown")).toBe("#525252");
    expect(statusColor(undefined)).toBe("#525252");
  });
});

describe("statusClass", () => {
  test("treats terminal cancellation as neutral", () => {
    expect(statusClass("cancelled")).toBe("muted");
    expect(statusClass("skipped")).toBe("muted");
  });
});

describe("StatusPill", () => {
  test("renders the title-cased status and carries a data-status attr", () => {
    const html = renderToStaticMarkup(<StatusPill status="waiting-approval" />);
    expect(html).toContain("Waiting for approval");
    expect(html).toContain('data-status="waiting-approval"');
  });

  test("honors an explicit label override", () => {
    const html = renderToStaticMarkup(<StatusPill status="ok" label="Done" />);
    expect(html).toContain("Done");
  });
});
