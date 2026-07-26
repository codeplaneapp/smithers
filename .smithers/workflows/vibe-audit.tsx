// smithers-display-name: Vibe Audit
/** @jsxImportSource smithers-orchestrator */
import { Parallel, Sequence, UI, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

/**
 * Security-review orchestrator modeled on the community project vibeaudit
 * (github.com/aviggiano/vibeaudit): point it at a repository, run audit
 * strategies in parallel, then dedupe, triage, and aggregate the findings into
 * one report. Deterministic fixture used by the demo-day deck capture
 * (apps/demoday-site): compute tasks with canned findings so every recorded
 * run streams the same way. The deps-audit strategy fails its first attempt
 * with a rate-limit-shaped error and succeeds on retry with a different agent
 * label — the deck's parked-on-quota / agent-failover beat.
 */

const findingSchema = z.object({
  findingKey: z.string(),
  title: z.string(),
  file: z.string(),
  severity: z.string(),
});

const strategySchema = z.object({
  strategy: z.string(),
  agentUsed: z.string(),
  findingsJson: z.string(),
  findingCount: z.number().int(),
});

const dedupeSchema = z.object({ mergedJson: z.string(), uniqueCount: z.number().int(), duplicateCount: z.number().int() });
const triageSchema = z.object({ triagedJson: z.string(), highCount: z.number().int(), mediumCount: z.number().int(), lowCount: z.number().int() });
const reportSchema = z.object({ reportMarkdown: z.string(), totalFindings: z.number().int(), strategiesRun: z.number().int() });

const inputSchema = z.object({
  repo: z.string().default("acme/payments-api"),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  vaInjection: strategySchema,
  vaAuth: strategySchema,
  vaSecrets: strategySchema,
  vaDeps: strategySchema,
  vaDedupe: dedupeSchema,
  vaTriage: triageSchema,
  vaReport: reportSchema,
});

type Finding = z.infer<typeof findingSchema>;

const STRATEGY_FINDINGS: Record<string, Finding[]> = {
  "injection-scan": [
    { findingKey: "sqli-orders", title: "String-built SQL in orders search", file: "src/orders/search.ts:88", severity: "high" },
    { findingKey: "xss-receipt", title: "Unescaped HTML in receipt renderer", file: "src/receipts/render.ts:41", severity: "medium" },
  ],
  "auth-review": [
    { findingKey: "admin-noauth", title: "Admin refund route missing auth check", file: "src/admin/refunds.ts:23", severity: "high" },
    { findingKey: "sqli-orders", title: "Search endpoint interpolates user input into SQL", file: "src/orders/search.ts:88", severity: "high" },
  ],
  "secrets-scan": [
    { findingKey: "aws-key", title: "Hardcoded AWS key in deploy script", file: "scripts/deploy.sh:12", severity: "high" },
    { findingKey: "stripe-test", title: "Stripe test secret committed in fixtures", file: "tests/fixtures/billing.json:3", severity: "low" },
  ],
  "deps-audit": [
    { findingKey: "lodash-cve", title: "lodash 4.17.15 — prototype pollution CVE", file: "package.json", severity: "medium" },
    { findingKey: "jwt-none", title: "jsonwebtoken allows alg:none downgrade", file: "package.json", severity: "high" },
  ],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function strategyRow(strategy: string, agentUsed: string) {
  const findings = STRATEGY_FINDINGS[strategy] ?? [];
  return {
    strategy,
    agentUsed,
    findingsJson: JSON.stringify(findings),
    findingCount: findings.length,
  };
}

/** First attempt per engine process fails like a provider 429; retry succeeds
 *  on the fallback agent. Keyed per run so a fresh run replays the beat. */
const depsAttemptsByRun = new Map<string, number>();

export default smithers((ctx) => {
  const runKey = String(ctx.input.repo ?? "demo");

  return (
    <Workflow name="vibe-audit">
      <UI entry="../ui/vibe-audit.tsx" title="Vibe Audit" />
      <Sequence>
        <Parallel>
          <Task id="injection-scan" output={outputs.vaInjection}>
            {async () => {
              await sleep(3600);
              return strategyRow("injection-scan", "claude-sonnet");
            }}
          </Task>
          <Task id="auth-review" output={outputs.vaAuth}>
            {async () => {
              await sleep(4800);
              return strategyRow("auth-review", "claude-sonnet");
            }}
          </Task>
          <Task id="secrets-scan" output={outputs.vaSecrets}>
            {async () => {
              await sleep(5600);
              return strategyRow("secrets-scan", "codex-luna");
            }}
          </Task>
          <Task id="deps-audit" output={outputs.vaDeps} retries={2}>
            {async () => {
              const attempts = (depsAttemptsByRun.get(runKey) ?? 0) + 1;
              depsAttemptsByRun.set(runKey, attempts);
              await sleep(attempts === 1 ? 1800 : 5000);
              if (attempts === 1) {
                throw new Error(
                  "RATE_LIMITED: anthropic 429 rate_limit_error — 5h quota exhausted, resets 03:00; parking task and retrying on fallback agent",
                );
              }
              return strategyRow("deps-audit", "codex-terra (fallback)");
            }}
          </Task>
        </Parallel>

        <Task id="dedupe" output={outputs.vaDedupe}>
          {async () => {
            await sleep(1500);
            const all = Object.values(STRATEGY_FINDINGS).flat();
            const seen = new Map<string, Finding>();
            for (const finding of all) if (!seen.has(finding.findingKey)) seen.set(finding.findingKey, finding);
            return {
              mergedJson: JSON.stringify([...seen.values()]),
              uniqueCount: seen.size,
              duplicateCount: all.length - seen.size,
            };
          }}
        </Task>

        <Task id="triage" output={outputs.vaTriage}>
          {async () => {
            await sleep(1500);
            const all = Object.values(STRATEGY_FINDINGS).flat();
            const unique = new Map<string, Finding>();
            for (const finding of all) if (!unique.has(finding.findingKey)) unique.set(finding.findingKey, finding);
            const merged = [...unique.values()];
            return {
              triagedJson: JSON.stringify(merged),
              highCount: merged.filter((f) => f.severity === "high").length,
              mediumCount: merged.filter((f) => f.severity === "medium").length,
              lowCount: merged.filter((f) => f.severity === "low").length,
            };
          }}
        </Task>

        <Task id="report" output={outputs.vaReport}>
          {async () => {
            await sleep(1400);
            const all = Object.values(STRATEGY_FINDINGS).flat();
            const unique = new Map<string, Finding>();
            for (const finding of all) if (!unique.has(finding.findingKey)) unique.set(finding.findingKey, finding);
            const merged = [...unique.values()];
            const lines = merged.map((f) => `- **${f.severity.toUpperCase()}** ${f.title} (\`${f.file}\`)`);
            return {
              reportMarkdown: `# Security review — ${runKey}\n\n${lines.join("\n")}\n`,
              totalFindings: merged.length,
              strategiesRun: Object.keys(STRATEGY_FINDINGS).length,
            };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
