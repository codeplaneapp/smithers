import { createInterface } from "node:readline";
import {
  calculateMealCalories,
  calculatePlanCalories,
  householdDailyCalorieTarget,
  normalizeFavorites,
  parseMemberCalorieTargets,
  updateCalorieTarget,
  type CalorieDay,
  type CalorieItem,
} from "./wholeFoodsMealPlanner";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const tools: ToolDefinition[] = [
  {
    name: "update_calorie_target",
    description:
      "Resolve and validate the current daily calorie target from a numeric update or a natural-language revision prompt.",
    inputSchema: {
      type: "object",
      properties: {
        dailyCalorieTarget: { type: "number" },
        requestedDailyCalorieTarget: { type: ["number", "null"] },
        revisionPrompt: { type: "string" },
      },
      required: ["dailyCalorieTarget"],
      additionalProperties: false,
    },
  },
  {
    name: "normalize_favorites",
    description: "Normalize a user's comma/newline-separated favorite foods into a unique preference list.",
    inputSchema: {
      type: "object",
      properties: {
        favoriteFoods: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
      },
      required: ["favoriteFoods"],
      additionalProperties: false,
    },
  },
  {
    name: "normalize_calorie_profiles",
    description:
      'Normalize person-specific daily targets such as "Alex: 3500, Sam: 2500" and calculate the household total.',
    inputSchema: {
      type: "object",
      properties: {
        calorieProfiles: {
          oneOf: [
            { type: "string" },
            {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  dailyCalorieTarget: { type: "number" },
                },
                required: ["name", "dailyCalorieTarget"],
                additionalProperties: false,
              },
            },
          ],
        },
      },
      required: ["calorieProfiles"],
      additionalProperties: false,
    },
  },
  {
    name: "calculate_meal_calories",
    description: "Add estimated calories for every item in one meal. Use this instead of mental arithmetic.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              estimatedCalories: { type: "number", minimum: 0 },
            },
            required: ["name", "estimatedCalories"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "calculate_plan_calories",
    description: "Calculate and audit every meal and daily calorie total in a proposed meal plan.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "array",
          items: {
            type: "object",
            properties: {
              day: { type: "number" },
              dailyTotalCalories: { type: "number" },
              meals: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    totalCalories: { type: "number" },
                    memberCalories: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          estimatedCalories: { type: "number", minimum: 0 },
                        },
                        required: ["name", "estimatedCalories"],
                        additionalProperties: false,
                      },
                    },
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          estimatedCalories: { type: "number", minimum: 0 },
                        },
                        required: ["name", "estimatedCalories"],
                      },
                    },
                  },
                  required: ["name", "items"],
                },
              },
            },
            required: ["day", "meals"],
          },
        },
      },
      required: ["days"],
      additionalProperties: false,
    },
  },
];

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  return value;
}

function calorieItems(value: unknown): CalorieItem[] {
  return requireArray(value, "items").map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null) throw new Error(`items[${index}] must be an object.`);
    const item = candidate as Record<string, unknown>;
    return {
      name: requireString(item.name, `items[${index}].name`),
      estimatedCalories: requireNumber(item.estimatedCalories, `items[${index}].estimatedCalories`),
    };
  });
}

function calorieDays(value: unknown): CalorieDay[] {
  return requireArray(value, "days").map((candidate, dayIndex) => {
    if (typeof candidate !== "object" || candidate === null) throw new Error(`days[${dayIndex}] must be an object.`);
    const day = candidate as Record<string, unknown>;
    return {
      day: requireNumber(day.day, `days[${dayIndex}].day`),
      dailyTotalCalories:
        day.dailyTotalCalories === undefined
          ? undefined
          : requireNumber(day.dailyTotalCalories, `days[${dayIndex}].dailyTotalCalories`),
      meals: requireArray(day.meals, `days[${dayIndex}].meals`).map((mealCandidate, mealIndex) => {
        if (typeof mealCandidate !== "object" || mealCandidate === null) {
          throw new Error(`days[${dayIndex}].meals[${mealIndex}] must be an object.`);
        }
        const meal = mealCandidate as Record<string, unknown>;
        return {
          name: requireString(meal.name, `days[${dayIndex}].meals[${mealIndex}].name`),
          totalCalories:
            meal.totalCalories === undefined
              ? undefined
              : requireNumber(meal.totalCalories, `days[${dayIndex}].meals[${mealIndex}].totalCalories`),
          memberCalories:
            meal.memberCalories === undefined
              ? []
              : calorieItems(meal.memberCalories).map((allocation) => ({
                  name: allocation.name,
                  estimatedCalories: allocation.estimatedCalories,
                })),
          items: calorieItems(meal.items),
        };
      }),
    };
  });
}

function callTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "update_calorie_target":
      return updateCalorieTarget({
        dailyCalorieTarget: requireNumber(args.dailyCalorieTarget, "dailyCalorieTarget"),
        requestedDailyCalorieTarget:
          args.requestedDailyCalorieTarget === null || args.requestedDailyCalorieTarget === undefined
            ? null
            : requireNumber(args.requestedDailyCalorieTarget, "requestedDailyCalorieTarget"),
        revisionPrompt: args.revisionPrompt === undefined ? "" : requireString(args.revisionPrompt, "revisionPrompt"),
      });
    case "normalize_favorites":
      if (typeof args.favoriteFoods !== "string" && !Array.isArray(args.favoriteFoods)) {
        throw new Error("favoriteFoods must be a string or string array.");
      }
      return { favorites: normalizeFavorites(args.favoriteFoods as string | string[]) };
    case "normalize_calorie_profiles": {
      if (typeof args.calorieProfiles !== "string" && !Array.isArray(args.calorieProfiles)) {
        throw new Error("calorieProfiles must be a string or profile array.");
      }
      const profiles = parseMemberCalorieTargets(
        args.calorieProfiles as
          | string
          | Array<{
              name: string;
              dailyCalorieTarget: number;
            }>,
      );
      return { profiles, householdDailyCalorieTarget: householdDailyCalorieTarget(profiles) };
    }
    case "calculate_meal_calories":
      return { totalCalories: calculateMealCalories(calorieItems(args.items)) };
    case "calculate_plan_calories":
      return { days: calculatePlanCalories(calorieDays(args.days)) };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function handleMcpRequest(request: JsonRpcRequest): Record<string, unknown> | null {
  if (request.id === undefined) return null;
  const base = { jsonrpc: "2.0" as const, id: request.id };
  try {
    if (request.method === "initialize") {
      return {
        ...base,
        result: {
          protocolVersion: String(request.params?.protocolVersion ?? "2025-06-18"),
          capabilities: { tools: {} },
          serverInfo: { name: "meal-planner", version: "1.0.0" },
        },
      };
    }
    if (request.method === "ping") return { ...base, result: {} };
    if (request.method === "tools/list") return { ...base, result: { tools } };
    if (request.method === "tools/call") {
      const name = requireString(request.params?.name, "name");
      const args =
        typeof request.params?.arguments === "object" && request.params.arguments !== null
          ? (request.params.arguments as Record<string, unknown>)
          : {};
      const value = callTool(name, args);
      return {
        ...base,
        result: {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        },
      };
    }
    return {
      ...base,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    };
  } catch (error) {
    return {
      ...base,
      error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

if (import.meta.main) {
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    try {
      const response = handleMcpRequest(JSON.parse(line) as JsonRpcRequest);
      if (response) send(response);
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
}
