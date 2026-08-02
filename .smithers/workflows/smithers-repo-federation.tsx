// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Smithers Repo Federation
// smithers-description: Split the smithers monorepo into 10 standalone public repos plus multi/plue/awesome-smithers PR lanes, strip smithers to a runtime kernel, and land it behind manifest/publish/merge approval gates.
// smithers-tags: migration, github, release
/** @jsxImportSource smthrs */
import { createSmithers, UI } from "smthrs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { agents } from "../agents";
import FederationInventoryPrompt from "../prompts/federation-inventory.mdx";
import FederationManifestReviewPrompt from "../prompts/federation-manifest-review.mdx";
import FederationLaneExtractPrompt from "../prompts/federation-lane-extract.mdx";
import FederationLaneDecouplePrompt from "../prompts/federation-lane-decouple.mdx";
import FederationLaneDocsPrompt from "../prompts/federation-lane-docs.mdx";
import FederationLaneVerifyPrompt from "../prompts/federation-lane-verify.mdx";
import FederationLaneFixPrompt from "../prompts/federation-lane-fix.mdx";
import FederationUpdateSmithersPrompt from "../prompts/federation-update-smithers.mdx";
import FederationReleaseDryRunPrompt from "../prompts/federation-release-dry-run.mdx";
import FederationFinalVerifyPrompt from "../prompts/federation-final-verify.mdx";
import FederationFinalFixPrompt from "../prompts/federation-final-fix.mdx";
import FederationLandedVerifyPrompt from "../prompts/federation-landed-verify.mdx";

// ── Lane layout ──────────────────────────────────────────────────────────────
// Exactly the 10 new PUBLIC standalone repos. Extracted with full history via
// git filter-repo inside fresh clones under the migration root.
const NEW_REPO_LANES = [
  "smithers-examples",
  "smithers-agents",
  "smithers-sandboxes",
  "smithers-integrations",
  "smithers-plugins",
  "smithers-packs",
  "smithers-observability",
  "smithers-review",
  "smithers-evals",
  "smithers-signal",
] as const;
// Exactly the 3 existing repos. PR lanes only: fresh clone, feature branch,
// draft PR with explicit --repo. Never extracted, never force-pushed.
const PR_ONLY_LANES = ["multi", "plue", "awesome-smithers"] as const;
const ALL_LANES = [...NEW_REPO_LANES, ...PR_ONLY_LANES] as const;

type Lane = (typeof ALL_LANES)[number];

function isPrOnlyLane(lane: string): boolean {
  return (PR_ONLY_LANES as readonly string[]).includes(lane);
}
// Three lane kinds: brand-new repos (history-preserving extraction), existing
// repos that must RECEIVE source-owned paths with preserved source history
// (multi = browser UI, plue = hosted control-plane / electric-proxy), and the
// docs-only listing lane (awesome-smithers).
type LaneKind = "new" | "history-merge" | "docs-only";
function laneKind(lane: string): LaneKind {
  if (!isPrOnlyLane(lane)) return "new";
  return lane === "awesome-smithers" ? "docs-only" : "history-merge";
}
function laneBranch(lane: string) {
  return `federation/${lane}`;
}
function laneDir(migrationRoot: string, lane: string) {
  return join(migrationRoot, "lanes", lane);
}

function requireProofBinding<T>(binding: T | undefined, nodeId: string): T {
  if (binding === undefined) {
    throw new Error(`Missing required proof binding for ${nodeId}.`);
  }
  return binding;
}

const UPDATE_SMITHERS_BRANCH = "federation/update-smithers-kernel";
const KERNEL_CLONE_DIR = "smithers-kernel-clone";
const SOURCE_CLONE_DIR = "source-clone";
const ROOT_MARKER = ".smithers-federation-root.json";

// The live source checkout (this file sits at <checkout>/.smithers/workflows/).
// Nothing in this workflow may mutate it or its git metadata.
const SOURCE_CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Schemas ──────────────────────────────────────────────────────────────────
const inputSchema = z.object({
  migrationRoot: z
    .string()
    .default("~/smithers-federation-migration")
    .describe(
      "Local directory root for all migration clones/artifacts. Must be explicit, must not be the live smithers checkout, inside it, or an ancestor of it, and must not be a reused dirty directory.",
    ),
  githubOrg: z.string().default("").describe("GitHub org the 10 new PUBLIC standalone repos are created under."),
  sourceRepo: z
    .string()
    .default("smithersai/smithers")
    .describe(
      "Full owner/name of the source smithers repo; multi/plue/awesome-smithers are assumed to live under the same owner.",
    ),
  dryRun: z
    .boolean()
    .default(false)
    .describe("When true, stop after the manifest approval gate — no repos are created, nothing is pushed."),
});

const prepareRootSchema = z.object({
  rootPath: z.string().default(""),
  sourceClonePath: z.string().default(""),
  sourceRemote: z.string().default(""),
  created: z.boolean().default(false),
  existed: z.boolean().default(false),
  notes: z.string().default(""),
});

const inventorySchema = z.object({
  manifestPath: z.string().default(""),
  dagPath: z.string().default(""),
  releasePlanPath: z.string().default(""),
  destinationCounts: z.array(z.object({ destination: z.string(), count: z.number().int().default(0) })).default([]),
  summary: z.string().default(""),
  risks: z.array(z.string()).default([]),
});

const manifestReviewSchema = z.object({
  approvable: z.boolean().default(false),
  boundaryIssues: z.array(z.string()).default([]),
  ambiguousUtilities: z
    .array(
      z.object({ path: z.string(), lanes: z.array(z.string()).default([]), recommendation: z.string().default("") }),
    )
    .default([]),
  publishOrderingNotes: z.array(z.string()).default([]),
  licenseGaps: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

const createReposSchema = z.object({
  createdRepos: z.array(z.string()).default([]),
  skippedRepos: z.array(z.object({ repo: z.string(), reason: z.string() })).default([]),
  ready: z.boolean().default(false),
  summary: z.string().default(""),
});

const laneExtractSchema = z.object({
  lane: z.string().default(""),
  pathCount: z.number().int().default(0),
  commitCount: z.number().int().default(0),
  commandsRun: z.array(z.string()).default([]),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })).default([]),
  status: z.enum(["done", "partial", "blocked"]).default("done"),
  summary: z.string().default(""),
});

const laneDecoupleSchema = z.object({
  lane: z.string().default(""),
  packageName: z.string().default(""),
  rewrittenDeps: z.array(z.object({ from: z.string(), to: z.string(), range: z.string() })).default([]),
  buildStatus: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  lockfiles: z
    .object({ pnpm: z.boolean().default(false), bun: z.boolean().default(false) })
    .default({ pnpm: false, bun: false }),
  status: z.enum(["done", "partial", "blocked"]).default("done"),
  summary: z.string().default(""),
});

const laneDocsSchema = z.object({
  lane: z.string().default(""),
  filesWritten: z.array(z.string()).default([]),
  staleLinksFixed: z.array(z.string()).default([]),
  status: z.enum(["done", "partial", "blocked"]).default("done"),
  summary: z.string().default(""),
});

const laneVerifySchema = z.object({
  lane: z.string().default(""),
  passed: z.boolean().default(false),
  testStatus: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  buildStatus: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  staleLinkCount: z.number().int().default(0),
  failures: z.array(z.object({ file: z.string().default(""), issue: z.string().default("") })).default([]),
  summary: z.string().default(""),
});

const laneFixSchema = z.object({
  lane: z.string().default(""),
  fixed: z.array(z.string()).default([]),
  remaining: z.array(z.string()).default([]),
  buildStatus: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  testStatus: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  summary: z.string().default(""),
});

const lanePushSchema = z.object({
  lane: z.string().default(""),
  pushed: z.boolean().default(false),
  commitSha: z.string().default(""),
  remote: z.string().nullable().default(null),
  branch: z.string().default(""),
  repo: z.string().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  prNumber: z.number().nullable().default(null),
  summary: z.string().default(""),
});

const updateSmithersSchema = z.object({
  removedPackages: z.array(z.string()).default([]),
  publishedDeps: z.array(z.object({ name: z.string(), range: z.string() })).default([]),
  filesChanged: z.array(z.string()).default([]),
  staleLinkGateWired: z.boolean().default(false),
  integrationGateWired: z.boolean().default(false),
  committed: z.boolean().default(false),
  status: z.enum(["done", "partial", "blocked"]).default("done"),
  summary: z.string().default(""),
});

const releaseDryRunSchema = z.object({
  ok: z.boolean().default(false),
  laneVersions: z.array(z.object({ lane: z.string(), version: z.string() })).default([]),
  checks: z
    .array(
      z.object({
        lane: z.string().default(""),
        step: z.string().default(""),
        status: z.string().default(""),
        detail: z.string().default(""),
      }),
    )
    .default([]),
  issues: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const releaseReadinessSchema = z.object({
  ok: z.boolean().default(false),
  issues: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const releaseApprovalBindingSchema = z.object({
  laneRevisions: z
    .array(
      z.object({
        lane: z.string(),
        headSha: z.string(),
        remote: z.string(),
        branch: z.string(),
      }),
    )
    .default([]),
  releasePlanSha256: z.string(),
  coordinatorSha256: z.string(),
  summary: z.string(),
});

const executeReleasesSchema = z.object({
  released: z.array(z.object({ lane: z.string(), version: z.string(), tag: z.string().nullable() })).default([]),
  failed: z.array(z.object({ lane: z.string(), reason: z.string() })).default([]),
  summary: z.string().default(""),
});

const removalPrsSchema = z.object({
  prs: z
    .array(
      z.object({
        lane: z.string(),
        repo: z.string().nullable().default(null),
        prUrl: z.string().nullable(),
        prNumber: z.number().nullable(),
      }),
    )
    .default([]),
  summary: z.string().default(""),
});

const mergeRemovalPrsSchema = z.object({
  merged: z.array(z.object({ lane: z.string(), prNumber: z.number().nullable() })).default([]),
  failed: z.array(z.object({ lane: z.string(), reason: z.string() })).default([]),
  summary: z.string().default(""),
});

const finalVerifySchema = z.object({
  approvable: z.boolean().default(false),
  fixList: z
    .array(z.object({ target: z.string().default(""), check: z.string().default(""), detail: z.string().default("") }))
    .default([]),
  summary: z.string().default(""),
});

const finalFixSchema = z.object({
  resolved: z.array(z.string()).default([]),
  remaining: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

const landedVerifySchema = z.object({
  approvable: z.boolean().default(false),
  fixList: z
    .array(z.object({ target: z.string().default(""), check: z.string().default(""), detail: z.string().default("") }))
    .default([]),
  summary: z.string().default(""),
});

const reportSchema = z.object({
  reportPath: z.string().default(""),
  lanesCompleted: z.number().int().default(0),
  approvable: z.boolean().default(false),
  summary: z.string().default(""),
});

const { Workflow, Task, Sequence, Parallel, Branch, Loop, Ralph, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  prepareRoot: prepareRootSchema,
  inventory: inventorySchema,
  manifestReview: manifestReviewSchema,
  gateManifest: approvalSchema,
  createRepos: createReposSchema,
  laneExtract: laneExtractSchema,
  laneDecouple: laneDecoupleSchema,
  laneDocs: laneDocsSchema,
  laneVerify: laneVerifySchema,
  laneFix: laneFixSchema,
  lanePush: lanePushSchema,
  updateSmithers: updateSmithersSchema,
  releaseDryRun: releaseDryRunSchema,
  releaseReadiness: releaseReadinessSchema,
  releaseApprovalBinding: releaseApprovalBindingSchema,
  gatePublish: approvalSchema,
  executeReleases: executeReleasesSchema,
  removalPrs: removalPrsSchema,
  gateMerge: approvalSchema,
  mergeRemovalPrs: mergeRemovalPrsSchema,
  finalVerify: finalVerifySchema,
  finalFix: finalFixSchema,
  landedVerify: landedVerifySchema,
  report: reportSchema,
});

// ── Pure helpers (function tasks — agent="(none)") ──────────────────────────

function expandHome(path: string): string {
  if (path === "~") return join(homedir(), "smithers-federation-migration");
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isSameOrSubpath(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

function gitIn(path: string, args: string[]) {
  return execFileSync("git", args, { cwd: path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalGithubRepo(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const match = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/i.exec(
    trimmed,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

// Any refusal here must FAIL THE TASK (throw) — never return a success-shaped
// row that downstream nodes could read as "root is ready".
function prepareRoot(migrationRoot: string, sourceRepo: string, githubOrg: string) {
  const expanded = expandHome(migrationRoot.trim());
  const rootPath = resolve(expanded);
  const existed = existsSync(rootPath);
  if (!agents.cheapFast?.length || !agents.implement?.length || !agents.planning?.length) {
    throw new Error(
      "smithers-repo-federation requires agents.cheapFast, agents.implement, and agents.planning " +
        "to be non-empty pools in .smithers/agents.ts — one or more is missing/empty. Fix agents.ts before rerunning.",
    );
  }
  if (!isAbsolute(expanded)) {
    throw new Error(
      `migrationRoot "${migrationRoot}" is ambiguous (not absolute after ~ expansion). Pass an explicit absolute path.`,
    );
  }
  if (rootPath === parse(rootPath).root || rootPath === homedir()) {
    throw new Error(
      `migrationRoot "${rootPath}" is too broad (filesystem root or home directory). Use a dedicated subdirectory.`,
    );
  }
  if (isSameOrSubpath(SOURCE_CHECKOUT, rootPath)) {
    throw new Error(`migrationRoot "${rootPath}" is inside the live smithers checkout ${SOURCE_CHECKOUT}. Refused.`);
  }
  if (isSameOrSubpath(rootPath, SOURCE_CHECKOUT)) {
    throw new Error(
      `migrationRoot "${rootPath}" is an ancestor of the live smithers checkout ${SOURCE_CHECKOUT}. Refused.`,
    );
  }
  const markerPath = join(rootPath, ROOT_MARKER);
  if (existed) {
    const entries = readdirSync(rootPath);
    if (entries.length > 0 && !existsSync(markerPath)) {
      throw new Error(
        `migrationRoot "${rootPath}" already exists and is not empty but has no ${ROOT_MARKER} marker — refusing to reuse a dirty/foreign directory.`,
      );
    }
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
        workflow?: string;
        sourceRepo?: string;
        githubOrg?: string;
      };
      if (marker.workflow !== "smithers-repo-federation") {
        throw new Error(
          `migrationRoot "${rootPath}" has a marker for a different workflow (${marker.workflow ?? "unknown"}). Refused.`,
        );
      }
      if (marker.sourceRepo !== sourceRepo || marker.githubOrg !== githubOrg) {
        throw new Error(
          `migrationRoot "${rootPath}" belongs to sourceRepo=${JSON.stringify(marker.sourceRepo ?? null)}, ` +
            `githubOrg=${JSON.stringify(marker.githubOrg ?? null)}, not sourceRepo=${JSON.stringify(sourceRepo)}, ` +
            `githubOrg=${JSON.stringify(githubOrg)}. Use a new isolated migrationRoot.`,
        );
      }
    }
  }
  mkdirSync(join(rootPath, "artifacts"), { recursive: true });
  mkdirSync(join(rootPath, "lanes"), { recursive: true });
  if (!existsSync(markerPath)) {
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          workflow: "smithers-repo-federation",
          sourceRepo,
          githubOrg,
          sourceCheckout: SOURCE_CHECKOUT,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }
  // Clone (or refresh) a CLEAN origin/main source clone under the migration
  // root. Inventory, extraction, and kernel work read THIS clone — never the
  // dirty live checkout.
  const sourceRemote = `https://github.com/${sourceRepo}.git`;
  const sourceClonePath = join(rootPath, SOURCE_CLONE_DIR);
  if (existsSync(join(sourceClonePath, ".git"))) {
    const actualOrigin = gitIn(sourceClonePath, ["remote", "get-url", "origin"]).trim();
    if (
      canonicalGithubRepo(actualOrigin) !== canonicalGithubRepo(sourceRemote) ||
      canonicalGithubRepo(sourceRemote) === null
    ) {
      throw new Error(
        `source clone origin mismatch: requested ${sourceRemote}, found ${actualOrigin || "(missing)"}. ` +
          "Refusing to fetch/reset a clone from another repository.",
      );
    }
    gitIn(sourceClonePath, ["fetch", "origin", "main"]);
    gitIn(sourceClonePath, ["checkout", "main"]);
    gitIn(sourceClonePath, ["reset", "--hard", "origin/main"]);
    gitIn(sourceClonePath, ["clean", "-fdx"]);
  } else {
    execFileSync("git", ["clone", "--branch", "main", "--single-branch", sourceRemote, sourceClonePath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  const head = gitIn(sourceClonePath, ["rev-parse", "HEAD"]).trim();
  const originMain = gitIn(sourceClonePath, ["rev-parse", "origin/main"]).trim();
  if (head !== originMain) {
    throw new Error(
      `source clone ${sourceClonePath} is not exactly at origin/main (HEAD=${head}, origin/main=${originMain}). Refused.`,
    );
  }
  if (gitIn(sourceClonePath, ["status", "--porcelain"]).trim()) {
    throw new Error(`source clone ${sourceClonePath} is dirty after reset --hard origin/main + clean -fdx. Refused.`);
  }
  return {
    rootPath,
    sourceClonePath,
    sourceRemote,
    created: !existed,
    existed,
    notes: `Validated and prepared ${rootPath} (artifacts/, lanes/, marker). Clean origin/main source clone at ${sourceClonePath}; live source checkout ${SOURCE_CHECKOUT} is never read or mutated.`,
  };
}

// Idempotent ONLY for repos this migration recorded as created. A pre-existing
// destination name with no record is a hard stop (throw) BEFORE any lane work.
// Succeeds (ready: true) only when all ten PUBLIC destination repos are
// verified to exist with PUBLIC visibility.
function createRepos(migrationRoot: string, githubOrg: string) {
  if (!githubOrg) {
    throw new Error(
      "createRepos refused: githubOrg input is empty — cannot create or verify the 10 PUBLIC destination repos without an owner.",
    );
  }
  const rootPath = expandHome(migrationRoot);
  const recordPath = join(rootPath, "artifacts", "created-repos.json");
  let recorded = new Set<string>();
  if (existsSync(recordPath)) {
    try {
      const prior = JSON.parse(readFileSync(recordPath, "utf8")) as { createdRepos?: string[] };
      recorded = new Set(prior.createdRepos ?? []);
    } catch (err) {
      throw new Error(
        `createRepos refused: cannot parse migration record ${recordPath}: ${String(err instanceof Error ? err.message : err).slice(0, 300)}`,
      );
    }
  }
  const createdRepos: string[] = [];
  const skippedRepos: { repo: string; reason: string }[] = [];
  for (const lane of NEW_REPO_LANES) {
    const fullName = `${githubOrg}/${lane}`;
    let exists = true;
    try {
      execFileSync("gh", ["repo", "view", fullName], { encoding: "utf8" });
    } catch {
      exists = false;
    }
    if (exists && !recorded.has(fullName)) {
      throw new Error(
        `createRepos HARD STOP: destination repo ${fullName} already exists but is NOT recorded as created by this migration ` +
          `(${recordPath}). Refusing to touch a foreign repo. Delete/rename it, or record it explicitly if it was created by an earlier run of this migration.`,
      );
    }
    if (exists) {
      skippedRepos.push({ repo: fullName, reason: "already created by this migration (recorded)" });
      continue;
    }
    execFileSync(
      "gh",
      ["repo", "create", fullName, "--public", "--description", `Federated out of ${githubOrg}/smithers: ${lane}`],
      { encoding: "utf8" },
    );
    createdRepos.push(fullName);
    recorded.add(fullName);
    // Persist immediately so a later `gh repo create` failure remains safely
    // resumable instead of making the repos already created in this loop look
    // foreign on the next run.
    writeFileSync(recordPath, JSON.stringify({ createdRepos: [...recorded], skippedRepos }, null, 2));
  }
  // Structural readiness check: every one of the ten destinations must exist
  // and be PUBLIC before any lane is allowed to run.
  for (const lane of NEW_REPO_LANES) {
    const fullName = `${githubOrg}/${lane}`;
    const view = JSON.parse(
      execFileSync("gh", ["repo", "view", fullName, "--json", "visibility"], { encoding: "utf8" }),
    ) as {
      visibility?: string;
    };
    if (view.visibility !== "PUBLIC") {
      throw new Error(
        `createRepos HARD STOP: ${fullName} exists but visibility is ${view.visibility ?? "unknown"}, expected PUBLIC.`,
      );
    }
  }
  const allRepos = NEW_REPO_LANES.map((lane) => `${githubOrg}/${lane}`);
  writeFileSync(recordPath, JSON.stringify({ createdRepos: allRepos, skippedRepos }, null, 2));
  return {
    createdRepos: allRepos,
    skippedRepos,
    ready: true,
    summary: `All ${NEW_REPO_LANES.length} PUBLIC repos ready under ${githubOrg} (${createdRepos.length} newly created, ${skippedRepos.length} recorded from an earlier run).`,
  };
}

function commitLane(path: string, subject: string): string {
  const dirty = gitIn(path, ["status", "--porcelain"]).trim();
  if (dirty) {
    gitIn(path, ["add", "-A"]);
    gitIn(path, ["commit", "-m", subject]);
  }
  return gitIn(path, ["rev-parse", "HEAD"]).trim();
}

// New standalone repos only: first push initializes main. Never force-pushed,
// and only invoked after the lane's isolated verify loop passed. The extracted
// clone's origin points at the SOURCE — it is ALWAYS replaced with the exact
// destination remote and verified before pushing; failures throw (task fails),
// never a success-shaped row.
function pushNewRepoLane(migrationRoot: string, lane: string, githubOrg: string) {
  if (isPrOnlyLane(lane)) {
    throw new Error(`pushNewRepoLane refused: ${lane} is an existing-repo PR lane, not a new standalone repo.`);
  }
  if (!githubOrg) {
    throw new Error(`pushNewRepoLane refused for ${lane}: githubOrg input is empty — no exact destination to push to.`);
  }
  const path = laneDir(expandHome(migrationRoot), lane);
  if (!existsSync(path)) throw new Error(`lane clone ${path} does not exist`);
  commitLane(path, `federate ${lane}: extracted + decoupled + documented standalone package`);
  const remoteName = `${githubOrg}/${lane}`;
  const remoteUrl = `git@github.com:${remoteName}.git`;
  // The clone was made from the source clone, so its origin points at the
  // source. Remove it unconditionally, then set the EXACT destination.
  try {
    gitIn(path, ["remote", "remove", "origin"]);
  } catch {
    // no origin configured — fine
  }
  gitIn(path, ["remote", "add", "origin", remoteUrl]);
  const actual = gitIn(path, ["remote", "get-url", "origin"]).trim();
  if (actual !== remoteUrl) {
    throw new Error(`origin mismatch for ${lane}: expected ${remoteUrl}, got ${actual}. Refusing to push.`);
  }
  gitIn(path, ["push", "-u", "origin", "HEAD:main"]);
  // Verify PUBLIC visibility and default branch main; fix then re-verify.
  const ghView = () =>
    JSON.parse(
      execFileSync("gh", ["repo", "view", remoteName, "--json", "visibility,defaultBranchRef"], { encoding: "utf8" }),
    ) as {
      visibility?: string;
      defaultBranchRef?: { name?: string } | null;
    };
  let view = ghView();
  if (view.visibility !== "PUBLIC") {
    execFileSync(
      "gh",
      ["repo", "edit", remoteName, "--visibility", "public", "--accept-visibility-change-consequences"],
      {
        encoding: "utf8",
      },
    );
  }
  if (view.defaultBranchRef?.name !== "main") {
    execFileSync("gh", ["repo", "edit", remoteName, "--default-branch", "main"], { encoding: "utf8" });
  }
  view = ghView();
  if (view.visibility !== "PUBLIC") {
    throw new Error(`${remoteName} is not PUBLIC after the first push (visibility=${view.visibility ?? "unknown"}).`);
  }
  if (view.defaultBranchRef?.name !== "main") {
    throw new Error(
      `${remoteName} default branch is ${view.defaultBranchRef?.name ?? "unknown"}, expected main, after the first push.`,
    );
  }
  return {
    lane,
    pushed: true,
    commitSha: gitIn(path, ["rev-parse", "HEAD"]).trim(),
    remote: remoteUrl,
    branch: "main",
    repo: remoteName,
    prUrl: null,
    prNumber: null,
    summary: `Pushed ${lane} to ${remoteName} (origin verified to exact destination, PUBLIC, default branch main, no force).`,
  };
}

// Existing repos (multi/plue/awesome-smithers): feature branch + draft PR with
// explicit --repo. Never pushes to main, never force-pushes. Origin is set and
// verified to the exact destination repo before pushing; failures throw.
function pushPrLane(migrationRoot: string, lane: string, existingOwner: string) {
  const branch = laneBranch(lane);
  if (!isPrOnlyLane(lane)) {
    throw new Error(`pushPrLane refused: ${lane} is a new standalone repo lane, not an existing-repo PR lane.`);
  }
  const path = laneDir(expandHome(migrationRoot), lane);
  const fullRepo = `${existingOwner}/${lane}`;
  if (!existsSync(path)) throw new Error(`lane clone ${path} does not exist`);
  commitLane(path, `chore(federation): update ${lane} for the smithers repo federation`);
  const remoteUrl = `git@github.com:${fullRepo}.git`;
  try {
    gitIn(path, ["remote", "set-url", "origin", remoteUrl]);
  } catch {
    gitIn(path, ["remote", "add", "origin", remoteUrl]);
  }
  const actual = gitIn(path, ["remote", "get-url", "origin"]).trim();
  if (actual !== remoteUrl) {
    throw new Error(`origin mismatch for ${lane}: expected ${remoteUrl}, got ${actual}. Refusing to push.`);
  }
  gitIn(path, ["push", "-u", "origin", `HEAD:${branch}`]);
  const gh = (args: string[]) => execFileSync("gh", args, { cwd: path, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const title = `chore(federation): update ${lane} for the smithers repo federation`;
  const body = [
    `Cross-repo updates for ${lane} as part of splitting the smithers monorepo into standalone repos.`,
    "",
    "Opened by the smithers-repo-federation workflow.",
  ].join("\n");
  let prUrl: string;
  try {
    prUrl = gh([
      "pr",
      "create",
      "--repo",
      fullRepo,
      "--draft",
      "--head",
      branch,
      "--base",
      "main",
      "--title",
      title,
      "--body",
      body,
    ]).trim();
  } catch {
    const view = gh(["pr", "view", branch, "--repo", fullRepo, "--json", "number,url"]);
    prUrl = (JSON.parse(view) as { url: string }).url;
  }
  const prNumber = Number(prUrl.split("/").pop());
  return {
    lane,
    pushed: true,
    commitSha: gitIn(path, ["rev-parse", "HEAD"]).trim(),
    remote: remoteUrl,
    branch,
    repo: fullRepo,
    prUrl,
    prNumber: Number.isFinite(prNumber) ? prNumber : null,
    summary: `Pushed ${branch} to ${fullRepo} (origin verified) and opened draft PR ${prUrl}.`,
  };
}

function readDagOrder(migrationRoot: string): string[] {
  const dagPath = join(expandHome(migrationRoot), "artifacts", "dag.json");
  const lanes = [...NEW_REPO_LANES] as string[];
  try {
    const dag = JSON.parse(readFileSync(dagPath, "utf8")) as { edges?: Array<{ from: string; to: string }> };
    const edges = (dag.edges ?? []).filter((e) => lanes.includes(e.from) && lanes.includes(e.to));
    const indegree = new Map<string, number>(lanes.map((l) => [l, 0]));
    for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    const queue = lanes.filter((l) => (indegree.get(l) ?? 0) === 0);
    const order: string[] = [];
    while (queue.length) {
      const next = queue.shift() as string;
      order.push(next);
      for (const e of edges.filter((x) => x.from === next)) {
        const d = (indegree.get(e.to) ?? 0) - 1;
        indegree.set(e.to, d);
        if (d === 0) queue.push(e.to);
      }
    }
    return order.length === lanes.length ? order : lanes;
  } catch {
    return lanes;
  }
}

function verifyReleaseClonesReady(
  migrationRoot: string,
  lanePushResults: Array<z.infer<typeof lanePushSchema>>,
): z.infer<typeof releaseReadinessSchema> {
  const rootPath = expandHome(migrationRoot);
  const issues: string[] = [];
  for (const lane of ALL_LANES) {
    const recorded = lanePushResults.find((result) => result.lane === lane);
    const path = laneDir(rootPath, lane);
    if (!recorded?.pushed || !recorded.commitSha || !recorded.remote || !recorded.branch) {
      issues.push(`${lane}: no complete pushed revision is recorded`);
      continue;
    }
    if (!existsSync(join(path, ".git"))) {
      issues.push(`${lane}: release clone ${path} is missing`);
      continue;
    }
    try {
      if (gitIn(path, ["status", "--porcelain"]).trim()) {
        issues.push(`${lane}: release clone has uncommitted changes`);
      }
      const actualOrigin = gitIn(path, ["remote", "get-url", "origin"]).trim();
      const expectedRepo = canonicalGithubRepo(recorded.remote);
      if (!expectedRepo || canonicalGithubRepo(actualOrigin) !== expectedRepo) {
        issues.push(`${lane}: origin ${actualOrigin || "(missing)"} does not match recorded ${recorded.remote}`);
      }
      const head = gitIn(path, ["rev-parse", "HEAD"]).trim();
      if (head !== recorded.commitSha) {
        issues.push(`${lane}: local HEAD ${head} does not match recorded pushed revision ${recorded.commitSha}`);
      }
      const remoteHead = gitIn(path, ["ls-remote", "--heads", "origin", `refs/heads/${recorded.branch}`])
        .trim()
        .split(/\s+/)[0];
      if (!remoteHead) {
        issues.push(`${lane}: origin/${recorded.branch} does not exist`);
      } else if (remoteHead !== head) {
        issues.push(`${lane}: local HEAD ${head} is not pushed to origin/${recorded.branch} (${remoteHead})`);
      }
    } catch (error) {
      issues.push(
        `${lane}: revision readiness check failed: ${String(error instanceof Error ? error.message : error)}`,
      );
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    summary:
      issues.length === 0
        ? `All ${ALL_LANES.length} release clones are clean, point at their recorded destinations, and have HEAD pushed to the intended branch.`
        : `${issues.length} release-clone readiness issue(s): ${issues.join("; ")}`,
  };
}

function captureReleaseApprovalBinding(
  migrationRoot: string,
  lanePushResults: Array<z.infer<typeof lanePushSchema>>,
): z.infer<typeof releaseApprovalBindingSchema> {
  const readiness = verifyReleaseClonesReady(migrationRoot, lanePushResults);
  if (!readiness.ok) {
    throw new Error(`Cannot capture publish approval binding: ${readiness.summary}`);
  }
  const rootPath = expandHome(migrationRoot);
  const planPath = join(rootPath, "artifacts", "release-plan.json");
  const coordinator = join(rootPath, KERNEL_CLONE_DIR, "scripts", "federation-release.mjs");
  if (!existsSync(planPath)) throw new Error(`Cannot bind missing release plan ${planPath}`);
  if (!existsSync(coordinator)) throw new Error(`Cannot bind missing release coordinator ${coordinator}`);
  const laneRevisions = ALL_LANES.map((lane) => {
    const recorded = lanePushResults.find((result) => result.lane === lane);
    if (!recorded?.commitSha || !recorded.remote || !recorded.branch) {
      throw new Error(`Cannot bind ${lane}: pushed revision metadata is incomplete`);
    }
    return {
      lane,
      headSha: recorded.commitSha,
      remote: recorded.remote,
      branch: recorded.branch,
    };
  });
  const releasePlanSha256 = sha256File(planPath);
  const coordinatorSha256 = sha256File(coordinator);
  return {
    laneRevisions,
    releasePlanSha256,
    coordinatorSha256,
    summary:
      `Bound ${laneRevisions.length} pushed lane revisions, release plan ${releasePlanSha256.slice(0, 12)}, ` +
      `and coordinator ${coordinatorSha256.slice(0, 12)}.`,
  };
}

function verifyReleaseApprovalBinding(
  migrationRoot: string,
  lanePushResults: Array<z.infer<typeof lanePushSchema>>,
  approved: z.infer<typeof releaseApprovalBindingSchema>,
): void {
  const current = captureReleaseApprovalBinding(migrationRoot, lanePushResults);
  const issues: string[] = [];
  const approvedByLane = new Map(approved.laneRevisions.map((revision) => [revision.lane, revision]));
  for (const revision of current.laneRevisions) {
    const expected = approvedByLane.get(revision.lane);
    if (!expected) {
      issues.push(`${revision.lane}: absent from the approved revision set`);
      continue;
    }
    if (
      expected.headSha !== revision.headSha ||
      expected.remote !== revision.remote ||
      expected.branch !== revision.branch
    ) {
      issues.push(
        `${revision.lane}: approved ${expected.headSha}@${expected.remote}/${expected.branch}, ` +
          `current ${revision.headSha}@${revision.remote}/${revision.branch}`,
      );
    }
  }
  if (approved.laneRevisions.length !== current.laneRevisions.length) {
    issues.push(
      `approved revision count ${approved.laneRevisions.length} does not match current ${current.laneRevisions.length}`,
    );
  }
  if (approved.releasePlanSha256 !== current.releasePlanSha256) {
    issues.push(
      `release-plan.json hash changed (${approved.releasePlanSha256} approved, ${current.releasePlanSha256} current)`,
    );
  }
  if (approved.coordinatorSha256 !== current.coordinatorSha256) {
    issues.push(
      `release coordinator hash changed (${approved.coordinatorSha256} approved, ${current.coordinatorSha256} current)`,
    );
  }
  if (issues.length) {
    throw new Error(`executeReleases refused because the approved release binding is stale: ${issues.join("; ")}`);
  }
}

type ReleasePlan = {
  packages?: Array<{
    repo?: string;
    lane?: string;
    path?: string;
    name?: string;
    version?: string;
    publishTo?: string;
  }>;
  repos?: Array<{ lane?: string; version?: string; githubRelease?: boolean }>;
};

function planVersionForLane(plan: ReleasePlan, lane: string): string {
  const pkg = (plan.packages ?? []).find(
    (p) => (p.repo ?? p.lane) === lane && typeof p.version === "string" && p.version,
  );
  if (pkg?.version) return pkg.version;
  const repo = (plan.repos ?? []).find((r) => r.lane === lane);
  return repo?.version ?? "0.1.0";
}

// Real publication, gated behind the publish approval. Repos are modeled as
// containing ZERO, ONE, or MANY publishable npm packages (release-plan.json);
// publication NEVER calls `npm publish` once per repo root. Instead it invokes
// the validated ROOT COORDINATOR (authored in the kernel clone, consuming the
// release plan) which publishes every publishable package in DAG order, then
// this creates a tag + GitHub release for EVERY repo. Failures throw.
function executeReleases(
  migrationRoot: string,
  githubOrg: string,
  dryRunOk: boolean,
  lanePushResults: Array<z.infer<typeof lanePushSchema>>,
  approvalBinding: z.infer<typeof releaseApprovalBindingSchema>,
) {
  if (!dryRunOk) {
    throw new Error(
      "executeReleases refused: the release dry-run did not pass (ok !== true). Fix the dry-run before publishing.",
    );
  }
  if (!githubOrg) {
    throw new Error("executeReleases refused: githubOrg input is empty — cannot tag/release without an owner.");
  }
  // This check happens before the coordinator, npm, tags, releases, or pushes:
  // approval authorizes exact bytes, not merely a boolean readiness verdict.
  verifyReleaseApprovalBinding(migrationRoot, lanePushResults, approvalBinding);
  const rootPath = expandHome(migrationRoot);
  const kernelPath = join(rootPath, KERNEL_CLONE_DIR);
  const planPath = join(rootPath, "artifacts", "release-plan.json");
  if (!existsSync(kernelPath)) throw new Error(`kernel clone ${kernelPath} does not exist`);
  if (!existsSync(planPath))
    throw new Error(`release plan ${planPath} does not exist — the inventory step must emit it`);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as ReleasePlan;
  const coordinator = join(kernelPath, "scripts", "federation-release.mjs");
  if (!existsSync(coordinator)) {
    throw new Error(
      `root release coordinator ${coordinator} does not exist — the kernel-strip step must author it (consumes the release plan).`,
    );
  }
  // Invoke the validated coordinator: publishes every publishable package in
  // every repo, in package-DAG order. Throws on any failure.
  execFileSync("node", [coordinator, "--plan", planPath, "--execute"], {
    cwd: kernelPath,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Tags + GitHub releases for EVERY repo (including repos with zero npm
  // packages — e.g. examples/apps that only need a GitHub release).
  const released: { lane: string; version: string; tag: string | null }[] = [];
  const failed: { lane: string; reason: string }[] = [];
  for (const lane of readDagOrder(migrationRoot)) {
    const path = laneDir(rootPath, lane);
    const fullName = `${githubOrg}/${lane}`;
    try {
      const version = planVersionForLane(plan, lane);
      const tag = `v${version}`;
      if (!gitIn(path, ["tag", "-l", tag]).trim()) {
        gitIn(path, ["tag", "-a", tag, "-m", `${lane} ${tag} (federation release)`]);
      }
      if (!gitIn(path, ["ls-remote", "--tags", "origin", tag]).trim()) {
        gitIn(path, ["push", "origin", tag]);
      }
      try {
        execFileSync(
          "gh",
          [
            "release",
            "create",
            tag,
            "--repo",
            fullName,
            "--title",
            `${lane} ${tag}`,
            "--notes",
            `Federated release of ${lane} ${tag}, split out of the smithers monorepo.`,
          ],
          { cwd: path, encoding: "utf8" },
        );
      } catch {
        // Already exists from an earlier attempt — verify it is really there.
        execFileSync("gh", ["release", "view", tag, "--repo", fullName], { cwd: path, encoding: "utf8" });
      }
      released.push({ lane, version, tag });
    } catch (err) {
      failed.push({ lane, reason: String(err instanceof Error ? err.message : err).slice(0, 300) });
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `executeReleases failed for ${failed.length} lane(s): ${failed.map((f) => `${f.lane} (${f.reason})`).join("; ")}. ` +
        `Released so far: ${released.map((r) => r.lane).join(", ") || "none"}.`,
    );
  }
  return {
    released,
    failed,
    summary: `Coordinator published all packages in DAG order; tagged + released ${released.length}/${NEW_REPO_LANES.length} repos on GitHub.`,
  };
}

// Source-removal PR for the smithers kernel (clean clone + feature branch +
// draft PR with explicit --repo), plus the already-opened PR-lane draft PRs.
// The kernel clone was cloned from the local source clone, so its origin is
// reset and verified to the real source repo before pushing. Failures throw.
function removalPRs(
  migrationRoot: string,
  sourceRepo: string,
  updateSmithersResult: z.infer<typeof updateSmithersSchema> | undefined,
  lanePushResults: Array<z.infer<typeof lanePushSchema>>,
) {
  const prs: { lane: string; repo: string | null; prUrl: string | null; prNumber: number | null }[] = [];
  const kernelPath = join(expandHome(migrationRoot), KERNEL_CLONE_DIR);
  if (!existsSync(kernelPath)) throw new Error(`kernel clone ${kernelPath} does not exist`);
  commitLane(kernelPath, "chore(federation): strip smithers to runtime kernel post-extraction");
  const sourceUrl = `git@github.com:${sourceRepo}.git`;
  try {
    gitIn(kernelPath, ["remote", "set-url", "origin", sourceUrl]);
  } catch {
    gitIn(kernelPath, ["remote", "add", "origin", sourceUrl]);
  }
  const actualOrigin = gitIn(kernelPath, ["remote", "get-url", "origin"]).trim();
  if (actualOrigin !== sourceUrl) {
    throw new Error(`kernel clone origin mismatch: expected ${sourceUrl}, got ${actualOrigin}. Refusing to push.`);
  }
  gitIn(kernelPath, ["push", "-u", "origin", `HEAD:${UPDATE_SMITHERS_BRANCH}`]);
  const gh = (args: string[]) =>
    execFileSync("gh", args, { cwd: kernelPath, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const title = "chore(federation): strip smithers to runtime kernel post-extraction";
  const body = [
    "Federation migration: removes the 10 extracted packages now published as standalone repos, wires them back in",
    "as published semver dependencies, and adds stale-link + aggregate-integration CI gates.",
    "",
    updateSmithersResult?.summary ?? "",
    "",
    "Opened by the smithers-repo-federation workflow.",
  ].join("\n");
  let prUrl: string;
  try {
    prUrl = gh([
      "pr",
      "create",
      "--repo",
      sourceRepo,
      "--draft",
      "--head",
      UPDATE_SMITHERS_BRANCH,
      "--base",
      "main",
      "--title",
      title,
      "--body",
      body,
    ]).trim();
  } catch {
    const view = gh(["pr", "view", UPDATE_SMITHERS_BRANCH, "--repo", sourceRepo, "--json", "number,url"]);
    prUrl = (JSON.parse(view) as { url: string }).url;
  }
  const prNumber = Number(prUrl.split("/").pop());
  prs.push({ lane: "smithers", repo: sourceRepo, prUrl, prNumber: Number.isFinite(prNumber) ? prNumber : null });
  for (const r of lanePushResults.filter((x) => isPrOnlyLane(x.lane) && x.prUrl)) {
    prs.push({ lane: r.lane, repo: r.repo, prUrl: r.prUrl, prNumber: r.prNumber });
  }
  return { prs, summary: `Opened/collected ${prs.length} removal/reference-update draft PR(s).` };
}

// Merges stay behind the merge approval: explicit --repo everywhere, CI must
// be green first, and this only runs after destination validation + publish.
function mergeRemovalPRs(prs: Array<{ lane: string; repo: string | null; prNumber: number | null }>) {
  const merged: { lane: string; prNumber: number | null }[] = [];
  const failed: { lane: string; reason: string }[] = [];
  for (const pr of prs) {
    if (pr.prNumber === null || !pr.repo) {
      failed.push({ lane: pr.lane, reason: "no PR number or repo recorded" });
      continue;
    }
    try {
      const viewArgs = ["pr", "view", String(pr.prNumber), "--repo", pr.repo, "--json", "isDraft"];
      const view = JSON.parse(execFileSync("gh", viewArgs, { encoding: "utf8" })) as { isDraft?: boolean };
      if (view.isDraft) {
        execFileSync("gh", ["pr", "ready", String(pr.prNumber), "--repo", pr.repo], { encoding: "utf8" });
      }
      const readyView = JSON.parse(execFileSync("gh", viewArgs, { encoding: "utf8" })) as { isDraft?: boolean };
      if (readyView.isDraft !== false) {
        throw new Error("PR is still draft after `gh pr ready`");
      }
    } catch (err) {
      failed.push({
        lane: pr.lane,
        reason: `could not mark PR ready: ${String(err instanceof Error ? err.message : err).slice(0, 240)}`,
      });
      continue;
    }
    try {
      execFileSync("gh", ["pr", "checks", String(pr.prNumber), "--repo", pr.repo], { encoding: "utf8" });
    } catch (err) {
      failed.push({
        lane: pr.lane,
        reason: `CI not green: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
      });
      continue;
    }
    try {
      execFileSync("gh", ["pr", "merge", String(pr.prNumber), "--repo", pr.repo, "--squash"], { encoding: "utf8" });
      merged.push({ lane: pr.lane, prNumber: pr.prNumber });
    } catch (err) {
      failed.push({ lane: pr.lane, reason: String(err instanceof Error ? err.message : err).slice(0, 300) });
    }
  }
  return { merged, failed, summary: `Merged ${merged.length}/${prs.length} removal PR(s) after CI verification.` };
}

function writeReport(migrationRoot: string, lanesCompleted: number, approvable: boolean, summaryLines: string[]) {
  const rootPath = expandHome(migrationRoot);
  const reportPath = join(rootPath, "artifacts", "report.html");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Smithers Repo Federation Report</title>
<style>body{font-family:-apple-system,sans-serif;background:#0c0c0e;color:#eee;padding:32px;max-width:900px;margin:0 auto}
h1{font-size:20px}li{margin:6px 0}code{background:#1c1c1f;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>Smithers Repo Federation — migration report</h1>
<p>Lanes completed: <b>${lanesCompleted}</b> / ${ALL_LANES.length}. Final approvable: <b>${approvable}</b>.</p>
<ul>${summaryLines.map((l) => `<li>${l.replace(/</g, "&lt;")}</li>`).join("")}</ul>
</body></html>`;
  mkdirSync(join(rootPath, "artifacts"), { recursive: true });
  writeFileSync(reportPath, html);
  return { reportPath, lanesCompleted, approvable, summary: `Wrote report to ${reportPath}.` };
}

// ── Workflow ─────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const migrationRoot = ctx.input.migrationRoot ?? "~/smithers-federation-migration";
  const githubOrg = ctx.input.githubOrg ?? "";
  const sourceRepo = ctx.input.sourceRepo ?? "smithersai/smithers";
  const existingOwner = sourceRepo.split("/")[0] || "smithersai";
  const dryRun = ctx.input.dryRun ?? false;

  const prepareRootResult = ctx.outputMaybe(outputs.prepareRoot, { nodeId: "prepareRoot" });
  const sourceClone = prepareRootResult?.sourceClonePath ?? `${migrationRoot}/${SOURCE_CLONE_DIR}`;
  const inventory = ctx.outputMaybe(outputs.inventory, { nodeId: "inventory" });
  const manifestReview = ctx.outputMaybe(outputs.manifestReview, { nodeId: "manifestReviewFinalApproved" });
  const gateManifest = ctx.outputMaybe(outputs.gateManifest, { nodeId: "gate-manifest" });
  const manifestApproved = gateManifest?.approved === true;

  const createReposResult = ctx.outputMaybe(outputs.createRepos, { nodeId: "createRepos" });

  // Per-lane state, keyed by dynamic nodeId (see api-ab-benchmark.tsx precedent).
  const extractByLane = new Map(
    ALL_LANES.map((lane) => [lane, ctx.outputMaybe(outputs.laneExtract, { nodeId: `extract-${lane}` })]),
  );
  const decoupleByLane = new Map(
    ALL_LANES.map((lane) => [lane, ctx.outputMaybe(outputs.laneDecouple, { nodeId: `decouple-${lane}` })]),
  );
  const docsByLane = new Map(
    ALL_LANES.map((lane) => [lane, ctx.outputMaybe(outputs.laneDocs, { nodeId: `docs-${lane}` })]),
  );
  // Loop exit conditions must read the LATEST iteration, not the current-render
  // row — ctx.latest() is the documented reader for that (see SmithersCtx.js).
  const verifyByLane = new Map(ALL_LANES.map((lane) => [lane, ctx.latest(outputs.laneVerify, `laneVerify-${lane}`)]));
  const fixByLane = new Map(ALL_LANES.map((lane) => [lane, ctx.latest(outputs.laneFix, `laneFix-${lane}`)]));
  const pushByLane = new Map(
    ALL_LANES.map((lane) => [lane, ctx.outputMaybe(outputs.lanePush, { nodeId: `push-${lane}` })]),
  );

  const allLanesPushed = ALL_LANES.every((lane) => pushByLane.get(lane)?.pushed === true);
  const lanePushResults = ALL_LANES.map((lane) => pushByLane.get(lane)).filter(
    (r): r is NonNullable<typeof r> => r !== undefined,
  );

  const updateSmithersResult = ctx.outputMaybe(outputs.updateSmithers, { nodeId: "updateSmithers" });
  const initialReleaseDryRun = ctx.outputMaybe(outputs.releaseDryRun, { nodeId: "releaseDryRun" });
  const postFixReleaseDryRun = ctx.latest(outputs.releaseDryRun, "releaseDryRunPostFix");
  const releaseDryRunResult = postFixReleaseDryRun ?? initialReleaseDryRun;
  const releaseReadinessResult = ctx.latest(outputs.releaseReadiness, "releaseReadiness");
  const releaseApprovalBindingResult = ctx.outputMaybe(outputs.releaseApprovalBinding, {
    nodeId: "releaseApprovalBinding",
  });

  // The planning-agent Ralph loop must clear BEFORE any destructive
  // publication or merge happens.
  const lastFinalVerify = ctx.latest(outputs.finalVerify, "finalVerify");
  const finalApprovable = lastFinalVerify?.approvable === true;
  const lastFinalFix = ctx.latest(outputs.finalFix, "finalFix");
  const finalReady = finalApprovable && postFixReleaseDryRun?.ok === true && releaseReadinessResult?.ok === true;
  const finalFixList = [
    ...(lastFinalVerify?.fixList ?? []),
    ...(releaseDryRunResult?.ok === false
      ? releaseDryRunResult.issues.map((detail) => ({
          target: "release plan",
          check: "aggregate release dry-run",
          detail,
        }))
      : []),
    ...(releaseReadinessResult?.ok === false
      ? releaseReadinessResult.issues.map((detail) => ({
          target: "release clone",
          check: "clean pushed revision",
          detail,
        }))
      : []),
  ];

  const gatePublish = ctx.outputMaybe(outputs.gatePublish, { nodeId: "gate-publish" });
  const publishApproved = gatePublish?.approved === true;
  const executeReleasesResult = ctx.outputMaybe(outputs.executeReleases, { nodeId: "executeReleases" });
  const removalPrsResult = ctx.outputMaybe(outputs.removalPrs, { nodeId: "removalPrs" });
  const gateMerge = ctx.outputMaybe(outputs.gateMerge, { nodeId: "gate-merge" });
  const mergeApproved = gateMerge?.approved === true;
  const mergeRemovalPrsResult = ctx.outputMaybe(outputs.mergeRemovalPrs, { nodeId: "mergeRemovalPrs" });
  const landedVerifyResult = ctx.outputMaybe(outputs.landedVerify, { nodeId: "landedVerify" });

  const lanesCompleted = ALL_LANES.filter((lane) => pushByLane.get(lane)?.pushed === true).length;

  return (
    <Workflow name="smithers-repo-federation">
      <UI entry="../ui/smithers-repo-federation.tsx" title="Smithers Repo Federation" />
      <Sequence>
        <Task id="prepareRoot" output={outputs.prepareRoot}>
          {() => prepareRoot(migrationRoot, sourceRepo, githubOrg)}
        </Task>

        {prepareRootResult ? (
          <Task id="inventory" output={outputs.inventory} agent={agents.cheapFast} heartbeatTimeoutMs={900_000}>
            <FederationInventoryPrompt migrationRoot={migrationRoot} githubOrg={githubOrg} sourceClone={sourceClone} />
          </Task>
        ) : null}

        {inventory ? (
          <Task id="manifestReviewFinalApproved" output={outputs.manifestReview} agent={agents.implement}>
            <FederationManifestReviewPrompt
              migrationRoot={migrationRoot}
              sourceClone={sourceClone}
              inventory={inventory}
            />
          </Task>
        ) : null}

        {manifestReview?.approvable === true ? (
          <Approval
            id="gate-manifest"
            output={outputs.gateManifest}
            request={{
              title: "Approve the federation manifest + DAG?",
              summary: `${manifestReview.summary}\nBoundary issues: ${manifestReview.boundaryIssues.length}, ambiguous utilities: ${manifestReview.ambiguousUtilities.length}, license gaps: ${manifestReview.licenseGaps.length}.\n\nApproving proceeds to create the 10 PUBLIC destination repos and run all 13 lanes.`,
              metadata: { migrationRoot, githubOrg, dryRun },
            }}
            onDeny="skip"
          />
        ) : null}

        <Branch
          if={!dryRun && manifestApproved && manifestReview?.approvable === true}
          then={
            <Sequence>
              <Task id="createRepos" output={outputs.createRepos}>
                {() => createRepos(migrationRoot, githubOrg)}
              </Task>

              {createReposResult?.ready === true ? (
                <Parallel maxConcurrency={4}>
                  {ALL_LANES.map((lane) => {
                    const extractResult = extractByLane.get(lane);
                    const decoupleResult = decoupleByLane.get(lane);
                    const docsResult = docsByLane.get(lane);
                    const lastVerify = verifyByLane.get(lane);
                    const lastFix = fixByLane.get(lane);
                    const verifyPassed = lastVerify?.passed === true;
                    const branch = laneBranch(lane);
                    const prOnly = isPrOnlyLane(lane);
                    const kind = laneKind(lane);
                    return (
                      <Sequence key={lane}>
                        <Task
                          id={`extract-${lane}`}
                          output={outputs.laneExtract}
                          agent={agents.cheapFast}
                          timeoutMs={30 * 60_000}
                          heartbeatTimeoutMs={10 * 60_000}
                        >
                          <FederationLaneExtractPrompt
                            lane={lane}
                            branch={branch}
                            laneKind={kind}
                            existingRepo={`${existingOwner}/${lane}`}
                            sourceClone={sourceClone}
                            migrationRoot={migrationRoot}
                          />
                        </Task>
                        {extractResult ? (
                          <Task
                            id={`decouple-${lane}`}
                            output={outputs.laneDecouple}
                            agent={agents.implement}
                            timeoutMs={45 * 60_000}
                            heartbeatTimeoutMs={15 * 60_000}
                          >
                            <FederationLaneDecouplePrompt
                              lane={lane}
                              prOnly={prOnly}
                              laneKind={kind}
                              migrationRoot={migrationRoot}
                              extractResult={extractResult}
                            />
                          </Task>
                        ) : null}
                        {decoupleResult ? (
                          <Task
                            id={`docs-${lane}`}
                            output={outputs.laneDocs}
                            agent={agents.cheapFast}
                            timeoutMs={20 * 60_000}
                            heartbeatTimeoutMs={10 * 60_000}
                          >
                            <FederationLaneDocsPrompt
                              lane={lane}
                              prOnly={prOnly}
                              migrationRoot={migrationRoot}
                              decoupleResult={decoupleResult}
                            />
                          </Task>
                        ) : null}
                        {docsResult ? (
                          <Loop
                            id={`lane-loop-${lane}`}
                            until={verifyPassed}
                            maxIterations={3}
                            onMaxReached="return-last"
                          >
                            <Sequence>
                              <Task
                                id={`laneVerify-${lane}`}
                                output={outputs.laneVerify}
                                agent={agents.planning}
                                timeoutMs={30 * 60_000}
                                heartbeatTimeoutMs={10 * 60_000}
                              >
                                <FederationLaneVerifyPrompt
                                  lane={lane}
                                  prOnly={prOnly}
                                  laneKind={kind}
                                  migrationRoot={migrationRoot}
                                  docsResult={docsResult}
                                  priorFix={lastFix ?? null}
                                />
                              </Task>
                              <Branch
                                if={lastVerify !== undefined && lastVerify.passed === false}
                                then={
                                  <Task
                                    id={`laneFix-${lane}`}
                                    output={outputs.laneFix}
                                    agent={agents.implement}
                                    timeoutMs={40 * 60_000}
                                    heartbeatTimeoutMs={15 * 60_000}
                                  >
                                    <FederationLaneFixPrompt
                                      lane={lane}
                                      prOnly={prOnly}
                                      migrationRoot={migrationRoot}
                                      verifyResult={lastVerify}
                                    />
                                  </Task>
                                }
                                else={null}
                              />
                            </Sequence>
                          </Loop>
                        ) : null}
                        {verifyPassed ? (
                          <Task id={`push-${lane}`} output={outputs.lanePush} timeoutMs={10 * 60_000}>
                            {() =>
                              prOnly
                                ? pushPrLane(migrationRoot, lane, existingOwner)
                                : pushNewRepoLane(migrationRoot, lane, githubOrg)
                            }
                          </Task>
                        ) : null}
                      </Sequence>
                    );
                  })}
                </Parallel>
              ) : null}

              {allLanesPushed ? (
                <Task
                  id="updateSmithers"
                  output={outputs.updateSmithers}
                  agent={agents.implement}
                  timeoutMs={60 * 60_000}
                  heartbeatTimeoutMs={20 * 60_000}
                >
                  <FederationUpdateSmithersPrompt
                    branch={UPDATE_SMITHERS_BRANCH}
                    migrationRoot={migrationRoot}
                    sourceClone={sourceClone}
                    sourceRepo={sourceRepo}
                    kernelCloneDir={KERNEL_CLONE_DIR}
                    lanePushResults={lanePushResults}
                  />
                </Task>
              ) : null}

              {updateSmithersResult ? (
                <Task
                  id="releaseDryRun"
                  output={outputs.releaseDryRun}
                  agent={agents.planning}
                  timeoutMs={45 * 60_000}
                  heartbeatTimeoutMs={15 * 60_000}
                >
                  <FederationReleaseDryRunPrompt
                    migrationRoot={migrationRoot}
                    kernelCloneDir={KERNEL_CLONE_DIR}
                    lanePushResults={lanePushResults}
                  />
                </Task>
              ) : null}

              {initialReleaseDryRun ? (
                <Ralph id="final-verify-loop" until={finalReady} maxIterations={4} onMaxReached="return-last">
                  <Sequence>
                    <Task
                      id="finalVerify"
                      output={outputs.finalVerify}
                      agent={agents.planning}
                      timeoutMs={30 * 60_000}
                      heartbeatTimeoutMs={15 * 60_000}
                    >
                      <FederationFinalVerifyPrompt
                        migrationRoot={migrationRoot}
                        kernelCloneDir={KERNEL_CLONE_DIR}
                        lanePushResults={lanePushResults}
                        updateSmithersResult={updateSmithersResult}
                        releaseDryRun={releaseDryRunResult}
                        priorFix={lastFinalFix ?? null}
                      />
                    </Task>
                    <Branch
                      if={
                        lastFinalVerify !== undefined &&
                        (lastFinalVerify.approvable === false ||
                          releaseDryRunResult?.ok === false ||
                          releaseReadinessResult?.ok === false)
                      }
                      then={
                        <Task
                          id="finalFix"
                          output={outputs.finalFix}
                          agent={agents.implement}
                          timeoutMs={40 * 60_000}
                          heartbeatTimeoutMs={15 * 60_000}
                        >
                          <FederationFinalFixPrompt
                            migrationRoot={migrationRoot}
                            kernelCloneDir={KERNEL_CLONE_DIR}
                            fixList={finalFixList}
                          />
                        </Task>
                      }
                      else={null}
                    />
                    <Task
                      id="releaseDryRunPostFix"
                      output={outputs.releaseDryRun}
                      agent={agents.planning}
                      timeoutMs={45 * 60_000}
                      heartbeatTimeoutMs={15 * 60_000}
                    >
                      <FederationReleaseDryRunPrompt
                        migrationRoot={migrationRoot}
                        kernelCloneDir={KERNEL_CLONE_DIR}
                        lanePushResults={lanePushResults}
                      />
                    </Task>
                    <Task id="releaseReadiness" output={outputs.releaseReadiness} timeoutMs={10 * 60_000}>
                      {() => verifyReleaseClonesReady(migrationRoot, lanePushResults)}
                    </Task>
                  </Sequence>
                </Ralph>
              ) : null}

              {finalReady ? (
                <Task id="releaseApprovalBinding" output={outputs.releaseApprovalBinding} timeoutMs={10 * 60_000}>
                  {() => captureReleaseApprovalBinding(migrationRoot, lanePushResults)}
                </Task>
              ) : null}

              {releaseApprovalBindingResult ? (
                <Approval
                  id="gate-publish"
                  output={outputs.gatePublish}
                  bind={ctx.prove(outputs.releaseApprovalBinding, { nodeId: "releaseApprovalBinding" })}
                  request={{
                    title: "Publish the 10 federated PUBLIC repos?",
                    summary: `${postFixReleaseDryRun?.summary ?? ""}\nRevision readiness: ${releaseReadinessResult?.summary ?? ""}\nApproval binding: ${releaseApprovalBindingResult.summary}\nFinal verification: ${lastFinalVerify?.summary ?? ""}\n\nApproving invokes the validated root release coordinator (publishes every publishable package in the release plan, in package-DAG order) and creates tags + GitHub releases for each of the 10 new repos.`,
                    metadata: {
                      ok: postFixReleaseDryRun?.ok === true,
                      revisionsReady: releaseReadinessResult?.ok === true,
                      approvable: finalApprovable,
                      laneHeads: Object.fromEntries(
                        releaseApprovalBindingResult.laneRevisions.map((revision) => [revision.lane, revision.headSha]),
                      ),
                      releasePlanSha256: releaseApprovalBindingResult.releasePlanSha256,
                      coordinatorSha256: releaseApprovalBindingResult.coordinatorSha256,
                    },
                  }}
                  onDeny="skip"
                />
              ) : null}

              {publishApproved && releaseApprovalBindingResult ? (
                <Task
                  id="executeReleases"
                  output={outputs.executeReleases}
                  bind={[
                    requireProofBinding(ctx.prove(outputs.gatePublish, { nodeId: "gate-publish" }), "gate-publish"),
                    requireProofBinding(
                      ctx.prove(outputs.releaseApprovalBinding, { nodeId: "releaseApprovalBinding" }),
                      "releaseApprovalBinding",
                    ),
                  ]}
                  timeoutMs={30 * 60_000}
                >
                  {() =>
                    executeReleases(
                      migrationRoot,
                      githubOrg,
                      finalReady,
                      lanePushResults,
                      releaseApprovalBindingResult as z.infer<typeof releaseApprovalBindingSchema>,
                    )
                  }
                </Task>
              ) : null}

              {executeReleasesResult ? (
                <Task id="removalPrs" output={outputs.removalPrs} timeoutMs={10 * 60_000}>
                  {() => removalPRs(migrationRoot, sourceRepo, updateSmithersResult, lanePushResults)}
                </Task>
              ) : null}

              {removalPrsResult ? (
                <Approval
                  id="gate-merge"
                  output={outputs.gateMerge}
                  request={{
                    title: "Merge the removal/reference-update PRs?",
                    summary: `${removalPrsResult.summary}\n\nApproving squash-merges the smithers kernel-strip PR and the multi/plue/awesome-smithers PRs — only where CI is verified green, with explicit --repo.`,
                    metadata: { prCount: removalPrsResult.prs.length },
                  }}
                  onDeny="skip"
                />
              ) : null}

              {mergeApproved ? (
                <Task id="mergeRemovalPrs" output={outputs.mergeRemovalPrs} timeoutMs={10 * 60_000}>
                  {() => mergeRemovalPRs(removalPrsResult?.prs ?? [])}
                </Task>
              ) : null}

              {mergeRemovalPrsResult ? (
                <Task
                  id="landedVerify"
                  output={outputs.landedVerify}
                  agent={agents.planning}
                  timeoutMs={30 * 60_000}
                  heartbeatTimeoutMs={15 * 60_000}
                >
                  <FederationLandedVerifyPrompt
                    migrationRoot={migrationRoot}
                    kernelCloneDir={KERNEL_CLONE_DIR}
                    githubOrg={githubOrg}
                    sourceRepo={sourceRepo}
                    executeReleases={executeReleasesResult ?? null}
                    mergeRemovalPrs={mergeRemovalPrsResult}
                    lanePushResults={lanePushResults}
                  />
                </Task>
              ) : null}
            </Sequence>
          }
          else={null}
        />

        <Task id="report" output={outputs.report} timeoutMs={5 * 60_000}>
          {() =>
            writeReport(
              migrationRoot,
              lanesCompleted,
              finalApprovable && (dryRun || landedVerifyResult?.approvable === true),
              [
                inventory ? `Inventory: ${inventory.summary}` : "Inventory not run.",
                manifestReview ? `Manifest review: ${manifestReview.summary}` : "Manifest review not run.",
                dryRun
                  ? "dryRun=true: stopped after the manifest approval gate."
                  : `Lanes pushed: ${lanesCompleted}/${ALL_LANES.length}.`,
                updateSmithersResult ? `Kernel strip: ${updateSmithersResult.summary}` : "Kernel strip not run.",
                releaseDryRunResult ? `Release dry-run: ${releaseDryRunResult.summary}` : "Release dry-run not run.",
                lastFinalVerify ? `Final verify: ${lastFinalVerify.summary}` : "Final verify not run.",
                landedVerifyResult ? `Landed verify: ${landedVerifyResult.summary}` : "Landed verify not run.",
              ],
            )
          }
        </Task>
      </Sequence>
    </Workflow>
  );
});
