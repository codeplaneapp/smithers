// Chart adapter under renderToStaticMarkup: recharts does not paint without a
// measured container, so these tests assert the parsed model — palette slots,
// CSS-var wiring, and the tooltip/legend content components — the same
// convention as the other heavy-widget adapters.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BarChart, Bar } from "recharts";
import {
  CHART_SERIES,
  ChartContainer,
  ChartLegendContent,
  ChartProvider,
  ChartTooltipContent,
  chartConfig,
  chartSeriesColor,
} from "../src/adapters/chart";

describe("chart palette", () => {
  test("series slots are assigned in fixed order and clamp past the palette", () => {
    expect(chartSeriesColor(0, "light")).toBe("#2a78d6");
    expect(chartSeriesColor(0, "dark")).toBe("#3987e5");
    expect(chartSeriesColor(1, "light")).toBe("#eb6834");
    expect(chartSeriesColor(99, "light")).toBe(CHART_SERIES.at(-1)!.light);
    expect(chartSeriesColor(-1, "light")).toBe(CHART_SERIES[0]!.light);
  });

  test("chartConfig maps keys to palette slots in order with both theme steps", () => {
    const config = chartConfig([{ key: "landed", label: "Landed" }, { key: "inflight" }]);
    expect(config.landed).toMatchObject({ label: "Landed", theme: { light: "#2a78d6", dark: "#3987e5" } });
    expect(config.inflight).toMatchObject({ label: "inflight", theme: { light: "#eb6834", dark: "#d95926" } });
  });
});

describe("<ChartContainer>", () => {
  test("renders the chart slot with per-series CSS vars and recessive chrome", () => {
    const config = chartConfig([{ key: "commits" }, { key: "files" }]);
    const html = renderToStaticMarkup(
      <ChartContainer id="release" config={config}>
        <BarChart width={400} height={200} data={[{ area: "ui", commits: 4, files: 9 }]}>
          <Bar dataKey="commits" fill="var(--color-commits)" />
        </BarChart>
      </ChartContainer>,
    );
    expect(html).toContain('data-slot="chart"');
    expect(html).toContain('data-chart="chart-release"');
    // Server render resolves the light theme; the vars carry the palette slots.
    expect(html).toContain("--color-commits: #2a78d6");
    expect(html).toContain("--color-files: #eb6834");
    // Recessive chrome restated in tokens, never series color on text.
    expect(html).toContain(".recharts-cartesian-axis-tick text");
  });
});

describe("<ChartTooltipContent>", () => {
  const config = chartConfig([
    { key: "landed", label: "Landed" },
    { key: "inflight", label: "In flight" },
  ]);

  test("renders config labels, indicator swatches, and formatted values", () => {
    const html = renderToStaticMarkup(
      <ChartProvider config={config}>
        <ChartTooltipContent
          active
          label="critical"
          payload={[
            { dataKey: "landed", value: 1234, color: "#2a78d6" },
            { dataKey: "inflight", value: 2, color: "#eb6834" },
          ]}
        />
      </ChartProvider>,
    );
    expect(html).toContain("Landed");
    expect(html).toContain("In flight");
    expect(html).toContain("1,234");
    expect(html).toContain("background:#2a78d6");
    expect(html).toContain("critical");
  });

  test("renders nothing when inactive or empty", () => {
    const idle = renderToStaticMarkup(
      <ChartProvider config={config}>
        <ChartTooltipContent active={false} payload={[{ dataKey: "landed", value: 1 }]} />
      </ChartProvider>,
    );
    expect(idle).toBe("");
    const empty = renderToStaticMarkup(
      <ChartProvider config={config}>
        <ChartTooltipContent active payload={[]} />
      </ChartProvider>,
    );
    expect(empty).toBe("");
  });

  test("throws outside a chart provider", () => {
    expect(() => renderToStaticMarkup(<ChartTooltipContent active payload={[{ value: 1 }]} />)).toThrow(
      "useChart must be used within a <ChartContainer />",
    );
  });
});

describe("<ChartLegendContent>", () => {
  test("renders one swatch + label per series from the config", () => {
    const config = chartConfig([
      { key: "landed", label: "Landed" },
      { key: "inflight", label: "In flight" },
    ]);
    const html = renderToStaticMarkup(
      <ChartProvider config={config}>
        <ChartLegendContent
          payload={[
            { dataKey: "landed", value: "landed", color: "#2a78d6" },
            { dataKey: "inflight", value: "inflight", color: "#eb6834" },
          ]}
        />
      </ChartProvider>,
    );
    expect(html).toContain('data-slot="chart-legend"');
    expect(html).toContain("Landed");
    expect(html).toContain("In flight");
    expect(html).toContain("background:#2a78d6");
    expect(html).toContain("background:#eb6834");
  });
});
