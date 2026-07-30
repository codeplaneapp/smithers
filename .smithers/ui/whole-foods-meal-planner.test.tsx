/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as gatewayReact from "@smithers-orchestrator/gateway-react";

GlobalRegistrator.register();
const reactTestEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

let mockedOutputs: Record<string, unknown> = {};

mock.module("smithers-orchestrator/gateway-react", () => ({
  ...gatewayReact,
  createGatewayReactRoot: () => {},
  useGatewayNodeOutput: ({ nodeId }: { nodeId?: string }) => ({
    data: nodeId ? mockedOutputs[nodeId] : undefined,
    refetch: async () => {},
  }),
  useGatewayRun: () => ({ data: undefined, refetch: async () => {} }),
}));

const { GroceryChecklist, MealCards, OrderStatus, isHttpUrl } = await import("./whole-foods-meal-planner");

const runId = "run-wfm-test";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  mockedOutputs = {};
  host = document.createElement("div");
  document.body.replaceChildren(host);
  root = createRoot(host);
});

afterEach(async () => await act(async () => root.unmount()));

afterAll(() => {
  if (previousActEnvironment === undefined) delete reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;
  else reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  GlobalRegistrator.unregister();
});

describe("whole-foods-meal-planner UI link safety", () => {
  test("isHttpUrl only allows http(s) schemes", () => {
    expect(isHttpUrl("https://www.wholefoodsmarket.com/search?text=berries")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isHttpUrl("//evil.example/path")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });

  test("MealCards renders javascript: sourceUrl as text, not a link", async () => {
    mockedOutputs["plan-meals"] = {
      plan: [
        {
          day: 1,
          dailyTotalCalories: 500,
          meals: [
            {
              name: "Breakfast",
              totalCalories: 500,
              memberCalories: [],
              items: [
                {
                  name: "Safe berries",
                  quantity: "1 cup",
                  estimatedCalories: 100,
                  sourceUrl: "https://www.wholefoodsmarket.com/search?text=berries",
                  prepMinutes: 0,
                  prepTag: "raw",
                  favoriteMatch: false,
                },
                {
                  name: "Evil yogurt",
                  quantity: "1 cup",
                  estimatedCalories: 400,
                  sourceUrl: "javascript:alert(1)",
                  prepMinutes: 0,
                  prepTag: "ready-to-eat",
                  favoriteMatch: false,
                },
              ],
            },
          ],
        },
      ],
    };
    await act(async () => root.render(<MealCards runId={runId} />));

    const anchors = Array.from(host.querySelectorAll("a"));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute("href")).toBe("https://www.wholefoodsmarket.com/search?text=berries");
    expect(host.textContent).toContain("Evil yogurt");
    expect(host.textContent).toContain("javascript:alert(1)");
  });

  test("GroceryChecklist renders javascript: sourceUrl as text, not a link", async () => {
    mockedOutputs["plan-meals"] = {
      groceryList: [
        {
          name: "Safe berries",
          quantity: "1",
          packageSize: "16 oz",
          estimatedPriceUsd: 5,
          estimatedCalories: 100,
          sourceUrl: "https://www.wholefoodsmarket.com/search?text=berries",
          storeSection: "produce",
          prepTag: "raw",
          favoriteMatch: false,
        },
        {
          name: "Evil greens",
          quantity: "1",
          packageSize: "5 oz",
          estimatedPriceUsd: 4,
          estimatedCalories: 50,
          sourceUrl: "javascript:alert(1)",
          storeSection: "produce",
          prepTag: "raw",
          favoriteMatch: false,
        },
      ],
    };
    await act(async () => root.render(<GroceryChecklist runId={runId} />));

    const anchors = Array.from(host.querySelectorAll("a"));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute("href")).toBe("https://www.wholefoodsmarket.com/search?text=berries");
    expect(host.textContent).toContain("javascript:alert(1)");
  });

  test("OrderStatus renders javascript: checkout URLs as text, not links", async () => {
    mockedOutputs.finalize = {
      orderStatus: "needs-checkout",
      links: [
        {
          name: "Mixed order",
          wholeFoodsUrl: "javascript:alert(1)",
          amazonUrl: "https://www.amazon.com/dp/B089PMTQ67",
        },
        {
          name: "Safe order",
          wholeFoodsUrl: "https://www.wholefoodsmarket.com/cart",
          amazonUrl: "javascript:alert(2)",
        },
      ],
    };
    await act(async () => root.render(<OrderStatus runId={runId} />));

    const hrefs = Array.from(host.querySelectorAll("a")).map((anchor) => anchor.getAttribute("href"));
    expect(hrefs).toEqual(["https://www.amazon.com/dp/B089PMTQ67", "https://www.wholefoodsmarket.com/cart"]);
    expect(host.textContent).toContain("javascript:alert(1)");
    expect(host.textContent).toContain("javascript:alert(2)");
  });
});
