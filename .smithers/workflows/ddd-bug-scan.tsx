// smithers-display-name: DDD Bug Scan
// smithers-description: Async read-only bug hunt over the product surface — Codex Luna finds, Codex Sol adversarially verifies, confirmed bugs become real tickets and features.json gaps.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { providers } from "../lib/ddd/dddAgents.ts";
import { dddRootOrCwd } from "../lib/ddd/dddRoot.ts";

const ROOT = dddRootOrCwd();
const FEATURES_LOCK_TIMEOUT_MS = 60_000;
const FEATURES_LOCK_POLL_MS = 100;

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

function verifyAgent(_ctx: any) {
  // useClaudeForPlanning is retained as an accepted legacy input only. Codex
  // Sol now owns review; Claude is already the chain's automatic fallback.
  return providers.sol;
}

export function bugSlug(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "bug";
}

function shortBugHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function bugPathPart(value: unknown, max: number): string {
  return bugSlug(value).slice(0, max) || "bug";
}

function bugTicketIdentity(finding: any): string {
  return JSON.stringify({
    featureId: String(finding.featureId ?? ""),
    file: String(finding.file ?? ""),
    title: String(finding.title ?? ""),
    severity: String(finding.severity ?? ""),
    evidence: String(finding.evidence ?? ""),
    suggestedFix: String(finding.suggestedFix ?? ""),
  });
}

function bugTicketBaseName(finding: any): string {
  const identityHash = shortBugHash(bugTicketIdentity(finding));
  return [
    "ddd-bug-scan",
    bugPathPart(finding.file || finding.featureId || "repo", 56),
    bugPathPart(finding.id || "finding", 48),
    bugPathPart(finding.title || "bug", 56),
    identityHash,
  ].join("--");
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
}

function writeUniqueBugTicket(directory: string, baseName: string, content: string): { name: string; created: boolean } {
  const tryWrite = (candidate: string, existingIsDuplicate = false): { name: string; created: boolean } | undefined => {
    const name = `${candidate}.md`;
    const full = resolve(directory, name);
    try {
      writeFileSync(full, content, { flag: "wx" });
      return { name, created: true };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (existingIsDuplicate) return { name, created: false };
      try {
        if (readFileSync(full, "utf8") === content) return { name, created: false };
      } catch {}
      return undefined;
    }
  };

  const first = tryWrite(baseName, true);
  if (first) return first;
  const contentHash = shortBugHash(content);
  for (let index = 0; index < 20; index += 1) {
    const suffix = index === 0 ? contentHash : `${contentHash}-${index + 1}`;
    const written = tryWrite(`${baseName}-${suffix}`);
    if (written) return written;
  }
  throw new Error(`could not materialize unique bug ticket for ${baseName}`);
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireFeaturesLock(featuresPath: string): { fd: number; path: string } {
  const lockPath = `${featuresPath}.lock`;
  const deadline = Date.now() + FEATURES_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n`);
      return { fd, path: lockPath };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring ${lockPath}`);
      sleepSync(FEATURES_LOCK_POLL_MS);
    }
  }
}

function releaseFeaturesLock(lock: { fd: number; path: string }) {
  try {
    closeSync(lock.fd);
  } catch {}
  try {
    rmSync(lock.path, { force: true });
  } catch {}
}

function writeFeaturesAtomic(featuresPath: string, features: Array<Record<string, any>>) {
  const tempPath = `${featuresPath}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "w", 0o600);
    writeFileSync(fd, `${JSON.stringify(features, null, 2)}\n`);
    try {
      fsyncSync(fd);
    } catch {}
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, featuresPath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {}
    throw error;
  }
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
 * rebuild the derived docs so the UI backlog picks them up. Exact duplicate
 * tickets are skipped, so re-running the scan never double-files.
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
  const seenTicketIdentities = new Set<string>();
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
    try {
      const identity = bugTicketIdentity(finding);
      if (seenTicketIdentities.has(identity)) {
        skippedExisting += 1;
        continue;
      }
      seenTicketIdentities.add(identity);
      const written = writeUniqueBugTicket(directory, bugTicketBaseName(finding), bugTicketMarkdown(runId, enrichedFinding));
      if (written.created) ticketPaths.push(written.name);
      else skippedExisting += 1;
    } catch (error) {
      ticketErrors.push(`Failed to write ticket for ${finding.id || finding.title || "finding"}: ${readableError(error)}`);
    }
  }

  // Record each confirmed bug as a missing[] gap on its feature so the spec
  // stays the source of truth and the generated backlog includes it.
  const featuresUpdated: string[] = [];
  let buildPassed = false;
  let lock: { fd: number; path: string } | undefined;
  try {
    lock = acquireFeaturesLock(featuresPath);
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
        writeFeaturesAtomic(featuresPath, features);
      }
    }
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
  } catch (error) {
    specErrors.push(`Failed to update ${featuresPath}: ${readableError(error)}`);
    featuresUpdated.length = 0;
  } finally {
    if (lock) releaseFeaturesLock(lock);
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
