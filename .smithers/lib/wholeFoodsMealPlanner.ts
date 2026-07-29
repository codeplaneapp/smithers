export type CalorieItem = {
  name: string;
  estimatedCalories: number;
};

export type MemberCalorieTarget = {
  name: string;
  dailyCalorieTarget: number;
};

export type MemberCalorieAllocation = {
  name: string;
  estimatedCalories: number;
};

export type CalorieMeal = {
  name: string;
  items: CalorieItem[];
  totalCalories?: number;
  memberCalories?: MemberCalorieAllocation[];
};

export type CalorieDay = {
  day: number;
  meals: CalorieMeal[];
  dailyTotalCalories?: number;
};

export type CalorieTargetResolution = {
  target: number;
  source: "requested-input" | "revision-prompt" | "daily-target";
};

export type MealCalorieAudit = {
  name: string;
  calculatedCalories: number;
  reportedCalories: number;
  difference: number;
  memberCalories: MemberCalorieAllocation[];
  memberAllocationDifference: number;
};

export type DayCalorieAudit = {
  day: number;
  calculatedTotalCalories: number;
  reportedTotalCalories: number;
  difference: number;
  meals: MealCalorieAudit[];
  memberTotals: MemberCalorieAllocation[];
};

const MIN_DAILY_CALORIES = 800;
const MAX_DAILY_CALORIES = 6_000;

function boundedCalorieTarget(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Daily calorie target must be a finite number.");
  const rounded = Math.round(value);
  if (rounded < MIN_DAILY_CALORIES || rounded > MAX_DAILY_CALORIES) {
    throw new Error(`Daily calorie target must be between ${MIN_DAILY_CALORIES} and ${MAX_DAILY_CALORIES}.`);
  }
  return rounded;
}

export function calorieTargetFromPrompt(prompt: string): number | null {
  const normalized = prompt.replaceAll(",", "");
  const patterns = [
    /\b(?:aim|target)(?:\s+\w+){0,4}\s+(\d{3,4})\s*(?:kcal|calories|cal)\b/i,
    /\b(?:set|change|update)(?:\s+(?:the|my|our|daily|calorie|caloric|target|to|at|for)){0,8}\s+(\d{3,4})\s*(?:kcal|calories|cal)\b/i,
    /\bmake(?:\s+(?:the|my|our|daily|calorie|caloric)){0,6}\s+target(?:\s+(?:to|at))?\s+(\d{3,4})\s*(?:kcal|calories|cal)\b/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < MIN_DAILY_CALORIES || value > MAX_DAILY_CALORIES) return null;
    return Math.round(value);
  }
  return null;
}

export function updateCalorieTarget(input: {
  dailyCalorieTarget: number;
  requestedDailyCalorieTarget?: number | null;
  revisionPrompt?: string;
}): CalorieTargetResolution {
  if (input.requestedDailyCalorieTarget !== null && input.requestedDailyCalorieTarget !== undefined) {
    return { target: boundedCalorieTarget(input.requestedDailyCalorieTarget), source: "requested-input" };
  }
  const prompted = calorieTargetFromPrompt(input.revisionPrompt ?? "");
  if (prompted !== null) return { target: prompted, source: "revision-prompt" };
  return { target: boundedCalorieTarget(input.dailyCalorieTarget), source: "daily-target" };
}

export function normalizeFavorites(value: string | readonly string[]): string[] {
  const candidates = Array.isArray(value) ? value : String(value).split(/[\n,;]+/);
  const seen = new Set<string>();
  const favorites: string[] = [];
  for (const candidate of candidates) {
    const favorite = candidate.trim();
    if (!favorite) continue;
    const key = favorite.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    favorites.push(favorite);
  }
  return favorites;
}

export function parseMemberCalorieTargets(value: string | readonly MemberCalorieTarget[]): MemberCalorieTarget[] {
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    return value.map((profile, index) => {
      const name = String(profile.name ?? "").trim();
      if (!name) throw new Error(`Calorie profile ${index + 1} needs a name.`);
      const key = name.toLocaleLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate calorie profile name: "${name}".`);
      seen.add(key);
      return { name, dailyCalorieTarget: boundedCalorieTarget(Number(profile.dailyCalorieTarget)) };
    });
  }

  const raw = String(value).trim();
  if (!raw) return [];
  const seen = new Set<string>();
  return raw
    .replace(/(\d),(?=\d)/g, "$1")
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const match = entry.match(/^(.+?)\s*[:=]\s*([\d,]+)\s*(?:kcal|calories|cal)?(?:\s*\/?\s*day)?$/i);
      if (!match) {
        throw new Error(`Calorie profile ${index + 1} must look like "Name: 2500".`);
      }
      const name = match[1].trim();
      const key = name.toLocaleLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate calorie profile name: "${name}".`);
      seen.add(key);
      return {
        name,
        dailyCalorieTarget: boundedCalorieTarget(Number(match[2].replaceAll(",", ""))),
      };
    });
}

export function householdDailyCalorieTarget(profiles: readonly MemberCalorieTarget[]): number {
  return profiles.reduce((sum, profile) => sum + profile.dailyCalorieTarget, 0);
}

export function calculateMealCalories(items: readonly CalorieItem[]): number {
  return Math.round(
    items.reduce((sum, item) => {
      if (!Number.isFinite(item.estimatedCalories) || item.estimatedCalories < 0) {
        throw new Error(`Invalid estimated calories for "${item.name}".`);
      }
      return sum + item.estimatedCalories;
    }, 0),
  );
}

export function calculatePlanCalories(days: readonly CalorieDay[]): DayCalorieAudit[] {
  return days.map((day) => {
    const memberTotals = new Map<string, MemberCalorieAllocation>();
    const meals = day.meals.map((meal) => {
      const calculatedCalories = calculateMealCalories(meal.items);
      const reportedCalories = Math.round(meal.totalCalories ?? calculatedCalories);
      const memberCalories = (meal.memberCalories ?? []).map((allocation) => ({
        name: allocation.name.trim(),
        estimatedCalories: Math.round(allocation.estimatedCalories),
      }));
      const allocatedCalories = calculateMealCalories(memberCalories);
      for (const allocation of memberCalories) {
        const key = allocation.name.toLocaleLowerCase();
        const existing = memberTotals.get(key);
        if (existing) existing.estimatedCalories += allocation.estimatedCalories;
        else memberTotals.set(key, { ...allocation });
      }
      return {
        name: meal.name,
        calculatedCalories,
        reportedCalories,
        difference: reportedCalories - calculatedCalories,
        memberCalories,
        memberAllocationDifference: allocatedCalories - calculatedCalories,
      };
    });
    const calculatedTotalCalories = meals.reduce((sum, meal) => sum + meal.calculatedCalories, 0);
    const reportedTotalCalories = Math.round(day.dailyTotalCalories ?? calculatedTotalCalories);
    return {
      day: day.day,
      calculatedTotalCalories,
      reportedTotalCalories,
      difference: reportedTotalCalories - calculatedTotalCalories,
      meals,
      memberTotals: [...memberTotals.values()],
    };
  });
}

export function favoriteCoverage(
  days: readonly CalorieDay[],
  favorites: readonly string[],
): { matched: string[]; unmatched: string[] } {
  const haystack = days
    .flatMap((day) => day.meals.flatMap((meal) => [meal.name, ...meal.items.map((item) => item.name)]))
    .join("\n")
    .toLocaleLowerCase();
  const matched = favorites.filter((favorite) => {
    const tokens = favorite.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? [];
    return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
  });
  return {
    matched,
    unmatched: favorites.filter((favorite) => !matched.includes(favorite)),
  };
}

export function groupByStoreSection<T extends { storeSection: string }>(items: readonly T[]): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((groups, item) => {
    const section = item.storeSection.trim() || "other";
    (groups[section] ??= []).push(item);
    return groups;
  }, {});
}
