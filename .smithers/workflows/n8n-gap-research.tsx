// smithers-source: user
// smithers-display-name: N8n Gap Research
// smithers-description: Parallel research fan-out — what n8n has that our MVP plan lacks (features, enterprise/compliance, billing/pricing, ecosystem, AI) — synthesized into an HTML report for will.
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { ClaudeCodeAgent, createSmithers, Parallel, Sequence } from "smthrs";
import { z } from "zod/v4";

const findingSchema = z.looseObject({
  facet: z.string().default(""),
  findings: z
    .array(
      z.looseObject({
        feature: z.string(),
        whatN8nDoes: z.string().default(""),
        whyItMatters: z.string().default(""),
        mvpRecommendation: z.enum(["must-have", "should-have", "later", "skip"]).default("later"),
        notes: z.string().default(""),
      }),
    )
    .default([]),
  summary: z.string().default(""),
});

const reportSchema = z.looseObject({
  reportPath: z.string().default(""),
  mustHaves: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const inputSchema = z.object({ prompt: z.string().default("") });

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  finding: findingSchema,
  report: reportSchema,
});

const researcher = new ClaudeCodeAgent({ model: "claude-fable-5" });

const FACETS: Array<{ id: string; brief: string }> = [
  {
    id: "core-features",
    brief:
      "n8n's core workflow features: editor capabilities, node types, expressions, error handling/retries, sub-workflows, versioning, variables, data pinning, partial executions, queue mode, webhooks, scheduling. Which do we lack?",
  },
  {
    id: "enterprise-compliance",
    brief:
      "n8n's enterprise/compliance surface: SOC2 status, SSO/SAML/LDAP, RBAC/projects/permissions, audit logs, log streaming, environments (dev/staging/prod), external secrets stores, air-gapped/self-host options, data residency. What does an enterprise buyer expect on day one?",
  },
  {
    id: "billing-pricing",
    brief:
      "n8n's pricing/packaging and how competitors (Make, Zapier, Temporal, trigger.dev) charge: metering axes (executions, active workflows, seats, operations), free tier shapes, trial mechanics, upgrade paths, billing stack (Stripe patterns). Recommend our pricing axes + Stripe integration scope for MVP — we currently have NO way to get paid; that is a must-fix.",
  },
  {
    id: "ecosystem-templates",
    brief:
      "n8n's ecosystem levers: 11k+ template gallery (their SEO/onboarding weapon), 400+ integrations, community forum, embed/white-label. What minimum ecosystem surface does our MVP need (template gallery seeded from our flows/connectors, docs, community)?",
  },
  {
    id: "ai-features",
    brief:
      "n8n's AI surface: AI Assistant (workflow drafting), AI agent nodes, LangChain integration, evaluations, MCP support. Where are we ahead (agents ARE our core) and what AI features do they market that we must match or reframe?",
  },
];

export default smithers((ctx) => (
  <Workflow name="n8n-gap-research">
    <UI entry="../ui/n8n-gap-research.tsx" title={"N8n Gap Research"} />
    <Sequence>
      <Parallel maxConcurrency={5}>
        {FACETS.map((facet) => (
          <Task key={facet.id} id={`gap:${facet.id}`} output={outputs.finding} agent={researcher}>
            {[
              `You are researching what our n8n-competitor MVP is missing. Our product: agent-first workflow automation on jjhub cloud infra — Repos (everything is a repo), real-time Branches, Flows (TypeScript files, /slash invocation, agent orchestration), Connectors (eliza-plugin-wrapped), chat-first UX with a fast concierge routing to specialist agents. Our current MVP plan: /Users/williamcory/flows/ui/TODO.md (read it first).`,
              `FACET "${facet.id}": ${facet.brief}`,
              `Use web research (WebSearch/WebFetch) for current n8n facts — do not rely on memory. For each finding: feature, whatN8nDoes, whyItMatters (for OUR segment), mvpRecommendation (must-have | should-have | later | skip) with honest skepticism — we ship an MVP for first revenue, not feature parity. Report facet="${facet.id}".`,
              ctx.input.prompt,
            ].join("\n\n")}
          </Task>
        ))}
      </Parallel>
      <Task id="gap:synthesize" output={outputs.report} agent={researcher}>
        {`Synthesize the five facet findings (previous node outputs in this run) into a single decision-ready report for will. Write it as a self-contained HTML file (inline CSS, dark theme, no external resources) at /Users/williamcory/Desktop/n8n-gap-report/index.html: executive summary, a must-have list (what blocks first revenue — billing is known to be missing), should-haves, explicit skips with reasoning, and a proposed TODO.md diff (new items under section 8 or a new section). Then open it with \`open\`. Report reportPath and the mustHaves list.`}
      </Task>
    </Sequence>
  </Workflow>
));
