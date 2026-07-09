export const RECIPE_GITHUB_BASE =
  "https://github.com/smithersai/smithers/blob/main/.smithers/workflows";

/** Built-in workflows from github.com/smithersai/smithers/.smithers/workflows */
export const RECIPE_MARQUEE_SLUGS = [
  "hello",
  "implement",
  "validated-implement",
  "mission",
  "kanban",
  "plan",
  "review",
  "debug",
  "ralph",
  "grill-me",
  "ultragrill",
  "research",
  "research-plan-implement",
  "route-task",
  "audit",
  "audit-burndown",
  "audit-fix-train",
  "bulletproof-audit",
  "backpressure-plan",
  "context-engineer",
  "context-doctor",
  "context-engineering-levers",
  "create-skill",
  "create-workflow",
  "workflow-skill",
  "extract-skill",
  "extract-prompt",
  "eval-author",
  "feature-enum",
  "fix-all-issues",
  "fix-six-issues",
  "merge-train-all-issues",
  "plan-implement-review-issues",
  "ship-pipeline",
  "open-code-review",
  "review-cloud-ship",
  "coverage-codex-swarm",
  "improve-test-coverage",
  "verify-push-safety",
  "ticket-create",
  "tickets-create",
  "triage-run",
  "close-issues",
  "sweep",
  "monitor",
  "monitor-smithers",
  "smithering",
  "release",
  "release-content",
  "investor",
  "report-slideshow",
  "repo-prospector",
  "roadmapbench",
  "vcs",
  "sync-features",
  "consolidate-tanstack-db",
  "tanstack-db-migration",
  "postgres-tanstack-sync",
  "grill-all-three",
] as const;

export type RecipeMarqueeItem = {
  slug: (typeof RECIPE_MARQUEE_SLUGS)[number];
  href: string;
};

export function recipeGithubHref(slug: string) {
  return `${RECIPE_GITHUB_BASE}/${slug}.tsx`;
}

export const RECIPE_MARQUEE_ITEMS: RecipeMarqueeItem[] = RECIPE_MARQUEE_SLUGS.map(
  (slug) => ({
    slug,
    href: recipeGithubHref(slug),
  }),
);

function chunkIntoRows<T>(items: T[], rowCount: number): T[][] {
  const rows = Array.from({ length: rowCount }, () => [] as T[]);
  items.forEach((item, index) => {
    rows[index % rowCount]!.push(item);
  });
  return rows;
}

export const RECIPE_MARQUEE_ROWS = chunkIntoRows(RECIPE_MARQUEE_ITEMS, 4);

export const RECIPE_MARQUEE_ROW_CONFIG = [
  { duration: "44s", reverse: false },
  { duration: "56s", reverse: true },
  { duration: "40s", reverse: false },
  { duration: "52s", reverse: true },
] as const;
