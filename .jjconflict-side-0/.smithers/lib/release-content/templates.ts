import type { ReleaseAnalysis, ReleaseContentInput, TemplateSelection } from "./schemas";

export type ReleaseTemplate = {
  id: TemplateSelection["templateId"];
  label: string;
  useWhen: string[];
  defaultHook: string;
  requiredProof: string[];
  threadShape: string[];
  blogShape: string[];
  referenceExamples: string[];
};

export const RELEASE_TEMPLATES: ReleaseTemplate[] = [
  {
    id: "capability-reveal",
    label: "Capability Reveal",
    useWhen: ["new capability", "agent can now", "demo", "model", "autonomy"],
    defaultHook: "[Release] lets agents do [new behavior] without [old failure mode].",
    requiredProof: ["demo flow", "specific workflow", "docs or changelog source"],
    threadShape: [
      "announce new capability",
      "name the old ceiling",
      "show what changed",
      "give a concrete example",
      "explain why production agents need it",
      "CTA",
    ],
    blogShape: [
      "capability shift",
      "old failure modes",
      "what shipped",
      "walkthrough",
      "operator implications",
      "CTA",
    ],
    referenceExamples: ["OpenAI GPT-4o", "OpenAI ChatGPT agent", "Anthropic Claude 4", "Replit Agent 3"],
  },
  {
    id: "developer-api-contract",
    label: "Developer API / Stable Contract",
    useWhen: [
      "openapi",
      "rpc",
      "gateway",
      "sdk",
      "schema",
      "scopes",
      "client",
      "codegen",
      "protocol",
      "stable contract",
    ],
    defaultHook: "[Release] gives developers a stable contract for building on Smithers.",
    requiredProof: ["API surface", "schema", "example call or CLI"],
    threadShape: [
      "announce stable surface",
      "old brittle way",
      "what changed",
      "tiny example",
      "why it matters for agent systems",
      "CTA",
    ],
    blogShape: [
      "problem",
      "what shipped",
      "example",
      "design principles",
      "migration notes",
      "what this unlocks",
      "CTA",
    ],
    referenceExamples: [
      "OpenAI GPT-4.1 API",
      "Vercel AI SDK 5",
      "Vercel AI SDK 6",
      "Stripe Agentic Commerce Protocol",
      "shadcn/ui registries",
    ],
  },
  {
    id: "agent-workflow-primitive",
    label: "Agent Workflow Primitive",
    useWhen: [
      "approval",
      "replay",
      "resume",
      "hijack",
      "sandbox",
      "long-running",
      "control plane",
      "eval",
      "background agent",
      "diff bundle",
    ],
    defaultHook:
      "Agents are long-running workers that need state, control, permissions, and replay.",
    requiredProof: ["workflow primitive", "operator action", "failure mode"],
    threadShape: [
      "category statement",
      "failure modes",
      "new primitive",
      "example workflow",
      "why production agents need it",
      "CTA",
    ],
    blogShape: [
      "shift",
      "failure modes",
      "Smithers primitive",
      "walkthrough",
      "under the hood",
      "when to use it",
      "CTA",
    ],
    referenceExamples: [
      "GitHub Copilot coding agent",
      "Linear for Agents",
      "Cloudflare Browser Run",
      "Trigger.dev v4",
      "Inngest durable execution for agents",
    ],
  },
  {
    id: "production-hardening",
    label: "Production Hardening",
    useWhen: [
      "fail-closed",
      "auth",
      "scope",
      "permission",
      "fault injection",
      "observability",
      "ci",
      "hot reload",
      "audit",
      "reliability",
      "security",
      "hardening",
    ],
    defaultHook: "[Release] is a production-readiness release for Smithers.",
    requiredProof: ["failure mode", "safe default", "operator impact"],
    threadShape: [
      "plain production-readiness hook",
      "why failures happen",
      "what changed",
      "safe default",
      "operator result",
      "CTA",
    ],
    blogShape: [
      "why this release exists",
      "what changed",
      "important defaults",
      "operator workflow",
      "upgrade notes",
      "next",
    ],
    referenceExamples: [
      "Cloudflare AI Agents platform",
      "Cloudflare Dynamic Workers",
      "Linear agent interaction guidelines",
      "Stripe Agentic Commerce Suite",
    ],
  },
  {
    id: "infra-performance",
    label: "Infrastructure Performance / Cost",
    useWhen: ["latency", "faster", "cost", "throughput", "scale", "performance", "cold start"],
    defaultHook: "[Release] makes Smithers [faster/cheaper/more reliable] for [workload].",
    requiredProof: ["old bottleneck", "new behavior", "metric or practical improvement"],
    threadShape: [
      "name the workload improvement",
      "old bottleneck",
      "new behavior",
      "under the hood",
      "what it unlocks",
      "CTA",
    ],
    blogShape: ["problem", "constraints", "architecture change", "results", "usage notes", "CTA"],
    referenceExamples: ["Vercel Fluid compute", "Railway V3", "Cloudflare Workers AI"],
  },
  {
    id: "major-version-migration",
    label: "Major Version / Migration",
    useWhen: ["ga", "stable", "major", "migration", "breaking", "v1", "v2", "codemod"],
    defaultHook: "Smithers [version] is out. [Main surface] is now [stable/default/GA].",
    requiredProof: ["breaking changes", "upgrade path", "why upgrade"],
    threadShape: ["version hook", "what changed", "what might break", "how to upgrade", "why upgrade", "CTA"],
    blogShape: ["what changed", "upgrade path", "breaking changes", "examples", "compatibility", "CTA"],
    referenceExamples: ["Next.js 15", "Deno 2", "Tailwind CSS v4", "Trigger.dev v4 GA"],
  },
  {
    id: "launch-roundup",
    label: "Launch Roundup",
    useWhen: ["launch week", "release train", "4+ unrelated user-visible features", "roundup"],
    defaultHook: "Smithers [version] is a release focused on [theme].",
    requiredProof: ["theme", "feature grouping", "per-feature CTA"],
    threadShape: ["theme", "highlights", "feature cluster 1", "feature cluster 2", "common thread", "CTA"],
    blogShape: ["theme", "highlights", "path by user type", "full changelog", "CTA"],
    referenceExamples: ["Supabase Launch Week", "Resend Launch Week", "Stripe Sessions", "Cloudflare AI Week"],
  },
  {
    id: "engineering-deep-dive",
    label: "Engineering Deep Dive",
    useWhen: ["architecture", "under the hood", "tradeoff", "scheduler", "engine", "fault", "state machine"],
    defaultHook: "We rebuilt [system]. The hard part was [specific engineering problem].",
    requiredProof: ["design constraints", "architecture detail", "tradeoff"],
    threadShape: ["problem", "why naive fails", "design constraints", "architecture", "result", "CTA"],
    blogShape: ["product problem", "systems problem", "constraints", "architecture", "tradeoffs", "result", "next"],
    referenceExamples: ["Linear Triage Intelligence", "Vercel Fluid deep dive", "Cloudflare agent platform deep dives"],
  },
  {
    id: "ecosystem-bridge",
    label: "Ecosystem Bridge",
    useWhen: ["github", "slack", "mcp", "stripe", "vercel", "cursor", "ci", "integration", "provider"],
    defaultHook: "Smithers now works with [ecosystem/tool].",
    requiredProof: ["integration point", "setup command or config", "workflow unlocked"],
    threadShape: ["integration hook", "example workflow", "setup", "what you get", "why it matters", "CTA"],
    blogShape: ["existing workflow", "what changes", "setup", "examples", "limits", "CTA"],
    referenceExamples: ["GitHub custom agents", "Supabase MCP", "Clerk shadcn registry", "Stripe ACP"],
  },
  {
    id: "category-thesis",
    label: "Founder / Category Thesis",
    useWhen: ["category", "thesis", "strategy", "runtime layer", "control plane"],
    defaultHook: "The next bottleneck for coding agents is execution.",
    requiredProof: ["category shift", "Smithers primitive", "release detail"],
    threadShape: ["category claim", "Smithers positioning", "release proof", "old stack", "new stack", "CTA"],
    blogShape: ["market shift", "runtime requirements", "what Smithers ships", "why now", "what comes next"],
    referenceExamples: ["OpenAI ChatGPT agent", "Vercel Fluid", "Linear agents", "Stripe agentic commerce"],
  },
  {
    id: "small-maintenance",
    label: "Small Maintenance",
    useWhen: ["patch", "fix", "docs", "maintenance", "cleanup"],
    defaultHook: "Smithers [version] is a focused maintenance release.",
    requiredProof: ["specific fixes", "affected commands", "upgrade note"],
    threadShape: ["patch hook", "fix cluster", "operator impact", "upgrade", "CTA"],
    blogShape: ["what changed", "why it matters", "upgrade notes", "full changelog"],
    referenceExamples: ["Focused changelog posts from Linear, Vercel, and Supabase"],
  },
];

function haystackFor(analysis: ReleaseAnalysis): string {
  return [
    analysis.title,
    analysis.oneSentenceSummary,
    analysis.releaseType,
    ...analysis.userVisibleChanges,
    ...analysis.internalChanges,
    ...analysis.breakingChanges,
    ...analysis.migrationNotes,
    ...analysis.proofAssets.map((p) => `${p.ref} ${p.quoteOrSummary}`),
  ]
    .join(" ")
    .toLowerCase();
}

function channelPlanFor(template: ReleaseTemplate): TemplateSelection["channelPlan"] {
  return {
    changelog: `Lead with ${template.label}; group implementation details under user-visible headings.`,
    tweetThread: `Use the ${template.label} thread shape: ${template.threadShape.join(" -> ")}.`,
    blogPost: `Use the ${template.label} blog shape: ${template.blogShape.join(" -> ")}.`,
  };
}

export function chooseTemplate(
  analysis: ReleaseAnalysis,
  config: ReleaseContentInput["template"],
): TemplateSelection {
  const blocked = new Set(config.blockedTemplateIds ?? []);
  const allowed = new Set(config.allowedTemplateIds ?? []);
  if (config.forceTemplateId) {
    if (blocked.has(config.forceTemplateId)) {
      throw new Error(`forceTemplateId "${config.forceTemplateId}" is also blocked`);
    }
    const forced = RELEASE_TEMPLATES.find((template) => template.id === config.forceTemplateId);
    if (!forced) throw new Error(`Unknown forceTemplateId "${config.forceTemplateId}"`);
    return {
      templateId: forced.id,
      confidence: 1,
      rationale: `Forced by workflow input. ${forced.label}: ${forced.defaultHook}`,
      channelPlan: channelPlanFor(forced),
      requiredClaims: forced.requiredProof,
      forbiddenClaims: [],
      candidateScores: { [forced.id]: 999 },
    };
  }

  const haystack = haystackFor(analysis);
  const candidateScores: Record<string, number> = {};
  let best: ReleaseTemplate | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const template of RELEASE_TEMPLATES) {
    if (blocked.has(template.id)) continue;
    if (allowed.size > 0 && !allowed.has(template.id)) continue;
    let score = template.useWhen.reduce(
      (total, phrase) => total + (haystack.includes(phrase.toLowerCase()) ? 1 : 0),
      0,
    );
    if (template.id === analysis.releaseType) score += 5;
    if (template.id === "launch-roundup" && analysis.userVisibleChanges.length >= 4) score += 3;
    if (template.id === "major-version-migration" && analysis.breakingChanges.length > 0) score += 2;
    if (template.id === "small-maintenance" && analysis.releaseType === "small-maintenance") score += 4;
    candidateScores[template.id] = score;
    if (score > bestScore) {
      bestScore = score;
      best = template;
    }
  }

  const selected =
    best ??
    RELEASE_TEMPLATES.find((template) => template.id === "agent-workflow-primitive") ??
    RELEASE_TEMPLATES[0];
  const maxPossible = selected.useWhen.length + 8;
  const confidence = Math.max(0.35, Math.min(0.95, bestScore / Math.max(1, maxPossible)));

  return {
    templateId: selected.id,
    confidence,
    rationale: `${selected.label} scored highest for this release. References: ${selected.referenceExamples.join(", ")}.`,
    channelPlan: channelPlanFor(selected),
    requiredClaims: selected.requiredProof,
    forbiddenClaims: [],
    candidateScores,
  };
}

export function getTemplate(id: TemplateSelection["templateId"]): ReleaseTemplate {
  const template = RELEASE_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) throw new Error(`Unknown template id "${id}"`);
  return template;
}
