/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow, runTask } from "smithers-orchestrator/testing";
import {
  calculatePlanCalories,
  groupByStoreSection,
  householdDailyCalorieTarget,
  normalizeFavorites,
  parseMemberCalorieTargets,
  updateCalorieTarget,
} from "../lib/wholeFoodsMealPlanner";
import { handleMcpRequest } from "../lib/whole-foods-meal-planner-mcp";
import workflow from "../workflows/whole-foods-meal-planner";

type Task = {
  nodeId: string;
  outputSchema?: { safeParse(value: unknown): { success: boolean } };
  sideEffect?: unknown;
  retries?: number;
  [key: string]: unknown;
};

type Frame = { tasks: readonly Task[] };

const workflowPath = join(import.meta.dir, "..", "workflows", "whole-foods-meal-planner.tsx");
const input = {
  householdSize: 1,
  days: 1,
  dailyCalorieTarget: 2_000,
  requestedDailyCalorieTarget: null,
  calorieProfiles: "",
  dietaryPreferences: "",
  favoriteFoods: "berries, rotisserie chicken",
  allergiesExclusions: "",
  maxPrepMinutes: 15,
  budget: 100,
  zipCode: "94107",
  revisionPrompt: "",
  priorPlanJson: "",
  orderWebhookUrl: "https://orders.example.test/whole-foods",
  requireOrderApproval: false,
  deliveryOnly: false,
};

const plan = {
  summary: "One-day prepared-food plan.",
  plan: [
    {
      day: 1,
      meals: [
        {
          name: "Berry breakfast",
          items: [
            {
              name: "Berries",
              quantity: "2 cups",
              estimatedCalories: 200,
              sourceUrl: "https://www.wholefoodsmarket.com/search?text=berries",
              prepMinutes: 0,
              prepTag: "raw",
              favoriteMatch: true,
            },
            {
              name: "Greek yogurt",
              quantity: "2 cups",
              estimatedCalories: 300,
              sourceUrl: "https://www.wholefoodsmarket.com/search?text=greek%20yogurt",
              prepMinutes: 0,
              prepTag: "ready-to-eat",
              favoriteMatch: false,
            },
          ],
          totalCalories: 500,
        },
        {
          name: "Prepared lunch and dinner",
          items: [
            {
              name: "Rotisserie chicken",
              quantity: "1 package",
              estimatedCalories: 1_000,
              sourceUrl: "https://www.wholefoodsmarket.com/search?text=rotisserie%20chicken",
              prepMinutes: 0,
              prepTag: "prepared",
              favoriteMatch: true,
            },
            {
              name: "Prepared vegetables",
              quantity: "2 trays",
              estimatedCalories: 500,
              sourceUrl: "https://www.wholefoodsmarket.com/search?text=prepared%20vegetables",
              prepMinutes: 5,
              prepTag: "quick-prep",
              favoriteMatch: false,
            },
          ],
          totalCalories: 1_500,
        },
      ],
      dailyTotalCalories: 2_000,
    },
  ],
  groceryList: [
    {
      name: "Berries",
      quantity: "1",
      packageSize: "16 oz",
      estimatedPriceUsd: 50,
      estimatedCalories: 200,
      sourceUrl: "https://www.wholefoodsmarket.com/search?text=berries",
      storeSection: "produce",
      prepTag: "raw",
      favoriteMatch: true,
    },
  ],
  estimatedSubtotal: 50,
  dailyCalorieTotals: [2_000],
  disclaimers: ["Calorie and price values are estimates."],
  unavailableData: [],
};

const couplePlan = {
  summary: "Delivery-only plan with person-specific calorie allocations.",
  plan: [
    {
      day: 1,
      meals: [
        {
          name: "Breakfast",
          items: [
            {
              name: "Almond milk breakfast bundle",
              quantity: "2 servings",
              estimatedCalories: 1_200,
              sourceUrl: "https://www.amazon.com/365-Everyday-Value-Original-Unsweetened/dp/B074H6M4LN",
              prepMinutes: 0,
              prepTag: "ready-to-eat",
              favoriteMatch: true,
            },
          ],
          totalCalories: 1_200,
          memberCalories: [
            { name: "You", estimatedCalories: 700 },
            { name: "Wife", estimatedCalories: 500 },
          ],
        },
        {
          name: "Packaged soup lunch",
          items: [
            {
              name: "Packaged Thai curry soup bundle",
              quantity: "2 servings plus sides",
              estimatedCalories: 2_200,
              sourceUrl:
                "https://www.wholefoodsmarket.com/grocery/product/kettle-fire-thai-curry-soup-with-bone-broth-169-oz-b07fyjmllw",
              prepMinutes: 5,
              prepTag: "prepared",
              favoriteMatch: true,
            },
          ],
          totalCalories: 2_200,
          memberCalories: [
            { name: "You", estimatedCalories: 1_300 },
            { name: "Wife", estimatedCalories: 900 },
          ],
        },
        {
          name: "Packaged chili dinner",
          items: [
            {
              name: "Packaged chili and watermelon bundle",
              quantity: "2 servings plus sides",
              estimatedCalories: 2_600,
              sourceUrl:
                "https://www.wholefoodsmarket.com/grocery/product/classic-beef%20chili%20with%20beans%2C%2024%20oz-b089pmtq67",
              prepMinutes: 5,
              prepTag: "prepared",
              favoriteMatch: true,
            },
          ],
          totalCalories: 2_600,
          memberCalories: [
            { name: "You", estimatedCalories: 1_500 },
            { name: "Wife", estimatedCalories: 1_100 },
          ],
        },
      ],
      dailyTotalCalories: 6_000,
    },
  ],
  groceryList: [
    {
      name: "Packaged delivery groceries",
      quantity: "1 complete bundle",
      packageSize: "1 day",
      estimatedPriceUsd: 60,
      estimatedCalories: 6_000,
      sourceUrl: "https://www.amazon.com/Whole-Foods-Market-Classic-Chili/dp/B089PMTQ67",
      storeSection: "pantry",
      prepTag: "ready-to-eat",
      favoriteMatch: true,
    },
  ],
  estimatedSubtotal: 60,
  dailyCalorieTotals: [6_000],
  disclaimers: ["Calorie and price values are estimates."],
  unavailableData: [],
};

const approval = {
  approved: true,
  note: null,
  decidedBy: "test",
  decidedAt: "2026-07-27T00:00:00.000Z",
};

const task = (frame: Frame, nodeId: string) => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === nodeId);
  expect(found, `expected ${nodeId}; got ${frame.tasks.map((candidate) => candidate.nodeId).join(", ")}`).toBeDefined();
  return found as Task;
};

const maybeTask = (frame: Frame, nodeId: string) => frame.tasks.find((candidate) => candidate.nodeId === nodeId);

const render = async (outputs: Record<string, unknown[]> = {}, overrides: Record<string, unknown> = {}) =>
  (await renderWorkflow(workflow, {
    workflowPath,
    input: { ...input, ...overrides },
    outputs,
  })) as Frame;

describe("whole-foods-meal-planner tools", () => {
  test("updates calorie targets from explicit values or revision prompts", () => {
    expect(
      updateCalorieTarget({
        dailyCalorieTarget: 2_000,
        requestedDailyCalorieTarget: 1_850,
        revisionPrompt: "aim for 1,700 calories",
      }),
    ).toEqual({ target: 1_850, source: "requested-input" });
    expect(
      updateCalorieTarget({
        dailyCalorieTarget: 2_000,
        revisionPrompt: "Please aim for 1,700 calories per day.",
      }),
    ).toEqual({ target: 1_700, source: "revision-prompt" });
  });

  test("normalizes favorites and calculates totals from meal items", () => {
    expect(normalizeFavorites(" Berries, sushi bowls\nberries; Rotisserie chicken ")).toEqual([
      "Berries",
      "sushi bowls",
      "Rotisserie chicken",
    ]);
    const profiles = parseMemberCalorieTargets("You: 3,500; Wife: 2,500");
    expect(profiles).toEqual([
      { name: "You", dailyCalorieTarget: 3_500 },
      { name: "Wife", dailyCalorieTarget: 2_500 },
    ]);
    expect(householdDailyCalorieTarget(profiles)).toBe(6_000);
    expect(calculatePlanCalories(plan.plan)).toEqual([
      expect.objectContaining({
        day: 1,
        calculatedTotalCalories: 2_000,
        reportedTotalCalories: 2_000,
        difference: 0,
      }),
    ]);
    expect(
      groupByStoreSection([
        { name: "Berries", storeSection: "produce" },
        { name: "Greens", storeSection: "produce" },
        { name: "Soup", storeSection: "prepared foods" },
      ]),
    ).toEqual({
      produce: [
        { name: "Berries", storeSection: "produce" },
        { name: "Greens", storeSection: "produce" },
      ],
      "prepared foods": [{ name: "Soup", storeSection: "prepared foods" }],
    });
  });

  test("exposes the calorie and favorites functions as agent-callable MCP tools", () => {
    const listed = handleMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const result = listed?.result as { tools?: Array<{ name: string }> };
    expect(result.tools?.map((tool) => tool.name)).toEqual([
      "update_calorie_target",
      "normalize_favorites",
      "normalize_calorie_profiles",
      "calculate_meal_calories",
      "calculate_plan_calories",
    ]);
    const called = handleMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "calculate_meal_calories",
        arguments: {
          items: [
            { name: "berries", estimatedCalories: 120 },
            { name: "yogurt", estimatedCalories: 180 },
          ],
        },
      },
    });
    expect(called).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({ structuredContent: { totalCalories: 300 } }),
      }),
    );
  });
});

describe("whole-foods-meal-planner household targets", () => {
  test("validates each person's calories and rejects self-serve delivery items", async () => {
    const overrides = {
      householdSize: 2,
      dailyCalorieTarget: 3_000,
      calorieProfiles: "You: 3500, Wife: 2500",
      deliveryOnly: true,
      orderWebhookUrl: "",
      requireOrderApproval: false,
    };
    const initial = await render({}, overrides);
    const normalized = (await runTask(task(initial, "normalize-inputs") as never)) as Record<string, unknown>;
    expect(normalized).toEqual(
      expect.objectContaining({
        constraints: expect.objectContaining({
          householdDailyCalorieTarget: 6_000,
          memberCalorieTargets: [
            { name: "You", dailyCalorieTarget: 3_500 },
            { name: "Wife", dailyCalorieTarget: 2_500 },
          ],
        }),
      }),
    );

    const normalizedOutputs = { normalizeInputs: [{ nodeId: "normalize-inputs", ...normalized }] };
    const planned = await render(
      { ...normalizedOutputs, planMeals: [{ nodeId: "plan-meals", ...couplePlan }] },
      overrides,
    );
    const calorieAudit = (await runTask(task(planned, "calculate-calories") as never)) as Record<string, unknown>;
    expect(calorieAudit).toEqual(
      expect.objectContaining({
        days: [
          expect.objectContaining({
            calculatedTotalCalories: 6_000,
            memberTotals: [
              { name: "You", estimatedCalories: 3_500 },
              { name: "Wife", estimatedCalories: 2_500 },
            ],
          }),
        ],
      }),
    );

    const calculatedOutputs = {
      ...normalizedOutputs,
      planMeals: [{ nodeId: "plan-meals", ...couplePlan }],
      calculateCalories: [{ nodeId: "calculate-calories", ...calorieAudit }],
    };
    const calculated = await render(calculatedOutputs, overrides);
    const validation = (await runTask(task(calculated, "validate-plan") as never)) as Record<string, unknown>;
    expect(validation).toEqual(expect.objectContaining({ passed: true, findings: [] }));

    const hotBarPlan = {
      ...couplePlan,
      groceryList: [{ ...couplePlan.groceryList[0], name: "Whole Foods hot bar" }],
    };
    const hotBarOutputs = {
      ...normalizedOutputs,
      planMeals: [{ nodeId: "plan-meals", ...hotBarPlan }],
      calculateCalories: [{ nodeId: "calculate-calories", ...calorieAudit }],
    };
    const hotBarFrame = await render(hotBarOutputs, overrides);
    const rejected = (await runTask(task(hotBarFrame, "validate-plan") as never)) as {
      passed: boolean;
      findings: string[];
    };
    expect(rejected.passed).toBe(false);
    expect(rejected.findings.join("\n")).toContain("cannot include self-serve");
  });
});

describe("whole-foods-meal-planner order boundary", () => {
  test("checkout and finalization use the highest validated loop iteration", async () => {
    const overrides = {
      orderWebhookUrl: "",
      requireOrderApproval: false,
      deliveryOnly: false,
    };
    const initial = await render({}, overrides);
    const normalized = (await runTask(task(initial, "normalize-inputs") as never)) as Record<string, unknown>;
    const latestPlan = {
      ...plan,
      summary: "Corrected latest plan.",
      groceryList: [{ ...plan.groceryList[0], name: "Latest packaged soup" }],
    };
    const loopOutputs = {
      normalizeInputs: [{ nodeId: "normalize-inputs", ...normalized }],
      planMeals: [
        { nodeId: "plan-meals", iteration: 0, ...plan },
        { nodeId: "plan-meals", iteration: 1, ...latestPlan },
      ],
      validatePlan: [
        { nodeId: "validate-plan", iteration: 0, summary: "failed", passed: false, findings: ["old draft"] },
        { nodeId: "validate-plan", iteration: 1, summary: "passed", passed: true, findings: [], warnings: [] },
      ],
    };
    const ready = await render(loopOutputs, overrides);
    const checkout = (await runTask(task(ready, "checkout-links") as never)) as {
      links: Array<{ name: string }>;
    };
    expect(checkout.links[0]?.name).toBe("Latest packaged soup");

    const withCheckout = await render(
      {
        ...loopOutputs,
        checkoutLinks: [{ nodeId: "checkout-links", ...checkout }],
      },
      overrides,
    );
    const finalized = (await runTask(task(withCheckout, "finalize") as never)) as {
      planJson: string;
    };
    const finalizedPlan = JSON.parse(finalized.planJson) as {
      plan: { summary: string; groceryList: Array<{ name: string }> };
    };
    expect(finalizedPlan.plan.summary).toBe("Corrected latest plan.");
    expect(finalizedPlan.plan.groceryList[0]?.name).toBe("Latest packaged soup");
  });

  test("a real webhook order remains blocked until approval even when optional link approval is disabled", async () => {
    const initial = await render();
    const normalized = (await runTask(task(initial, "normalize-inputs") as never)) as Record<string, unknown>;
    expect(normalized).toEqual(
      expect.objectContaining({
        calorieTargetSource: "daily-target",
        constraints: expect.objectContaining({ favoriteFoods: ["berries", "rotisserie chicken"] }),
      }),
    );

    const normalizedOutputs = { normalizeInputs: [{ nodeId: "normalize-inputs", ...normalized }] };
    const planned = await render({ ...normalizedOutputs, planMeals: [{ nodeId: "plan-meals", ...plan }] });
    const calorieAudit = (await runTask(task(planned, "calculate-calories") as never)) as Record<string, unknown>;
    const calculatedOutputs = {
      ...normalizedOutputs,
      planMeals: [{ nodeId: "plan-meals", ...plan }],
      calculateCalories: [{ nodeId: "calculate-calories", ...calorieAudit }],
    };
    const calculated = await render(calculatedOutputs);
    const validation = (await runTask(task(calculated, "validate-plan") as never)) as Record<string, unknown>;
    expect(validation).toEqual(expect.objectContaining({ passed: true, findings: [] }));

    const readyOutputs = {
      ...calculatedOutputs,
      validatePlan: [{ nodeId: "validate-plan", ...validation }],
    };
    const waiting = await render(readyOutputs);
    expect(task(waiting, "order-approval")).toBeDefined();
    expect(maybeTask(waiting, "order-webhook")).toBeUndefined();

    const approved = await render({
      ...readyOutputs,
      approval: [{ nodeId: "order-approval", ...approval }],
    });
    const order = task(approved, "order-webhook");
    expect(order.sideEffect).toBeTruthy();
    expect(order.retries).toBe(0);

    const denied = await render({
      ...readyOutputs,
      approval: [{ nodeId: "order-approval", ...approval, approved: false }],
    });
    expect(maybeTask(denied, "order-webhook")).toBeUndefined();
  });
});
