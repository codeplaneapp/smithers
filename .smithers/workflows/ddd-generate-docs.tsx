// smithers-display-name: DDD Generate Docs
// smithers-description: Bootstrap or refresh the living product spec (features.json + overview) by reading the repo's real code, docs, and tests, then kick off an async bug scan.
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence, Task } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";
import { dddRootOrCwd } from "../lib/ddd/dddRoot.ts";

const ROOT = dddRootOrCwd();

const codex = providers.codex;

const inputSchema = z.object({
  useClaudeForPlanning: z.preprocess((v) => v ?? undefined, z.boolean().default(true)),
  // Skip launching the detached bug scan (tests and quick refreshes set false).
  runBugScan: z.preprocess((v) => v ?? undefined, z.boolean().default(true)),
});

const surveySchema = z.object({
  hasSpec: z.boolean().default(false),
  readmeExcerpt: z.string().default(""),
  packageNames: z.array(z.string()).default([]),
  topLevelDirs: z.array(z.string()).default([]),
  docsFiles: z.array(z.string()).default([]),
  testDirs: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const draftSchema = z.object({
  status: z.enum(["ready", "partial", "blocked"]).default("partial"),
  featuresWritten: z.number().int().min(0).default(0),
  updatedFiles: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const buildSchema = z.object({
  passed: z.boolean().default(false),
  summary: z.string().default(""),
});

const reviewSchema = z.object({
  approved: z.boolean().default(false),
  corrections: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const kickoffSchema = z.object({
  launched: z.boolean().default(false),
  bugScanRunId: z.string().default(""),
  summary: z.string().default(""),
});

const { Workflow, smithers, outputs } = createSmithers({
  input: inputSchema,
  survey: surveySchema,
  draft: draftSchema,
  build: buildSchema,
  review: reviewSchema,
  kickoff: kickoffSchema,
});

function planningAgent(ctx: any) {
  return ctx.input.useClaudeForPlanning !== false ? providers.claude : codex;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((entry) => !entry.startsWith(".") && entry !== "node_modules");
  } catch {
    return [];
  }
}

function readHead(path: string, chars = 4000): string {
  try {
    return readFileSync(path, "utf8").slice(0, chars);
  } catch {
    return "";
  }
}

/**
 * Bounded repo inventory: enough for the drafting agent to know where to look,
 * never a recursive dump. Pure fs reads, no shelling out.
 */
export function surveyRepo(root: string = ROOT) {
  const topLevelDirs = listDir(root).filter((entry) => {
    try {
      return statSync(resolve(root, entry)).isDirectory();
    } catch {
      return false;
    }
  });
  const packageNames: string[] = [];
  for (const dir of ["", "packages", "apps"]) {
    const base = dir ? resolve(root, dir) : root;
    for (const entry of dir ? listDir(base) : ["."]) {
      const manifest = resolve(base, entry, "package.json");
      if (!existsSync(manifest)) continue;
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8")).name;
        if (typeof name === "string" && name) packageNames.push(name);
      } catch {
        // unparseable manifest: skip, the drafting agent can look itself
      }
    }
  }
  const docsFiles = listDir(resolve(root, "docs")).slice(0, 50);
  const testDirs = topLevelDirs.filter((d) => /^(test|tests|e2e|__tests__)$/i.test(d));
  return {
    hasSpec: existsSync(resolve(root, ".smithers/spec/features.json")),
    readmeExcerpt: readHead(resolve(root, "README.md")),
    packageNames: [...new Set(packageNames)].slice(0, 50),
    topLevelDirs,
    docsFiles,
    testDirs,
    summary: `Surveyed ${root}: ${topLevelDirs.length} top-level dirs, ${packageNames.length} packages, docs/=${docsFiles.length} entries.`,
  };
}

export function runSpecBuild(root: string = ROOT): { passed: boolean; summary: string } {
  try {
    execFileSync("bun", [".smithers/lib/ddd/build.ts"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { passed: true, summary: "features.json validated, derived docs and UI modules regenerated." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { passed: false, summary: `Spec build failed: ${message.slice(0, 4000)}` };
  }
}

function commandErrorMessage(error: unknown): string {
  const anyError = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [
    anyError?.message ? String(anyError.message) : error instanceof Error ? error.message : String(error),
    anyError?.stderr ? String(anyError.stderr).trim() : "",
    anyError?.stdout ? String(anyError.stdout).trim() : "",
  ].filter(Boolean).join("\n").slice(0, 2000);
}

/**
 * Launch the detached bug scan. Uses the CLI so the scan is its own durable,
 * resumable run that outlives this workflow.
 */
export function kickoffBugScan(root: string = ROOT, enabled = true) {
  if (!enabled) {
    return { launched: false, bugScanRunId: "", summary: "Bug scan disabled by input (runBugScan=false)." };
  }
  return kickoffBugScanAfterGate(root, enabled, { buildPassed: true, reviewApproved: true });
}

export function kickoffBugScanAfterGate(
  root: string = ROOT,
  enabled = true,
  gate: { buildPassed?: boolean; reviewApproved?: boolean } = {},
) {
  if (!enabled) {
    return { launched: false, bugScanRunId: "", summary: "Bug scan disabled by input (runBugScan=false)." };
  }
  const blockers = [
    gate.buildPassed === false ? "the generated spec build failed" : "",
    gate.reviewApproved === false ? "the generated spec review was not approved" : "",
  ].filter(Boolean);
  if (blockers.length > 0) {
    return {
      launched: false,
      bugScanRunId: "",
      summary: `Bug scan blocked because ${blockers.join(" and ")}.`,
    };
  }
  try {
    const smithersBin = resolveExecutable("smithers", process.env.PATH);
    const out = execFileCapture(commandForExecutable(smithersBin, ["workflow", "run", "ddd-bug-scan", "--detach"]), root);
    const match = out.match(/run[-_][a-z0-9-]+/i);
    return {
      launched: true,
      bugScanRunId: match ? match[0] : "",
      summary: match
        ? `Detached bug scan launched: ${match[0]}.`
        : "Detached bug scan launched (run id not parsed from CLI output).",
    };
  } catch (error) {
    return { launched: false, bugScanRunId: "", summary: `Bug scan launch failed: ${commandErrorMessage(error)}` };
  }
}

export function resolveExecutable(name: string, pathValue: string | undefined): string {
  if (name.includes("/") || name.includes("\\")) return name;
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const candidate of executableCandidates(name)) {
      const full = resolve(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return name;
}

function executableCandidates(name: string): string[] {
  if (process.platform !== "win32" || /\.[^\\/]+$/.test(name)) return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [
    name,
    ...exts.map((ext) => `${name}${ext.toLowerCase()}`),
    ...exts.map((ext) => `${name}${ext.toUpperCase()}`),
  ];
}

function commandForExecutable(bin: string, args: string[]): { bin: string; args: string[] } {
  if (process.platform === "win32" && /\.(?:bat|cmd)$/i.test(bin)) {
    const commandLine = ["call", cmdArg(bin), ...args.map(cmdArg)].join(" ");
    return {
      bin: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/c", commandLine],
    };
  }
  try {
    const firstLine = readFileSync(bin, "utf8").split(/\r?\n/, 1)[0] ?? "";
    if (firstLine.includes("/bin/sh") || firstLine.includes("/usr/bin/env sh")) {
      return { bin: "/bin/sh", args: [bin, ...args] };
    }
  } catch {
    // Fall through to executing the resolved binary directly.
  }
  return { bin, args };
}

function cmdArg(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function execFileCapture(command: { bin: string; args: string[] }, cwd: string): string {
  try {
    return execFileSync(command.bin, command.args, {
      cwd,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(commandErrorMessage(error));
  }
}

export const SPEC_RULES = `
Spec rules:
- .smithers/spec/features.json is the structured source of truth, validated by .smithers/lib/ddd/featuresSchema.ts (strict zod). Required per record: id (kebab-case), title, summary, status (fixed|partial|broken|missing-tests|missing), priority (p0|p1|p2), owner. Organization: tier (feature|platform|reference), group (an END-USER JOURNEY like "Author workflows", not a team), userValue. Evidence ledger arrays: tests, observability, debug, architecture, changes, diffHints, missing.
- Statuses reflect PROOF, not hope. A feature is "fixed" only when its tests exist and pass. If you cannot verify, use partial/missing-tests and record the gap in missing[].
- When updating existing records, preserve tier, group, userValue, capabilities, endpoints, and links unless the repo proves a specific correction.
- .smithers/spec/content/features/<id>.md are DERIVED (regenerated by bun .smithers/lib/ddd/build.ts; never hand-edit). .smithers/spec/content/overview.md is the editable product overview; content/product/*.md are optional extra human-level docs.
- After editing, run "bun .smithers/lib/ddd/build.ts" from the repo root and keep features.json valid.
- Do not edit running orchestration files for this DDD surface (.smithers/workflows/ddd-generate-docs.tsx, .smithers/workflows/ddd-bug-scan.tsx, .smithers/workflows/docs-driven-development.tsx); record workflow/script bugs instead.
- Do not print secrets or tokens.
`;

export default smithers((ctx) => {
  const runBugScan = ctx.input.runBugScan !== false;

  return (
    <Workflow name="ddd-generate-docs">
      <Sequence>
        <Task id="survey" output={outputs.survey}>
          {async () => surveyRepo()}
        </Task>

        <Task
          id="draft-spec"
          output={outputs.draft}
          agent={planningAgent(ctx)}
          retries={1}
          timeoutMs={40 * 60 * 1000}
          dependsOn={["survey"]}
          deps={{ survey: outputs.survey }}
        >
          {(deps: any) => `Generate (or refresh) the living product spec for THIS repo by reading its real code and docs. Start from the survey below, then read targeted files (README, key package entry points, docs) — never recursive dumps. Write .smithers/spec/features.json describing the product's real features with honest statuses, and write .smithers/spec/content/overview.md if it is missing or a stub. If features.json already exists, UPDATE it: refine existing records with what the code proves, add missing features, never blindly replace records or drop their fields. Create the .smithers/spec/content directory if needed. Then run "bun .smithers/lib/ddd/build.ts" and fix validation errors until it passes. Return only JSON matching the draft schema.

Survey:
${JSON.stringify(deps.survey, null, 2)}
${SPEC_RULES}`}
        </Task>

        <Task id="build" output={outputs.build} dependsOn={["draft-spec"]}>
          {async () => runSpecBuild()}
        </Task>

        <Task
          id="review"
          output={outputs.review}
          agent={planningAgent(ctx)}
          retries={1}
          timeoutMs={20 * 60 * 1000}
          dependsOn={["build"]}
          needs={{ draft: "draft-spec" }}
          deps={{ draft: outputs.draft, build: outputs.build }}
        >
          {(deps: any) => `Adversarially review the freshly generated spec at .smithers/spec/features.json against the actual repo. Every status must be defensible from cited evidence (a test file that exists, a command that passes, a doc that matches the code). Downgrade optimistic statuses yourself, record gaps in missing[], apply corrections directly, and rerun "bun .smithers/lib/ddd/build.ts". Set approved=true only when the spec is honest and the build passes. Return only JSON matching the review schema.

Draft result:
${JSON.stringify(deps.draft, null, 2)}

Build gate:
${JSON.stringify(deps.build, null, 2)}
${SPEC_RULES}`}
        </Task>

        <Task id="post-review-build" output={outputs.build} dependsOn={["review"]}>
          {async () => runSpecBuild()}
        </Task>

        <Task
          id="kickoff-bug-scan"
          output={outputs.kickoff}
          dependsOn={["post-review-build", "review"]}
          needs={{ postReviewBuild: "post-review-build" }}
          deps={{ postReviewBuild: outputs.build, review: outputs.review }}
        >
          {(deps: any) =>
            kickoffBugScanAfterGate(ROOT, runBugScan, {
              buildPassed: deps.postReviewBuild?.passed === true,
              reviewApproved: deps.review?.approved === true,
            })
          }
        </Task>
      </Sequence>
    </Workflow>
  );
});
