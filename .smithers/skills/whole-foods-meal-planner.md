---
name: whole-foods-meal-planner
description: Plans a multi-day, calorie-targeted meal plan biased toward Whole Foods prepared/ready-to-eat foods, validates it against calorie/budget/prep/exclusion constraints, gates any order behind approval, then orders via webhook or returns checkout links.
workflow: whole-foods-meal-planner
---

Use this workflow to build a grocery-shoppable meal plan sourced from Whole
Foods products for a household, validate it deterministically (calories vs
target, subtotal vs budget, prep time, allergens/exclusions), and either place
an order (via a configured webhook, gated behind human approval) or hand back
checkout search links. Reach for it whenever the ask is "plan meals and
groceries for N days" rather than a one-off recipe question.

Key inputs: `householdSize` (default 2), `days` (default 7),
`dailyCalorieTarget` (default 2000), `dietaryPreferences`,
`calorieProfiles` (for example `You: 3500, Wife: 2500`; when present, every
member is audited independently),
`favoriteFoods` (comma/newline-separated suggestions),
`allergiesExclusions`, `maxPrepMinutes` (default 15), `budget` (default 200),
`zipCode`, `orderWebhookUrl` (HTTPS or localhost only), and
`requireOrderApproval` (default true; webhook orders are always approval-gated
even when false). `deliveryOnly` defaults true and rejects hot bars, soup bars,
search-result URLs, and anything without a direct Whole Foods product page.
For revision runs, pass `priorPlanJson` (the previous run's
plan) plus `revisionPrompt` describing the change. A prompt such as "aim for
1,800 calories per day" updates the calorie target; the explicit
`requestedDailyCalorieTarget` input wins when both are present. Allergies and
exclusions always win over revisions and favorites.

The planner's Claude agent receives five read-only MCP tools:
`update_calorie_target`, `normalize_favorites`, `calculate_meal_calories`, and
`calculate_plan_calories`, plus `normalize_calorie_profiles`. The workflow independently repeats the calorie
calculation after the agent returns, so approval always shows totals calculated
from individual meal items and each member's meal allocations rather than
trusting model arithmetic.

Start it with:

```sh
bun apps/cli/src/index.js workflow run whole-foods-meal-planner --input '{"householdSize":2,"days":7,"dailyCalorieTarget":2000,"favoriteFoods":"berries, sushi bowls","budget":200}'
```

or from this checkout:

```sh
bun apps/cli/src/index.js up .smithers/workflows/whole-foods-meal-planner.tsx --input '{"days":5,"budget":150}'
```

Run detached and watch it with `-d`, then `smithers ps`,
`smithers logs <runId> -f`, and `smithers inspect <runId>`.

Visualize the graph with
`bun apps/cli/src/index.js graph .smithers/workflows/whole-foods-meal-planner.tsx`
(add `--interactive` for the TUI). A custom UI ships at
`.smithers/ui/whole-foods-meal-planner.tsx` showing the launch form, calorie
KPIs, meal cards, the sectioned grocery checklist, budget/prep summary, the
approval gate, and live order status — open a run with
`smithers ui <runId>`.

When a run pauses on the order approval, use `smithers approve <runId>` to
approve or `smithers deny <runId>` to deny (denial ends the run with no order
placed). Use `smithers why <runId>` if a run looks stuck, and
`smithers cancel <runId>` to stop it.

Suggest next: run it once, review the plan and grocery checklist in the
custom UI, approve or deny the order, and iterate by re-running with
`priorPlanJson` + `revisionPrompt` to adjust the plan.
