import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_MONITOR_PATH, MonitorButton, monitorHref } from "../src/MonitorButton";

// Pure component + helper tests — MonitorButton is just a styled anchor with no
// gateway dependency, so it renders with renderToStaticMarkup (no DOM, no
// provider) exactly like the other pure-component tests.

describe("monitorHref", () => {
  test("deep-links the runId via ?runId and stays relative without an origin", () => {
    expect(monitorHref("run-123", { baseUrl: "" })).toBe("/monitor?runId=run-123");
    expect(monitorHref(undefined, { baseUrl: "" })).toBe("/monitor");
    expect(DEFAULT_MONITOR_PATH).toBe("/monitor");
  });

  test("resolves against an explicit gateway origin and encodes the runId", () => {
    expect(monitorHref("run-xyz", { baseUrl: "https://gw.example" })).toBe("https://gw.example/monitor?runId=run-xyz");
    expect(monitorHref("a b/c", { baseUrl: "https://gw.example" })).toBe("https://gw.example/monitor?runId=a%20b%2Fc");
  });

  test("honors a custom monitor mount path", () => {
    expect(monitorHref("r", { baseUrl: "https://gw.example", monitorPath: "/ops/monitor" })).toBe(
      "https://gw.example/ops/monitor?runId=r",
    );
  });
});

describe("MonitorButton", () => {
  test("renders an anchor to the monitor deep-linked to the run, opening a new tab", () => {
    const html = renderToStaticMarkup(
      createElement(MonitorButton, { runId: "run-xyz", baseUrl: "https://gw.example" }),
    );
    expect(html).toContain('href="https://gw.example/monitor?runId=run-xyz"');
    expect(html).toContain("Open Monitor");
    expect(html).toContain('target="_blank"');
    expect(html).toContain("monitor-button");
  });

  test("supports a custom label and same-tab navigation", () => {
    const html = renderToStaticMarkup(
      createElement(MonitorButton, { runId: "r", baseUrl: "", newTab: false }, "Run fleet"),
    );
    expect(html).toContain("Run fleet");
    expect(html).toContain('href="/monitor?runId=r"');
    expect(html).not.toContain('target="_blank"');
  });

  test("links to the monitor index when no run is selected", () => {
    const html = renderToStaticMarkup(createElement(MonitorButton, { baseUrl: "" }));
    expect(html).toContain('href="/monitor"');
  });
});
