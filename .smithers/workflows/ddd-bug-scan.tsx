// smithers-display-name: DDD Bug Scan
// smithers-description: Async read-only bug hunt over the product surface — codex finds, claude-fable-5 adversarially verifies, confirmed bugs become real tickets and features.json gaps.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";
import { dddRootOrCwd } from "../lib/ddd/dddRoot.ts";

const ROOT = dddRootOrCwd();

const codex = providers.codex;

const inputSchema = z.object({
  maxFindings: z.preprocess((v) => v ?? undefined, z.number().int().min(1).max(20).default(8)),
  useClaudeForPlanning: z.preprocess((v) => v ?? undefined, z.boolean().default(true)),
});

const findingSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.enum(["critical", "major", "minor"]).default("minor"),
  featureId: z.string().default(""),
  file: z.string().default(""),
  evidence: z.string().default(""),
  suggestedFix: z.string().default(""),
});

const scanSchema = z.object({
  findings: z.array(findingSchema).default([]),
  areasCovered: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const verifySchema = z.object({
  confirmed: z.array(findingSchema).default([]),
  rejected: z.array(z.object({ id: z.string(), reason: z.string().default("") })).default([]),
  summary: z.string().default(""),
});

const ticketsSchema = z.object({
  created: z.number().int().min(0).default(0),
  skippedExisting: z.number().int().min(0).default(0),
  ticketPaths: z.array(z.string()).default([]),
  featuresUpdated: z.array(z.string()).default([]),
  buildPassed: z.boolean().default(false),
  summary: z.string().default(""),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  scan: scanSchema,
  verify: verifySchema,
  tickets: ticketsSchema,
});

function verifyAgent(ctx: any) {
  return ctx.input.useClaudeForPlanning !== false ? providers.claude : codex;
}

export function bugSlug(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "bug";
}

export function bugTicketMarkdown(runId: string, finding: any): string {
  return [
    `# ${finding.title || finding.id}`,
    "",
    "Status: todo",
    `Run: ${runId}`,
    `Kind: fix`,
    `Severity: ${finding.severity ?? "minor"}`,
    `Feature: ${finding.featureId ?? ""}`,
    finding.featureTitle ? `Feature title: ${finding.featureTitle}` : "",
    `File: ${finding.file ?? ""}`,
    "",
    "## Evidence",
    "",
    String(finding.evidence || "No evidence recorded."),
    "",
    "## Suggested fix",
    "",
    String(finding.suggestedFix || "Not specified."),
  ].filter((line) => line !== "").join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Materialize confirmed findings as tickets and features.json gaps, then
 * rebuild the derived docs so the UI backlog picks them up. Dedupe: a finding
 * whose ticket file already exists (same slug) is skipped, so re-running the
 * scan never double-files.
 */
export function fileBugTickets(runId: string, confirmed: any[], root: string = ROOT) {
  const directory = resolve(root, ".smithers/tickets");
  mkdirSync(directory, { recursive: true });
  const ticketPaths: string[] = [];
  let skippedExisting = 0;
  const featureTitles = new Map<string, string>();
  const featuresPath = resolve(root, ".smithers/spec/features.json");
  try {
    const features = JSON.parse(readFileSync(featuresPath, "utf8")) as Array<Record<string, any>>;
    for (const feature of features) featureTitles.set(String(feature.id ?? ""), String(feature.title ?? ""));
  } catch {
    // Tickets still carry the finding even when the spec cannot be read.
  }

  for (const finding of confirmed) {
    const enrichedFinding = {
      ...finding,
      featureTitle: finding.featureTitle ?? featureTitles.get(String(finding.featureId ?? "")) ?? "",
    };
    const name = `ddd-bug-scan--${bugSlug(finding.file || finding.featureId || "repo")}--${bugSlug(finding.title || finding.id)}.md`;
    const full = resolve(directory, name);
    if (existsSync(full)) {
      skippedExisting += 1;
      continue;
    }
    writeFileSync(full, bugTicketMarkdown(runId, enrichedFinding));
    ticketPaths.push(name);
  }

  // Record each confirmed bug as a missing[] gap on its feature so the spec
  // stays the source of truth and the generated backlog includes it.
  const featuresUpdated: string[] = [];
  try {
    const features = JSON.parse(readFileSync(featuresPath, "utf8")) as Array<Record<string, any>>;
    for (const finding of confirmed) {
      const feature = features.find((f) => f.id === finding.featureId);
      if (!feature) continue;
      const gap = `Bug (${finding.severity}): ${finding.title}${finding.file ? ` [${finding.file}]` : ""}`;
      const missing: string[] = Array.isArray(feature.missing) ? feature.missing : [];
      if (missing.includes(gap)) continue;
      feature.missing = [...missing, gap];
      if (!featuresUpdated.includes(feature.id)) featuresUpdated.push(feature.id);
    }
    if (featuresUpdated.length > 0) {
      writeFileSync(featuresPath, `${JSON.stringify(features, null, 2)}\n`);
    }
  } catch {
    // No readable spec: tickets alone still carry the findings.
  }

  let buildPassed = false;
  try {
    execFileSync("bun", [".smithers/lib/ddd/build.ts"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    buildPassed = true;
  } catch {
    buildPassed = false;
  }

  return {
    created: ticketPaths.length,
    skippedExisting,
    ticketPaths,
    featuresUpdated,
    buildPassed,
    summary:
      confirmed.length === 0
        ? "No confirmed findings; nothing filed."
        : `Filed ${ticketPaths.length} ticket(s) (${skippedExisting} already existed), updated ${featuresUpdated.length} feature record(s), build ${buildPassed ? "passed" : "FAILED"}.`,
  };
}

const SCAN_RULES = `
Rules:
- READ-ONLY: do not modify any file. Your job is finding and evidencing, not fixing.
- Start with "bun .smithers/lib/ddd/auditInputs.ts" for the bounded product-surface file list, then read targeted files. Do not recursively read .smithers/executions or .smithers/pg.
- A finding needs concrete evidence: the exact file and line behavior, the input that breaks it, or the failing command. "This looks suspicious" is not a finding.
- featureId must be an id from .smithers/spec/features.json when the bug belongs to a tracked feature, else "".
- Do not print secrets or tokens.
`;

export default smithers((ctx) => {
  const maxFindings = Math.min(20, Math.max(1, Number(ctx.input.maxFindings ?? 8) || 8));

  return (
    <Workflow name="ddd-bug-scan">
      <Sequence>
        <Task id="scan" output={outputs.scan} agent={codex} retries={1} timeoutMs={40 * 60 * 1000}>
          {`You are a bug hunter doing the initial sync scan over this repo's product surface. Hunt for real defects: logic errors, broken error paths, unhandled null/empty inputs, race conditions, stale docs that contradict code, tests that assert the wrong thing. Report at most ${maxFindings} findings, worst first, each with concrete evidence. Return only JSON matching the scan schema. ${SCAN_RULES}`}
        </Task>

        <Task
          id="verify"
          output={outputs.verify}
          agent={verifyAgent(ctx)}
          retries={1}
          timeoutMs={30 * 60 * 1000}
          dependsOn={["scan"]}
          deps={{ scan: outputs.scan }}
        >
          {(deps: any) => `Adversarially verify each finding below. For each one, try to REFUTE it by reading the actual code and, where cheap, running the evidencing command. Confirmed findings go to "confirmed" (correct their fields if the evidence sharpened them); refuted or unproven ones go to "rejected" with the reason. Default to rejected when uncertain — a false ticket is worse than a missed one on the first sync. READ-ONLY. Return only JSON matching the verify schema.

Findings:
${JSON.stringify(deps.scan?.findings ?? [], null, 2)}
${SCAN_RULES}`}
        </Task>

        <Task
          id="file-tickets"
          output={outputs.tickets}
          dependsOn={["verify"]}
          deps={{ verify: outputs.verify }}
        >
          {(deps: any) =>
            fileBugTickets(
              String((ctx as any).runId ?? "unknown-run"),
              Array.isArray(deps.verify?.confirmed) ? deps.verify.confirmed : [],
            )
          }
        </Task>
      </Sequence>
    </Workflow>
  );
});
