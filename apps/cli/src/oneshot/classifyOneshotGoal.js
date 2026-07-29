// Task-shape classifier for oneshot model routing (registry v8 doctrine, see
// docs/data/sota-models.json `routing.oneshot`): UI-flavored goals lead with
// Kimi K3, everything else leads with Claude Opus 5. Keyword match on word
// boundaries; misses fall to "general" (Opus), which is the safe default.
const UI_PATTERN =
  /\b(ui|ux|frontend|front[- ]end|css|tailwind|stylesheets?|styling|layouts?|responsive|animations?|components?|buttons?|landing( page)?|pages?|mockups?|wireframes?|themes?|theming|dark mode|html|tsx|jsx|react|vue|svelte|webpages?|web pages?|websites?|web apps?|webapps?|heros?|navbars?|nav bars?|sidebars?|modals?|dropdowns?|typography|figma|dashboards?|redesign|web design|user interface|dom|svg)\b/i;

/**
 * @param {string | undefined} goal
 * @returns {"ui" | "general"}
 */
export function classifyOneshotGoal(goal) {
  return UI_PATTERN.test(goal ?? "") ? "ui" : "general";
}
