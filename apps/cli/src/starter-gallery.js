const INSTALL_COMMAND = "smithers init --add-agents";

export const STARTER_AUDIENCES = [
    "founder",
    "product",
    "operations",
    "support",
    "marketing",
    "quality",
    "engineering",
];

export const STARTER_GOALS = [
    "plan",
    "research",
    "build",
    "debug",
    "review",
    "quality",
    "coordinate",
];

/**
 * @typedef {{
 *   id: string;
 *   aliases: string[];
 *   title: string;
 *   audience: string[];
 *   goals: string[];
 *   workflow: string;
 *   outcome: string;
 *   setup: string[];
 *   prompt: string;
 *   followUps: string[];
 *   goodFor: string[];
 *   avoidWhen: string;
 *   tags: string[];
 * }} StarterRecipe
 */

/** @type {StarterRecipe[]} */
export const STARTER_RECIPES = [
    {
        id: "idea-to-prd",
        aliases: ["prd", "product-brief"],
        title: "Turn a rough idea into a product brief",
        audience: ["founder", "product", "marketing"],
        goals: ["plan"],
        workflow: "write-a-prd",
        outcome: "A structured PRD with goals, users, scope, risks, launch notes, and open questions.",
        setup: [
            "Collect any notes, customer quotes, links, screenshots, or constraints in the prompt.",
            "Name the user, business goal, and deadline if those are known.",
        ],
        prompt: "Draft a PRD for a self-serve onboarding flow that helps new customers finish setup in under ten minutes.",
        followUps: [
            "smithers workflow run tickets-create --prompt \"Break this PRD into implementation tickets\"",
            "smithers workflow run grill-me --prompt \"Interview me until the unclear PRD requirements are actionable\"",
        ],
        goodFor: ["new feature ideas", "executive alignment", "scope decisions"],
        avoidWhen: "You already have implementation-ready tickets.",
        tags: ["product", "requirements", "launch"],
    },
    {
        id: "idea-to-tickets",
        aliases: ["tickets", "project-plan"],
        title: "Break a project into implementation tickets",
        audience: ["founder", "product", "operations", "engineering"],
        goals: ["plan", "coordinate"],
        workflow: "tickets-create",
        outcome: "A batch of scoped tickets that can be assigned, reviewed, and tracked.",
        setup: [
            "Start from a PRD, customer request, incident summary, or internal project note.",
            "Mention deadlines, dependencies, owners, and must-not-break constraints.",
        ],
        prompt: "Break our billing cleanup project into tickets. Include data migration, customer messaging, QA, rollback, and owner handoff work.",
        followUps: [
            "smithers workflow run kanban --prompt \"Implement the tickets in .smithers/tickets\"",
            "smithers workflow run plan --prompt \"Sequence these tickets into milestones\"",
        ],
        goodFor: ["roadmap planning", "handoffs", "large changes"],
        avoidWhen: "The request is still too vague to estimate.",
        tags: ["tickets", "planning", "coordination"],
    },
    {
        id: "launch-checklist",
        aliases: ["launch", "release-plan"],
        title: "Prepare a launch checklist",
        audience: ["founder", "product", "marketing", "operations"],
        goals: ["plan", "coordinate"],
        workflow: "plan",
        outcome: "A launch plan with phases, owners, validation gates, communications, and rollback checks.",
        setup: [
            "Provide the launch date, intended audience, channels, and known risk areas.",
            "Include any docs, analytics, or support constraints that should be checked.",
        ],
        prompt: "Create a launch checklist for releasing team invitations to all customers next Friday.",
        followUps: [
            "smithers workflow run review --prompt \"Review this launch plan for missed risks\"",
            "smithers workflow run ticket-create --prompt \"Create one ticket for the highest-risk launch gap\"",
        ],
        goodFor: ["go-to-market work", "internal rollouts", "customer-facing releases"],
        avoidWhen: "The launch owner has not approved the scope.",
        tags: ["launch", "operations", "planning"],
    },
    {
        id: "customer-incident",
        aliases: ["incident", "support-debug"],
        title: "Turn a customer report into a fix path",
        audience: ["support", "operations", "engineering"],
        goals: ["debug", "coordinate"],
        workflow: "debug",
        outcome: "A reproduction plan, suspected root cause, fix, validation notes, and customer-safe summary.",
        setup: [
            "Paste the customer report, timestamps, account details that are safe to share, and expected behavior.",
            "Include logs or screenshots when available.",
        ],
        prompt: "A customer says exports fail after selecting more than 500 rows. Reproduce the issue, fix it, and summarize customer impact.",
        followUps: [
            "smithers workflow run review --prompt \"Review the incident fix and customer summary\"",
            "smithers workflow run audit --prompt \"Find similar export reliability risks\"",
        ],
        goodFor: ["support escalations", "bug reports", "urgent regressions"],
        avoidWhen: "The report contains secrets that should not be sent to local tools.",
        tags: ["support", "debugging", "incident"],
    },
    {
        id: "nontechnical-research",
        aliases: ["research-brief", "market-research"],
        title: "Create a research brief before committing work",
        audience: ["founder", "product", "marketing", "operations"],
        goals: ["research", "plan"],
        workflow: "research",
        outcome: "A grounded brief with findings, assumptions, tradeoffs, and recommended next steps.",
        setup: [
            "Ask a specific question and list any sources, competitors, docs, or constraints to consider.",
            "Say whether you want a decision, a summary, or a list of options.",
        ],
        prompt: "Research whether we should add a public template gallery. Compare user value, maintenance cost, and launch risk.",
        followUps: [
            "smithers workflow run write-a-prd --prompt \"Turn this research into a PRD\"",
            "smithers workflow run plan --prompt \"Make a practical execution plan from this research\"",
        ],
        goodFor: ["strategy questions", "competitive scans", "before-build decisions"],
        avoidWhen: "The answer depends on live private data that is not available in the repo.",
        tags: ["research", "strategy", "brief"],
    },
    {
        id: "requirements-interview",
        aliases: ["clarify", "discovery"],
        title: "Clarify a vague request",
        audience: ["founder", "product", "support", "engineering"],
        goals: ["plan"],
        workflow: "grill-me",
        outcome: "A tighter requirement set after the workflow asks targeted questions.",
        setup: [
            "Start with the messy request exactly as it came in.",
            "Answer the questions directly; the point is to remove ambiguity before work starts.",
        ],
        prompt: "We need a better admin experience for enterprise customers, but the scope is unclear.",
        followUps: [
            "smithers workflow run write-a-prd --prompt \"Turn the clarified requirements into a PRD\"",
            "smithers workflow run tickets-create --prompt \"Create tickets from the clarified requirements\"",
        ],
        goodFor: ["ambiguous stakeholder asks", "sales feedback", "pre-ticket discovery"],
        avoidWhen: "You need implementation work immediately and already know the scope.",
        tags: ["requirements", "discovery", "planning"],
    },
    {
        id: "quality-audit",
        aliases: ["audit", "risk-audit"],
        title: "Audit a product area for quality gaps",
        audience: ["quality", "product", "engineering", "operations"],
        goals: ["quality", "review"],
        workflow: "audit",
        outcome: "A prioritized list of missing tests, docs, observability, reliability, and maintainability gaps.",
        setup: [
            "Name the feature area or workflow to inspect.",
            "Mention the standard you care about: reliability, speed, safety, supportability, or docs.",
        ],
        prompt: "Audit the checkout flow for missing tests, unclear docs, weak observability, and support risks.",
        followUps: [
            "smithers workflow run improve-test-coverage --prompt \"Add the highest-impact missing tests from this audit\"",
            "smithers workflow run ticket-create --prompt \"Create a ticket for the top audit finding\"",
        ],
        goodFor: ["release readiness", "technical debt triage", "risk reviews"],
        avoidWhen: "You only need a single known bug fixed.",
        tags: ["audit", "quality", "risk"],
    },
    {
        id: "test-coverage",
        aliases: ["coverage", "tests"],
        title: "Add high-impact test coverage",
        audience: ["quality", "engineering", "product"],
        goals: ["quality", "build"],
        workflow: "improve-test-coverage",
        outcome: "Focused tests around behavior that matters, with validation that the suite still passes.",
        setup: [
            "Name the feature, package, or bug class where coverage is weak.",
            "Call out user-visible behavior and risky edge cases.",
        ],
        prompt: "Improve test coverage for subscription downgrade behavior, especially invoices, entitlements, and rollback cases.",
        followUps: [
            "smithers workflow run review --prompt \"Review the new tests for meaningful assertions\"",
            "smithers workflow run audit --prompt \"Find the next highest-value coverage gap\"",
        ],
        goodFor: ["pre-release hardening", "regression prevention", "quality drives"],
        avoidWhen: "The feature is still changing too quickly for durable tests.",
        tags: ["tests", "quality", "coverage"],
    },
    {
        id: "ship-a-change",
        aliases: ["build", "implement"],
        title: "Ship a focused change",
        audience: ["founder", "product", "engineering"],
        goals: ["build"],
        workflow: "research-plan-implement",
        outcome: "Research, an implementation plan, code changes, validation, and review loops in one run.",
        setup: [
            "Give the exact user outcome and any files, APIs, screenshots, or acceptance criteria.",
            "Keep the first request narrow enough to review in one pull request.",
        ],
        prompt: "Add a first-run checklist that helps a new workspace owner invite teammates and finish setup.",
        followUps: [
            "smithers workflow run review --prompt \"Review the completed change before opening a PR\"",
            "smithers workflow run debug --prompt \"Fix the most important failure found during validation\"",
        ],
        goodFor: ["product polish", "small features", "workflow improvements"],
        avoidWhen: "The change needs executive or legal approval before implementation.",
        tags: ["implementation", "feature", "shipping"],
    },
    {
        id: "mission-mode",
        aliases: ["large-project", "milestones"],
        title: "Run a larger project in approved milestones",
        audience: ["founder", "product", "engineering", "operations"],
        goals: ["build", "coordinate"],
        workflow: "mission",
        outcome: "A milestone plan, checkpoint approvals, focused workers, validation, and a final delivery summary.",
        setup: [
            "Write the desired end state and constraints.",
            "Be ready to approve or revise milestones before execution continues.",
        ],
        prompt: "Modernize the onboarding funnel across copy, setup tasks, analytics, and support handoff without changing billing behavior.",
        followUps: [
            "smithers ps",
            "smithers inspect <run-id>",
        ],
        goodFor: ["multi-step projects", "cross-functional work", "large refactors"],
        avoidWhen: "The work should be a quick one-file change.",
        tags: ["milestones", "coordination", "shipping"],
    },
];

/**
 * @param {string} value
 */
function normalize(value) {
    return value.trim().toLowerCase();
}

/**
 * @param {string} value
 */
function shellQuote(value) {
    return `"${value.replace(/["\\$`]/g, "\\$&").replace(/\r?\n/g, "\\n")}"`;
}

/**
 * @param {StarterRecipe} recipe
 */
export function starterCommand(recipe) {
    return `smithers workflow run ${recipe.workflow} --prompt ${shellQuote(recipe.prompt)}`;
}

/**
 * @param {StarterRecipe} recipe
 */
function starterSummary(recipe) {
    return {
        id: recipe.id,
        title: recipe.title,
        audience: recipe.audience,
        goals: recipe.goals,
        workflow: recipe.workflow,
        outcome: recipe.outcome,
        command: starterCommand(recipe),
        tags: recipe.tags,
    };
}

/**
 * @param {string | undefined} id
 */
export function findStarterRecipe(id) {
    if (!id)
        return undefined;
    const key = normalize(id);
    return STARTER_RECIPES.find((recipe) => recipe.id === key || recipe.aliases.includes(key));
}

/**
 * @param {{ audience?: string; goal?: string; workflow?: string; tag?: string }} [filters]
 */
export function listStarterRecipes(filters = {}) {
    const audience = filters.audience ? normalize(filters.audience) : undefined;
    const goal = filters.goal ? normalize(filters.goal) : undefined;
    const workflow = filters.workflow ? normalize(filters.workflow) : undefined;
    const tag = filters.tag ? normalize(filters.tag) : undefined;
    return STARTER_RECIPES.filter((recipe) => {
        if (audience && !recipe.audience.includes(audience))
            return false;
        if (goal && !recipe.goals.includes(goal))
            return false;
        if (workflow && recipe.workflow !== workflow)
            return false;
        if (tag && !recipe.tags.includes(tag))
            return false;
        return true;
    });
}

/**
 * @param {{ id?: string; audience?: string; goal?: string; workflow?: string; tag?: string }} [input]
 */
export function buildStarterGallery(input = {}) {
    const selected = input.id ? findStarterRecipe(input.id) : undefined;
    const filters = {
        audience: input.audience ?? null,
        goal: input.goal ?? null,
        workflow: input.workflow ?? null,
        tag: input.tag ?? null,
    };
    const recipes = selected ? [selected] : listStarterRecipes(input);
    return {
        installCommand: INSTALL_COMMAND,
        filters,
        count: recipes.length,
        audiences: STARTER_AUDIENCES,
        goals: STARTER_GOALS,
        selected: selected
            ? {
                ...selected,
                command: starterCommand(selected),
            }
            : null,
        starters: recipes.map(starterSummary),
    };
}

/**
 * @param {string[]} values
 */
function renderInlineList(values) {
    return values.length > 0 ? values.join(", ") : "none";
}

/**
 * @param {ReturnType<typeof buildStarterGallery>} gallery
 */
export function renderStarterGallery(gallery) {
    const lines = [];
    if (gallery.selected) {
        const recipe = gallery.selected;
        lines.push(recipe.title);
        lines.push("");
        lines.push(`Starter ID: ${recipe.id}`);
        lines.push(`Best for: ${renderInlineList(recipe.audience)}`);
        lines.push(`Goals: ${renderInlineList(recipe.goals)}`);
        lines.push(`Workflow: ${recipe.workflow}`);
        lines.push("");
        lines.push("Outcome:");
        lines.push(recipe.outcome);
        lines.push("");
        lines.push("Before you run it:");
        for (const step of recipe.setup) {
            lines.push(`- ${step}`);
        }
        lines.push("");
        lines.push("Run:");
        lines.push(recipe.command);
        lines.push("");
        lines.push("Useful follow-ups:");
        for (const command of recipe.followUps) {
            lines.push(`- ${command}`);
        }
        lines.push("");
        lines.push(`Good for: ${renderInlineList(recipe.goodFor)}`);
        lines.push(`Avoid when: ${recipe.avoidWhen}`);
        return lines.join("\n");
    }
    lines.push("Smithers starters");
    lines.push("");
    lines.push("Pick a plain-English outcome, run one command, and let the seeded workflow do the structured work.");
    lines.push(`First-time setup: ${gallery.installCommand}`);
    lines.push("");
    if (gallery.count === 0) {
        lines.push("No starters matched those filters.");
        lines.push("Try: smithers starters --audience product");
        lines.push("Try: smithers starters --goal quality");
        return lines.join("\n");
    }
    for (const starter of gallery.starters) {
        lines.push(`${starter.id}`);
        lines.push(`  ${starter.title}`);
        lines.push(`  For: ${renderInlineList(starter.audience)} | Goals: ${renderInlineList(starter.goals)} | Workflow: ${starter.workflow}`);
        lines.push(`  Outcome: ${starter.outcome}`);
        lines.push(`  Run: ${starter.command}`);
        lines.push("");
    }
    lines.push("Use `smithers starters <id>` for setup notes and follow-ups.");
    lines.push("Filter examples: `smithers starters --audience product`, `smithers starters --goal quality`, `smithers starters --workflow debug`.");
    return lines.join("\n");
}
