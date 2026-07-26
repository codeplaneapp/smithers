import { dddRoot } from "./dddRoot.ts";
import type { Feature } from "./featuresSchema.ts";
import { validateFeatures } from "./validateFeatures.ts";

/**
 * Ranks the open gaps in .smithers/spec/features.json so triage can pick the
 * next work items from a bounded list instead of re-auditing the repo.
 * Ordering: broken p0 first, then partial p0, then missing-tests, then
 * missing/other gaps. Usage: bun .smithers/lib/ddd/triageCandidates.ts --max N
 * --max controls how many ranked options planning may inspect; the current DDD
 * workflow still executes one implementation slot per round.
 */
export type TriageCandidate = {
  featureId: string;
  title: string;
  status: string;
  priority: string;
  owner: string;
  score: number;
  taskType: "fix" | "e2e" | "review" | "feature";
  reason: string;
  tests: string[];
  files: string[];
  acceptance: string[];
};

function priorityWeight(priority: string): number {
  if (priority === "p0") return 100;
  if (priority === "p1") return 60;
  if (priority === "p2") return 30;
  return 10;
}

function statusWeight(status: string): number {
  if (status === "broken") return 50;
  if (status === "partial") return 30;
  if (status === "missing-tests") return 25;
  if (status === "missing") return 15;
  return 0;
}

function gapWeight(gapText: string): number {
  if (/\b(security|auth|bypass|critical|crash|corrupt|loss|bug|broken|fails?|error)\b/i.test(gapText)) return 50;
  if (/\b(test|e2e|coverage|proof|playwright|unit)\b/i.test(gapText)) return 25;
  if (/\b(review|audit)\b/i.test(gapText)) return 20;
  if (/\b(implement|build|add support|missing)\b/i.test(gapText)) return 15;
  return gapText ? 10 : 0;
}

function taskTypeFor(status: string, gapText = ""): TriageCandidate["taskType"] {
  if (/\b(test|e2e|coverage|proof|playwright|unit)\b/i.test(gapText)) return "e2e";
  if (/\b(review|audit|security)\b/i.test(gapText)) return "review";
  if (/\b(bug|broken|fails?|crash|error)\b/i.test(gapText)) return "fix";
  if (/\b(implement|build|add support|missing)\b/i.test(gapText)) return "feature";
  if (status === "broken") return "fix";
  if (status === "missing-tests") return "e2e";
  if (status === "missing") return "feature";
  return "e2e";
}

// Matches a relative repo file path (one or more `/`-separated segments ending
// in a file extension), not any particular target repo's top-level layout —
// this DDD workflow is installed into arbitrary target repos, not just this
// monorepo, so it cannot assume directory names like `packages/` or `apps/`.
const RELATIVE_FILE_PATH_RE = /^(?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]{1,8}$/;

function filesFromDiffHints(diffHints: string[] = []): string[] {
  return Array.from(
    new Set(
      diffHints
        .flatMap((hint) => hint.split(/\s+/))
        .map((part) => part.replace(/^[("'`]+/, "").replace(/[",.;:)`]+$/, ""))
        .filter((part) => RELATIVE_FILE_PATH_RE.test(part)),
    ),
  );
}

export function triageCandidates(features: Feature[], max = 8): TriageCandidate[] {
  return features
    .filter((feature) => feature.status !== "fixed" || (feature.missing ?? []).filter(Boolean).length > 0)
    .map((feature) => {
      const status = feature.status;
      const priority = feature.priority;
      const missing = (feature.missing ?? []).filter(Boolean);
      const gapText = missing.join(" ");
      return {
        featureId: feature.id,
        title: feature.title,
        status,
        priority,
        owner: feature.owner,
        score:
          priorityWeight(priority) +
          (status === "fixed" ? gapWeight(gapText) : statusWeight(status) + gapWeight(gapText)),
        taskType: taskTypeFor(status, gapText),
        reason:
          status === "fixed"
            ? `${priority.toUpperCase()} fixed feature has open gap(s). ${gapText}`.trim()
            : `${priority.toUpperCase()} ${status} feature. ${feature.summary}`.trim(),
        tests: feature.tests ?? [],
        files: filesFromDiffHints(feature.diffHints),
        acceptance:
          missing.length > 0 ? missing : [`Move ${feature.id} from ${status} only after direct proof is attached.`],
      };
    })
    .sort((a, b) => b.score - a.score || a.featureId.localeCompare(b.featureId))
    .slice(0, max);
}

export function parseMax(argv: string[]): number {
  const args = argv.filter((arg) => arg !== "--");
  const index = args.indexOf("--max");
  if (index >= 0 && args[index + 1]) {
    const value = Number(args[index + 1]);
    if (Number.isInteger(value) && value >= 1) return value;
  }
  return 8;
}

if (import.meta.main) {
  try {
    const max = parseMax(process.argv.slice(2));
    const features = validateFeatures(dddRoot());
    console.log(
      JSON.stringify({ generatedAt: new Date().toISOString(), selected: triageCandidates(features, max) }, null, 2),
    );
  } catch (error) {
    console.error(`ddd triage-candidates failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
