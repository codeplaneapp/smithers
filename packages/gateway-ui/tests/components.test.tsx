import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusPill } from "../src/StatusPill";
import { statusColor } from "../src/theme";

/**
 * Pure-component + helper tests. These render with `renderToStaticMarkup` (no
 * DOM, no gateway context) so they run on CI's headless box. The hook-driven
 * components (RunList, RunTree, ApprovalPanel, …) require the live gateway
 * collection provider and are exercised by gateway-react integration tests and
 * the real-backend e2e, not here.
 */
describe("statusColor", () => {
  test("maps known statuses to accent colors", () => {
    expect(statusColor("running")).toBe("#4a78ff");
    expect(statusColor("ok")).toBe("#3fb950");
    expect(statusColor("failed")).toBe("#f85149");
    expect(statusColor("waiting")).toBe("#d29922");
  });

  test("is case-insensitive and falls back to neutral", () => {
    expect(statusColor("RUNNING")).toBe("#4a78ff");
    expect(statusColor("something-unknown")).toBe("#9aa3b2");
    expect(statusColor(undefined)).toBe("#9aa3b2");
  });
});

describe("StatusPill", () => {
  test("renders the title-cased status and carries a data-status attr", () => {
    const html = renderToStaticMarkup(<StatusPill status="waiting-approval" />);
    expect(html).toContain("Waiting Approval");
    expect(html).toContain('data-status="waiting-approval"');
  });

  test("honors an explicit label override", () => {
    const html = renderToStaticMarkup(<StatusPill status="ok" label="Done" />);
    expect(html).toContain("Done");
  });
});
