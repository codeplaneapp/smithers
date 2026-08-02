// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Whole Foods Meal Planner
// smithers-description: Plans a calorie-and-budget-targeted, Whole Foods-biased meal plan, validates it deterministically with a bounded re-plan loop, gates ordering behind a durable approval, then places the order or returns checkout links.
// smithers-tags: meal-planning, whole-foods, approval, groceries
/** @jsxImportSource smthrs */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { Approval, Branch, ClaudeCodeAgent, createSmithers, Loop, Sequence, UI } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";
import {
  calculatePlanCalories,
  favoriteCoverage,
  householdDailyCalorieTarget,
  normalizeFavorites,
  parseMemberCalorieTargets,
  updateCalorieTarget,
} from "../lib/wholeFoodsMealPlanner";
import PlanMealsPrompt from "../prompts/plan-meals.mdx";

const groceryItemSchema = z.object({
  name: z.string(),
  quantity: z.string(),
  packageSize: z.string(),
  estimatedPriceUsd: z.number(),
  estimatedCalories: z.number().nullable().default(null),
  sourceUrl: z.string(),
  storeSection: z.string(),
  prepTag: z.string(),
  favoriteMatch: z.boolean().default(false),
});

const constraintsSchema = z.object({
  householdSize: z.number(),
  days: z.number(),
  dailyCalorieTarget: z.number(),
  memberCalorieTargets: z.array(z.object({ name: z.string(), dailyCalorieTarget: z.number() })).default([]),
  householdDailyCalorieTarget: z.number(),
  dietaryPreferences: z.string(),
  allergiesExclusions: z.string(),
  maxPrepMinutes: z.number(),
  budget: z.number(),
  zipCode: z.string(),
  favoriteFoods: z.array(z.string()).default([]),
  deliveryOnly: z.boolean().default(true),
});

const normalizeInputsSchema = z.object({
  summary: z.string(),
  constraints: constraintsSchema,
  revisionMode: z.boolean(),
  priorPlan: z.unknown().nullable().default(null),
  priorPlanError: z.string().nullable().default(null),
  webhookConfigured: z.boolean(),
  webhookUrlValid: z.boolean(),
  webhookUrlError: z.string().nullable().default(null),
  calorieTargetSource: z.enum(["requested-input", "revision-prompt", "daily-target"]),
});

const mealItemSchema = z.object({
  name: z.string(),
  quantity: z.string(),
  estimatedCalories: z.number(),
  sourceUrl: z.string().nullable().default(null),
  prepMinutes: z.number(),
  prepTag: z.enum(["prepared", "ready-to-eat", "raw", "quick-prep"]),
  favoriteMatch: z.boolean().default(false),
});

const memberCaloriesSchema = z.object({
  name: z.string(),
  estimatedCalories: z.number(),
});

const planMealsSchema = z.object({
  summary: z.string(),
  plan: z.array(
    z.object({
      day: z.number(),
      meals: z.array(
        z.object({
          name: z.string(),
          items: z.array(mealItemSchema),
          totalCalories: z.number(),
          memberCalories: z.array(memberCaloriesSchema).default([]),
        }),
      ),
      dailyTotalCalories: z.number(),
    }),
  ),
  groceryList: z.array(groceryItemSchema),
  estimatedSubtotal: z.number(),
  dailyCalorieTotals: z.array(z.number()),
  disclaimers: z.array(z.string()),
  unavailableData: z.array(z.string()).default([]),
});

const calculateCaloriesSchema = z.object({
  summary: z.string(),
  days: z.array(
    z.object({
      day: z.number(),
      calculatedTotalCalories: z.number(),
      reportedTotalCalories: z.number(),
      difference: z.number(),
      meals: z.array(
        z.object({
          name: z.string(),
          calculatedCalories: z.number(),
          reportedCalories: z.number(),
          difference: z.number(),
          memberCalories: z.array(memberCaloriesSchema).default([]),
          memberAllocationDifference: z.number().default(0),
        }),
      ),
      memberTotals: z.array(memberCaloriesSchema).default([]),
    }),
  ),
  favoriteMatches: z.array(z.string()).default([]),
  favoriteMisses: z.array(z.string()).default([]),
});

const validatePlanSchema = z.object({
  summary: z.string(),
  passed: z.boolean(),
  findings: z.array(z.string()),
  warnings: z.array(z.string()).default([]),
});

const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable().default(null),
  decidedBy: z.string().nullable().default(null),
  decidedAt: z.string().nullable().default(null),
});

const orderWebhookSchema = z.object({
  summary: z.string(),
  orderStatus: z.enum(["ordered", "failed"]),
  httpStatus: z.number().nullable().default(null),
  orderReference: z.string().nullable().default(null),
  responseBody: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});

const checkoutLinksSchema = z.object({
  summary: z.string(),
  orderStatus: z.literal("needs-checkout"),
  links: z.array(
    z.object({
      name: z.string(),
      wholeFoodsUrl: z.string(),
      amazonUrl: z.string(),
    }),
  ),
});

const finalizeSchema = z.object({
  summary: z.string(),
  planJson: z.string(),
  groceryList: z.array(groceryItemSchema),
  orderStatus: z.enum(["ordered", "needs-checkout", "denied", "failed", "skipped"]),
  links: z
    .array(
      z.object({
        name: z.string(),
        wholeFoodsUrl: z.string(),
        amazonUrl: z.string(),
      }),
    )
    .default([]),
  warnings: z.array(z.string()).default([]),
  disclaimers: z.array(z.string()).default([]),
  constraints: constraintsSchema,
  calorieAudit: z
    .array(
      z.object({
        day: z.number(),
        calculatedTotalCalories: z.number(),
        reportedTotalCalories: z.number(),
        difference: z.number(),
      }),
    )
    .default([]),
});

const inputSchema = z.object({
  householdSize: z.number().default(2),
  days: z.number().default(7),
  dailyCalorieTarget: z.number().default(2000),
  requestedDailyCalorieTarget: z.number().nullable().default(null),
  calorieProfiles: z.string().default(""),
  dietaryPreferences: z.string().default(""),
  favoriteFoods: z.string().default(""),
  allergiesExclusions: z.string().default(""),
  maxPrepMinutes: z.number().default(15),
  budget: z.number().default(200),
  zipCode: z.string().default(""),
  revisionPrompt: z.string().default(""),
  priorPlanJson: z.string().default(""),
  orderWebhookUrl: z.string().default(""),
  requireOrderApproval: z.boolean().default(true),
  deliveryOnly: z.boolean().default(true),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  normalizeInputs: normalizeInputsSchema,
  planMeals: planMealsSchema,
  calculateCalories: calculateCaloriesSchema,
  validatePlan: validatePlanSchema,
  approval: approvalSchema,
  orderWebhook: orderWebhookSchema,
  checkoutLinks: checkoutLinksSchema,
  finalize: finalizeSchema,
});

// The primary planner receives purpose-built, read-only MCP tools while keeping
// Claude Code's WebSearch/WebFetch surface for honest product sourcing. The
// workspace research pool remains the runtime fallback; deterministic workflow
// tasks repeat every calculation, so correctness never depends on tool use.
const plannerAgent = new ClaudeCodeAgent({
  model: "claude-sonnet-5",
  mcpConfig: [resolve(import.meta.dir, "../lib/whole-foods-meal-planner.mcp.json")],
  strictMcpConfig: true,
  allowedTools: [
    "WebSearch",
    "WebFetch",
    "mcp__meal_planner__update_calorie_target",
    "mcp__meal_planner__normalize_favorites",
    "mcp__meal_planner__normalize_calorie_profiles",
    "mcp__meal_planner__calculate_meal_calories",
    "mcp__meal_planner__calculate_plan_calories",
  ],
  permissionMode: "dontAsk",
});

export type OrderWebhookConfig = {
  configured: boolean;
  valid: boolean;
  endpoint: string | null;
  destinationHost: string | null;
  error: string | null;
};

/**
 * Ordering is opt-in through workflow input, but the credentialed endpoint is
 * owned by the server. Input can only select that exact endpoint.
 */
export function resolveOrderWebhookConfig(
  requestedRawUrl: string,
  serverConfiguredRawUrl: string | undefined,
): OrderWebhookConfig {
  const requested = requestedRawUrl.trim();
  if (!requested) {
    return { configured: false, valid: true, endpoint: null, destinationHost: null, error: null };
  }
  const configured = serverConfiguredRawUrl?.trim() ?? "";
  if (!configured) {
    return {
      configured: true,
      valid: false,
      endpoint: null,
      destinationHost: null,
      error: "Order webhook is not configured by the server.",
    };
  }
  try {
    const requestedUrl = new URL(requested);
    const configuredUrl = new URL(configured);
    if (configuredUrl.protocol !== "https:") {
      return {
        configured: true,
        valid: false,
        endpoint: null,
        destinationHost: configuredUrl.host || null,
        error: "Server-configured order webhook must use HTTPS.",
      };
    }
    if (configuredUrl.username || configuredUrl.password || configuredUrl.hash) {
      return {
        configured: true,
        valid: false,
        endpoint: null,
        destinationHost: configuredUrl.host || null,
        error: "Server-configured order webhook cannot contain credentials or a fragment.",
      };
    }
    if (requestedUrl.href !== configuredUrl.href) {
      return {
        configured: true,
        valid: false,
        endpoint: null,
        destinationHost: requestedUrl.host || null,
        error: "Requested order webhook does not match the server-configured endpoint.",
      };
    }
    return {
      configured: true,
      valid: true,
      endpoint: configuredUrl.href,
      destinationHost: configuredUrl.host,
      error: null,
    };
  } catch {
    return {
      configured: true,
      valid: false,
      endpoint: null,
      destinationHost: null,
      error: "Order webhook URL is not valid.",
    };
  }
}

export function isNonPublicIpAddress(rawAddress: string): boolean {
  const address = rawAddress
    .toLocaleLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%", 1)[0]!;
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a! >= 224
    );
  }
  if (family === 6) {
    if (address === "::" || address === "::1") return true;
    if (address.startsWith("::ffff:")) return isNonPublicIpAddress(address.slice("::ffff:".length));
    if (address.startsWith("::")) return true;
    const first = Number.parseInt(address.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true;
}

type WebhookLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export async function assertPublicWebhookDestination(
  rawUrl: string,
  resolveHostname: WebhookLookup = async (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Order webhook must use HTTPS.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await resolveHostname(hostname);
  if (addresses.length === 0) throw new Error(`Order webhook host ${url.host} has no DNS addresses.`);
  const unsafe = addresses.find((entry) => isNonPublicIpAddress(entry.address));
  if (unsafe) {
    throw new Error(`Order webhook host ${url.host} resolves to a non-public address (${unsafe.address}).`);
  }
  return url;
}

function buildCheckoutLinks(items: Array<{ name: string }>, zipCode: string) {
  return items.map((item) => ({
    name: item.name,
    wholeFoodsUrl: `https://www.wholefoodsmarket.com/search?text=${encodeURIComponent(item.name)}${zipCode ? `&zipCode=${encodeURIComponent(zipCode)}` : ""}`,
    amazonUrl: `https://www.amazon.com/s?k=${encodeURIComponent(item.name)}&i=wholefoods`,
  }));
}

function isDirectDeliveryProductUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLocaleLowerCase();
    const wholeFoodsProduct =
      hostname === "wholefoodsmarket.com" || hostname.endsWith(".wholefoodsmarket.com")
        ? /^\/(?:grocery\/)?product\//i.test(url.pathname)
        : false;
    const amazonProduct =
      hostname === "amazon.com" || hostname.endsWith(".amazon.com") ? /\/dp\/[a-z0-9]+/i.test(url.pathname) : false;
    return url.protocol === "https:" && (wholeFoodsProduct || amazonProduct);
  } catch {
    return false;
  }
}

export default smithers((ctx) => {
  const revisionPrompt = ctx.input.revisionPrompt ?? "";
  const priorPlanJson = ctx.input.priorPlanJson ?? "";
  const orderWebhookUrl = ctx.input.orderWebhookUrl ?? "";
  const orderWebhook = resolveOrderWebhookConfig(orderWebhookUrl, process.env.WHOLE_FOODS_ORDER_WEBHOOK_URL);
  const requireOrderApproval = ctx.input.requireOrderApproval ?? true;

  const normalized = ctx.outputMaybe("normalizeInputs", { nodeId: "normalize-inputs" });
  // Loop consumers must read the highest iteration. outputMaybe resolves the
  // render iteration (often 0) and can otherwise order/finalize a stale draft.
  const latestValidation = ctx.latest("validatePlan", "validate-plan") as
    | z.infer<typeof validatePlanSchema>
    | undefined;
  const latestPlan = ctx.latest("planMeals", "plan-meals") as z.infer<typeof planMealsSchema> | undefined;
  const latestCalorieAudit = ctx.latest("calculateCalories", "calculate-calories") as
    | z.infer<typeof calculateCaloriesSchema>
    | undefined;
  const approval = ctx.outputMaybe("approval", { nodeId: "order-approval" });

  const validated = latestValidation?.passed === true;
  const webhookReady =
    (normalized?.webhookConfigured ?? false) &&
    (normalized?.webhookUrlValid ?? false) &&
    orderWebhook.valid &&
    orderWebhook.endpoint !== null;
  // A configured order webhook is always approval-gated. The optional input
  // only controls whether link-only checkout also pauses for approval.
  const approvalNeeded = requireOrderApproval || webhookReady;
  const approvedOrSkipped = approvalNeeded ? approval?.approved === true : true;
  const denied = approvalNeeded && approval !== null && approval !== undefined && approval.approved === false;

  return (
    <Workflow name="whole-foods-meal-planner">
      <UI entry="../ui/whole-foods-meal-planner.tsx" title="Whole Foods Meal Planner" />
      <Sequence>
        <Task
          id="normalize-inputs"
          output={outputs.normalizeInputs}
          children={() => {
            const calorieTarget = updateCalorieTarget({
              dailyCalorieTarget: ctx.input.dailyCalorieTarget ?? 2000,
              requestedDailyCalorieTarget: ctx.input.requestedDailyCalorieTarget ?? null,
              revisionPrompt,
            });
            const memberCalorieTargets = parseMemberCalorieTargets(ctx.input.calorieProfiles ?? "");
            const householdSize = ctx.input.householdSize ?? 2;
            if (memberCalorieTargets.length > 0 && memberCalorieTargets.length !== householdSize) {
              throw new Error(
                `Received ${memberCalorieTargets.length} calorie profile(s) for household size ${householdSize}.`,
              );
            }
            const constraints = {
              householdSize,
              days: ctx.input.days ?? 7,
              dailyCalorieTarget: calorieTarget.target,
              memberCalorieTargets,
              householdDailyCalorieTarget:
                memberCalorieTargets.length > 0
                  ? householdDailyCalorieTarget(memberCalorieTargets)
                  : calorieTarget.target * householdSize,
              dietaryPreferences: ctx.input.dietaryPreferences ?? "",
              allergiesExclusions: ctx.input.allergiesExclusions ?? "",
              maxPrepMinutes: ctx.input.maxPrepMinutes ?? 15,
              budget: ctx.input.budget ?? 200,
              zipCode: ctx.input.zipCode ?? "",
              favoriteFoods: normalizeFavorites(ctx.input.favoriteFoods ?? ""),
              deliveryOnly: ctx.input.deliveryOnly ?? true,
            };
            const revisionMode = revisionPrompt.trim().length > 0 || priorPlanJson.trim().length > 0;
            let priorPlan: unknown = null;
            let priorPlanError: string | null = null;
            if (priorPlanJson.trim().length > 0) {
              try {
                priorPlan = JSON.parse(priorPlanJson);
              } catch (err) {
                priorPlanError = `priorPlanJson is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
              }
            }
            if (priorPlanError) {
              throw new Error(priorPlanError);
            }
            if (orderWebhook.configured && !orderWebhook.valid) {
              throw new Error(orderWebhook.error ?? "Invalid orderWebhookUrl");
            }
            return {
              summary: revisionMode
                ? `Revision run for ${constraints.days}-day plan (household of ${constraints.householdSize}).`
                : `New ${constraints.days}-day plan for household of ${constraints.householdSize}, ${constraints.householdDailyCalorieTarget} kcal/household-day target.`,
              constraints,
              revisionMode,
              priorPlan,
              priorPlanError,
              webhookConfigured: orderWebhook.configured,
              webhookUrlValid: orderWebhook.valid,
              webhookUrlError: orderWebhook.error,
              calorieTargetSource: calorieTarget.source,
            };
          }}
        />

        <Loop id="plan-validate-loop" until={validated} maxIterations={3} onMaxReached="return-last">
          <Sequence>
            <Task id="plan-meals" output={outputs.planMeals} agent={[plannerAgent, ...agents.research]}>
              <PlanMealsPrompt
                householdSize={normalized?.constraints.householdSize ?? ctx.input.householdSize ?? 2}
                days={normalized?.constraints.days ?? ctx.input.days ?? 7}
                dailyCalorieTarget={normalized?.constraints.dailyCalorieTarget ?? ctx.input.dailyCalorieTarget ?? 2000}
                memberCalorieTargets={JSON.stringify(normalized?.constraints.memberCalorieTargets ?? [])}
                householdDailyCalorieTarget={
                  normalized?.constraints.householdDailyCalorieTarget ??
                  (ctx.input.dailyCalorieTarget ?? 2000) * (ctx.input.householdSize ?? 2)
                }
                dietaryPreferences={normalized?.constraints.dietaryPreferences ?? ""}
                allergiesExclusions={normalized?.constraints.allergiesExclusions ?? ""}
                maxPrepMinutes={normalized?.constraints.maxPrepMinutes ?? 15}
                budget={normalized?.constraints.budget ?? 200}
                zipCode={normalized?.constraints.zipCode ?? ""}
                favoriteFoods={JSON.stringify(normalized?.constraints.favoriteFoods ?? [])}
                deliveryOnly={
                  (normalized?.constraints.deliveryOnly ?? ctx.input.deliveryOnly ?? true) ? "true" : "false"
                }
                calorieTargetSource={normalized?.calorieTargetSource ?? "daily-target"}
                revisionPrompt={revisionPrompt}
                priorPlanJson={priorPlanJson}
                priorFindings={
                  latestValidation && latestValidation.passed !== true ? JSON.stringify(latestValidation.findings) : ""
                }
              />
            </Task>

            <Task
              id="calculate-calories"
              output={outputs.calculateCalories}
              needs={{ plan: "plan-meals" }}
              deps={{ plan: outputs.planMeals }}
              children={(deps: { plan: z.infer<typeof planMealsSchema> }) => {
                const days = calculatePlanCalories(deps.plan.plan);
                const coverage = favoriteCoverage(deps.plan.plan, normalized?.constraints.favoriteFoods ?? []);
                return {
                  summary: `Calculated ${days.length} daily total(s) from individual meal items.`,
                  days,
                  favoriteMatches: coverage.matched,
                  favoriteMisses: coverage.unmatched,
                };
              }}
            />

            <Task
              id="validate-plan"
              output={outputs.validatePlan}
              needs={{ plan: "plan-meals", calories: "calculate-calories" }}
              deps={{ plan: outputs.planMeals, calories: outputs.calculateCalories }}
              children={(deps: {
                plan: z.infer<typeof planMealsSchema>;
                calories: z.infer<typeof calculateCaloriesSchema>;
              }) => {
                const plan = deps.plan;
                const constraints = normalized?.constraints ?? {
                  householdSize: ctx.input.householdSize ?? 2,
                  days: ctx.input.days ?? 7,
                  dailyCalorieTarget: ctx.input.dailyCalorieTarget ?? 2000,
                  memberCalorieTargets: [],
                  householdDailyCalorieTarget: (ctx.input.dailyCalorieTarget ?? 2000) * (ctx.input.householdSize ?? 2),
                  dietaryPreferences: "",
                  allergiesExclusions: ctx.input.allergiesExclusions ?? "",
                  maxPrepMinutes: ctx.input.maxPrepMinutes ?? 15,
                  budget: ctx.input.budget ?? 200,
                  zipCode: "",
                  favoriteFoods: normalizeFavorites(ctx.input.favoriteFoods ?? ""),
                  deliveryOnly: ctx.input.deliveryOnly ?? true,
                };
                const findings: string[] = [];
                const expectedDays = Array.from({ length: constraints.days }, (_, index) => index + 1);
                const actualDays = plan.plan.map((day) => day.day);
                if (JSON.stringify(actualDays) !== JSON.stringify(expectedDays)) {
                  findings.push(
                    `Plan days must be numbered 1-${constraints.days} exactly; got ${actualDays.join(", ")}.`,
                  );
                }

                for (const day of deps.calories.days) {
                  const lowerBound = constraints.householdDailyCalorieTarget * 0.9;
                  const upperBound = constraints.householdDailyCalorieTarget * 1.1;
                  if (day.calculatedTotalCalories < lowerBound || day.calculatedTotalCalories > upperBound) {
                    findings.push(
                      `Day ${day.day} calculated total ${day.calculatedTotalCalories} kcal is outside ±10% of household target ${constraints.householdDailyCalorieTarget} kcal`,
                    );
                  }
                  if (day.difference !== 0) {
                    findings.push(
                      `Day ${day.day} reported ${day.reportedTotalCalories} kcal but its meal items add up to ${day.calculatedTotalCalories} kcal`,
                    );
                  }
                  for (const meal of day.meals) {
                    if (meal.difference !== 0) {
                      findings.push(
                        `Day ${day.day} "${meal.name}" reported ${meal.reportedCalories} kcal but its items add up to ${meal.calculatedCalories} kcal`,
                      );
                    }
                    if (constraints.memberCalorieTargets.length > 0) {
                      if (meal.memberAllocationDifference !== 0) {
                        findings.push(
                          `Day ${day.day} "${meal.name}" member allocations differ from item calories by ${meal.memberAllocationDifference} kcal`,
                        );
                      }
                      const allocatedNames = new Set(
                        meal.memberCalories.map((allocation) => allocation.name.toLocaleLowerCase()),
                      );
                      for (const profile of constraints.memberCalorieTargets) {
                        if (!allocatedNames.has(profile.name.toLocaleLowerCase())) {
                          findings.push(
                            `Day ${day.day} "${meal.name}" is missing a calorie allocation for ${profile.name}`,
                          );
                        }
                      }
                    }
                  }

                  if (constraints.memberCalorieTargets.length > 0) {
                    const dailyMembers = new Map(
                      day.memberTotals.map((allocation) => [allocation.name.toLocaleLowerCase(), allocation]),
                    );
                    for (const profile of constraints.memberCalorieTargets) {
                      const allocation = dailyMembers.get(profile.name.toLocaleLowerCase());
                      if (!allocation) {
                        findings.push(`Day ${day.day} is missing a daily calorie total for ${profile.name}`);
                        continue;
                      }
                      const memberLowerBound = profile.dailyCalorieTarget * 0.9;
                      const memberUpperBound = profile.dailyCalorieTarget * 1.1;
                      if (
                        allocation.estimatedCalories < memberLowerBound ||
                        allocation.estimatedCalories > memberUpperBound
                      ) {
                        findings.push(
                          `Day ${day.day} gives ${profile.name} ${allocation.estimatedCalories} kcal, outside ±10% of their ${profile.dailyCalorieTarget} kcal target`,
                        );
                      }
                    }
                  }
                }

                const calculatedSubtotal =
                  Math.round(plan.groceryList.reduce((sum, item) => sum + item.estimatedPriceUsd, 0) * 100) / 100;
                if (Math.abs(calculatedSubtotal - plan.estimatedSubtotal) >= 0.01) {
                  findings.push(
                    `Reported subtotal $${plan.estimatedSubtotal.toFixed(2)} does not equal grocery line-item total $${calculatedSubtotal.toFixed(2)}`,
                  );
                }
                if (plan.estimatedSubtotal > constraints.budget) {
                  findings.push(`Estimated subtotal $${plan.estimatedSubtotal} exceeds budget $${constraints.budget}`);
                }

                const exclusions = constraints.allergiesExclusions
                  .toLowerCase()
                  .split(",")
                  .map((s: string) => s.trim())
                  .filter((s: string) => s.length > 0);
                for (const item of plan.groceryList) {
                  const nameLower = item.name.toLowerCase();
                  for (const excluded of exclusions) {
                    if (excluded && nameLower.includes(excluded)) {
                      findings.push(`Grocery item "${item.name}" matches excluded/allergen term "${excluded}"`);
                    }
                  }
                  if (constraints.deliveryOnly) {
                    if (/\b(?:hot|soup|salad)\s+bar\b/i.test(item.name)) {
                      findings.push(`Delivery-only grocery list cannot include self-serve item "${item.name}"`);
                    }
                    if (!isDirectDeliveryProductUrl(item.sourceUrl)) {
                      findings.push(
                        `Delivery-only item "${item.name}" needs a direct Whole Foods or Amazon product URL`,
                      );
                    }
                  }
                }

                for (const day of plan.plan) {
                  for (const meal of day.meals) {
                    for (const item of meal.items) {
                      const isExemptPrep = item.prepTag === "prepared" || item.prepTag === "ready-to-eat";
                      if (!isExemptPrep && item.prepMinutes > constraints.maxPrepMinutes) {
                        findings.push(
                          `Item "${item.name}" prep time ${item.prepMinutes}min exceeds max ${constraints.maxPrepMinutes}min`,
                        );
                      }
                      if (
                        constraints.deliveryOnly &&
                        (!item.sourceUrl || !isDirectDeliveryProductUrl(item.sourceUrl))
                      ) {
                        findings.push(
                          `Delivery-only meal item "${item.name}" needs a direct Whole Foods or Amazon product URL`,
                        );
                      }
                    }
                  }
                }

                const warnings = deps.calories.favoriteMisses.map(
                  (favorite) => `Favorite "${favorite}" was not used; constraints may have taken priority.`,
                );
                const passed = findings.length === 0;
                return {
                  summary: passed
                    ? "Plan passed all deterministic checks."
                    : `Plan has ${findings.length} validation finding(s).`,
                  passed,
                  findings,
                  warnings,
                };
              }}
            />
          </Sequence>
        </Loop>

        <Branch
          if={approvalNeeded}
          then={
            <Approval
              id="order-approval"
              output={outputs.approval}
              request={{
                title: "Approve meal plan & grocery order",
                summary: `Estimated subtotal $${latestPlan?.estimatedSubtotal ?? 0} for a ${normalized?.constraints.days ?? 0}-day plan. Validation: ${
                  latestValidation?.passed
                    ? "passed"
                    : `${latestValidation?.findings.length ?? 0} residual finding(s) as warnings`
                }.${webhookReady ? ` Destination: ${orderWebhook.destinationHost}.` : ""}`,
              }}
              onDeny="continue"
            />
          }
          else={null}
        />

        <Branch
          if={!denied && webhookReady && approvedOrSkipped}
          then={
            <Task
              id="order-webhook"
              output={outputs.orderWebhook}
              retries={0}
              sideEffect
              needs={{ plan: "plan-meals" }}
              deps={{ plan: outputs.planMeals }}
              children={async () => {
                const plan = latestPlan;
                if (!plan) {
                  return {
                    summary: "No plan available to order.",
                    orderStatus: "failed" as const,
                    httpStatus: null,
                    orderReference: null,
                    responseBody: null,
                    error: "No plan output available",
                  };
                }
                const payload = {
                  schemaVersion: 1,
                  runId: ctx.runId,
                  items: plan.groceryList.map((item) => ({
                    name: item.name,
                    quantity: item.quantity,
                    packageSize: item.packageSize,
                    estimatedPriceUsd: item.estimatedPriceUsd,
                    sourceUrl: item.sourceUrl,
                    storeSection: item.storeSection,
                  })),
                  estimatedSubtotalUsd: plan.estimatedSubtotal,
                  zipCode: normalized?.constraints.zipCode ?? "",
                  planReference: "plan-meals",
                };
                const headers: Record<string, string> = { "content-type": "application/json" };
                if (process.env.WHOLE_FOODS_ORDER_TOKEN) {
                  headers.authorization = `Bearer ${process.env.WHOLE_FOODS_ORDER_TOKEN}`;
                }
                try {
                  const endpoint = orderWebhook.endpoint;
                  if (!endpoint) throw new Error("Server-configured order webhook is unavailable.");
                  await assertPublicWebhookDestination(endpoint);
                  const res = await fetch(endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(payload),
                    redirect: "manual",
                  });
                  const body = await res.text();
                  if (res.ok) {
                    let orderReference: string | null = null;
                    try {
                      const parsed = JSON.parse(body);
                      orderReference = typeof parsed?.orderReference === "string" ? parsed.orderReference : null;
                    } catch {
                      orderReference = null;
                    }
                    return {
                      summary: `Order webhook returned ${res.status}.`,
                      orderStatus: "ordered" as const,
                      httpStatus: res.status,
                      orderReference,
                      responseBody: body,
                      error: null,
                    };
                  }
                  return {
                    summary: `Order webhook failed with status ${res.status}.`,
                    orderStatus: "failed" as const,
                    httpStatus: res.status,
                    orderReference: null,
                    responseBody: body,
                    error: `Non-2xx response: ${res.status}`,
                  };
                } catch (err) {
                  return {
                    summary: "Order webhook request failed.",
                    orderStatus: "failed" as const,
                    httpStatus: null,
                    orderReference: null,
                    responseBody: null,
                    error: err instanceof Error ? err.message : String(err),
                  };
                }
              }}
            />
          }
          else={
            <Branch
              if={!denied}
              then={
                <Task
                  id="checkout-links"
                  output={outputs.checkoutLinks}
                  needs={{ plan: "plan-meals" }}
                  deps={{ plan: outputs.planMeals }}
                  children={() => {
                    const plan = latestPlan;
                    const items = plan?.groceryList ?? [];
                    const links = buildCheckoutLinks(items, normalized?.constraints.zipCode ?? "");
                    return {
                      summary: `Generated ${links.length} checkout link pair(s) for zip ${normalized?.constraints.zipCode || "(unspecified)"}. No order was placed.`,
                      orderStatus: "needs-checkout" as const,
                      links,
                    };
                  }}
                />
              }
              else={null}
            />
          }
        />

        <Task
          id="finalize"
          output={outputs.finalize}
          needs={{ plan: "plan-meals", validation: "validate-plan" }}
          deps={{ plan: outputs.planMeals, validation: outputs.validatePlan }}
          depsOptional
          children={(deps: {
            plan?: z.infer<typeof planMealsSchema>;
            validation?: z.infer<typeof validatePlanSchema>;
          }) => {
            const plan = latestPlan ?? deps.plan;
            const validation = latestValidation ?? deps.validation;
            const orderWebhookResult = ctx.outputMaybe("orderWebhook", { nodeId: "order-webhook" });
            const checkoutLinksResult = ctx.outputMaybe("checkoutLinks", { nodeId: "checkout-links" });

            let orderStatus: "ordered" | "needs-checkout" | "denied" | "failed" | "skipped" = "skipped";
            let links: Array<{ name: string; wholeFoodsUrl: string; amazonUrl: string }> = [];
            if (denied) {
              orderStatus = "denied";
            } else if (orderWebhookResult) {
              orderStatus = orderWebhookResult.orderStatus;
            } else if (checkoutLinksResult) {
              orderStatus = "needs-checkout";
              links = checkoutLinksResult.links;
            }

            const constraints = normalized?.constraints ?? {
              householdSize: ctx.input.householdSize ?? 2,
              days: ctx.input.days ?? 7,
              dailyCalorieTarget: ctx.input.dailyCalorieTarget ?? 2000,
              memberCalorieTargets: parseMemberCalorieTargets(ctx.input.calorieProfiles ?? ""),
              householdDailyCalorieTarget: (ctx.input.dailyCalorieTarget ?? 2000) * (ctx.input.householdSize ?? 2),
              dietaryPreferences: ctx.input.dietaryPreferences ?? "",
              allergiesExclusions: ctx.input.allergiesExclusions ?? "",
              maxPrepMinutes: ctx.input.maxPrepMinutes ?? 15,
              budget: ctx.input.budget ?? 200,
              zipCode: ctx.input.zipCode ?? "",
              favoriteFoods: normalizeFavorites(ctx.input.favoriteFoods ?? ""),
              deliveryOnly: ctx.input.deliveryOnly ?? true,
            };
            const calorieAudit = (latestCalorieAudit?.days ?? []).map((day) => ({
              day: day.day,
              calculatedTotalCalories: day.calculatedTotalCalories,
              reportedTotalCalories: day.reportedTotalCalories,
              difference: day.difference,
            }));
            return {
              summary: `Plan finalized with order status: ${orderStatus}.`,
              planJson: JSON.stringify({
                constraints,
                plan: plan ?? null,
                calorieAudit,
              }),
              groceryList: plan?.groceryList ?? [],
              orderStatus,
              links,
              warnings: [...(validation?.passed === false ? validation.findings : []), ...(validation?.warnings ?? [])],
              disclaimers: plan?.disclaimers ?? [],
              constraints,
              calorieAudit,
            };
          }}
        />
      </Sequence>
    </Workflow>
  );
});
