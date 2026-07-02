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
  priority: z.enum(["p0", "p1", "p2"]).optional(),
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
  ticketCreationPassed: z.boolean().default(true),
  specUpdatePassed: z.boolean().default(true),
  buildPassed: z.boolean().default(false),
  ticketErrors: z.array(z.string()).default([]),
  specErrors: z.array(z.string()).default([]),
  buildErrors: z.array(z.string()).default([]),
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
    finding.priority ? `Priority: ${String(finding.priority).toUpperCase()}` : "",
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

function readableError(error: unknown): string {
  const anyError = error as { message?: unknown; stderr?: unknown; stdout?: unknown; status?: unknown };
  const parts = [
    anyError?.message ? String(anyError.message) : error instanceof Error ? error.message : String(error),
    anyError?.stderr ? String(anyError.stderr).trim() : "",
    anyError?.stdout ? String(anyError.stdout).trim() : "",
  ].filter(Boolean);
  const message = [...new Set(parts)].join("\n").trim();
  return message.length > 2000 ? `${message.slice(0, 2000).trimEnd()}...` : message;
}

function readFeatureRows(featuresPath: string): { features: Array<Record<string, any>>; error: string } {
  try {
    const parsed = JSON.parse(readFileSync(featuresPath, "utf8"));
    return {
      features: Array.isArray(parsed) ? parsed as Array<Record<string, any>> : [],
      error: Array.isArray(parsed) ? "" : `${featuresPath} did not contain a JSON array.`,
    };
  } catch (error) {
    return { features: [], error: `Failed to read ${featuresPath}: ${readableError(error)}` };
  }
}

/**
 * Materialize confirmed findings as tickets and features.json gaps, then
 * rebuild the derived docs so the UI backlog picks them up. Dedupe: a finding
 * whose ticket file already exists (same slug) is skipped, so re-running the
 * scan never double-files.
 */
export function fileBugTickets(runId: string, confirmed: any[], root: string = ROOT) {
  const directory = resolve(root, ".smithers/tickets");
  const ticketErrors: string[] = [];
  const specErrors: string[] = [];
  const buildErrors: string[] = [];
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    ticketErrors.push(`Failed to create ticket directory ${directory}: ${readableError(error)}`);
  }
  const ticketPaths: string[] = [];
  let skippedExisting = 0;
  const featureMeta = new Map<string, { title: string; priority: string }>();
  const featuresPath = resolve(root, ".smithers/spec/features.json");
  const initialFeatures = readFeatureRows(featuresPath);
  if (initialFeatures.error) {
    specErrors.push(initialFeatures.error);
  }
  for (const feature of initialFeatures.features) {
    featureMeta.set(String(feature.id ?? ""), {
      title: String(feature.title ?? ""),
      priority: String(feature.priority ?? ""),
    });
  }

  for (const finding of confirmed) {
    const enrichedFinding = {
      ...finding,
      featureTitle: finding.featureTitle ?? featureMeta.get(String(finding.featureId ?? ""))?.title ?? "",
      priority: finding.priority ?? featureMeta.get(String(finding.featureId ?? ""))?.priority ?? "",
    };
    const name = `ddd-bug-scan--${bugSlug(finding.file || finding.featureId || "repo")}--${bugSlug(finding.title || finding.id)}.md`;
    const full = resolve(directory, name);
    if (existsSync(full)) {
      skippedExisting += 1;
      continue;
    }
    try {
      writeFileSync(full, bugTicketMarkdown(runId, enrichedFinding));
      ticketPaths.push(name);
    } catch (error) {
      ticketErrors.push(`Failed to write ticket ${name}: ${readableError(error)}`);
    }
  }

  // Record each confirmed bug as a missing[] gap on its feature so the spec
  // stays the source of truth and the generated backlog includes it.
  const featuresUpdated: string[] = [];
  const updateFeatures = readFeatureRows(featuresPath);
  if (updateFeatures.error && !specErrors.includes(updateFeatures.error)) {
    specErrors.push(updateFeatures.error);
  }
  if (!updateFeatures.error) {
    const features = updateFeatures.features;
    for (const finding of confirmed) {
      const feature = features.find((f) => f.id === finding.featureId);
      if (!feature) continue;
      const gap = `Bug (${finding.severity}): ${finding.title}${finding.file ? ` [${finding.file}]` : ""}`;
      const missing: string[] = Array.isArray(feature.missing) ? feature.missing : [];
      let changed = false;
      if (!missing.includes(gap)) {
        feature.missing = [...missing, gap];
        changed = true;
      }
      if (feature.status === "fixed") {
        feature.status = "broken";
        changed = true;
      }
      if (changed && !featuresUpdated.includes(feature.id)) featuresUpdated.push(feature.id);
    }
    if (featuresUpdated.length > 0) {
      try {
        writeFileSync(featuresPath, `${JSON.stringify(features, null, 2)}\n`);
      } catch (error) {
        specErrors.push(`Failed to write ${featuresPath}: ${readableError(error)}`);
        featuresUpdated.length = 0;
      }
    }
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
  } catch (error) {
    buildPassed = false;
    buildErrors.push(`Spec build failed: ${readableError(error)}`);
  }

  const ticketCreationPassed = ticketErrors.length === 0;
  const specUpdatePassed = specErrors.length === 0;
  const failureSummary = [
    ticketErrors.length ? `${ticketErrors.length} ticket creation error(s)` : "",
    specErrors.length ? `${specErrors.length} spec update error(s)` : "",
    buildErrors.length ? buildErrors[0] : "",
  ].filter(Boolean).join("; ");
  return {
    created: ticketPaths.length,
    skippedExisting,
    ticketPaths,
    featuresUpdated,
    ticketCreationPassed,
    specUpdatePassed,
    buildPassed,
    ticketErrors,
    specErrors,
    buildErrors,
    summary:
      confirmed.length === 0
        ? `No confirmed findings; nothing filed.${failureSummary ? ` ${failureSummary}` : ""}`
        : `Filed ${ticketPaths.length} ticket(s) (${skippedExisting} already existed), updated ${featuresUpdated.length} feature record(s), build ${buildPassed ? "passed" : "FAILED"}.${failureSummary ? ` ${failureSummary}` : ""}`,
  };
}

export const SCAN_RULES = `
Rules:
- READ-ONLY: do not modify any file. Your job is finding and evidencing, not fixing.
- Start with "bun .smithers/lib/ddd/auditInputs.ts" for the bounded product-surface file list, then read targeted files. Do not recursively read .smithers/executions or .smithers/pg.
- A finding needs concrete evidence: the exact file and line behavior, the input that breaks it, or the failing command. "This looks suspicious" is not a finding.
- featureId must be an id from .smithers/spec/features.json when the bug belongs to a tracked feature, else "".
- Do not launch docs-driven-development, ddd-generate-docs, or another ddd-bug-scan from inside this scan.
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
