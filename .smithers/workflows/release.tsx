// smithers-source: user
// smithers-display-name: Release
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import FeatureDocSyncAuditPrompt from "../prompts/feature-doc-sync-audit.mdx";

const inputSchema = z.object({
  bump: z
    .enum(["patch", "minor", "major"])
    .default("patch")
    .describe("Version bump type. major requires explicit approval (pre-1.0 policy)."),
  runPublish: z
    .boolean()
    .default(false)
    .describe("Run `pnpm release` after bumping. Default false — bump only, then publish manually."),
  skipChecks: z
    .boolean()
    .default(false)
    .describe("Forward --skip-checks to `pnpm release` (skip lint/typecheck/test)."),
  requireMarketingContent: z
    .boolean()
    .default(false)
    .describe("Require an approved release-content marker before bumping/publishing."),
  marketingArtifactDir: z
    .string()
    .default(".smithers/executions/release-content")
    .describe("Directory containing release-content approved-<version>.json markers."),
  skipFeatureDocSync: z
    .boolean()
    .default(false)
    .describe("Skip the LLM feature/doc sync audit gate before bumping/publishing."),
});

const probeSchema = z.object({
  currentVersion: z.string(),
  nextVersion: z.string(),
  bump: z.enum(["patch", "minor", "major"]),
  changelogPath: z.string(),
  /** Last version published to npm (the source of truth for "last release"). */
  lastPublishedVersion: z.string().nullable().default(null),
  /** Git ref the published version resolved to (e.g. "v0.25.1"), if found. */
  lastReleaseRef: z.string().nullable().default(null),
  /** One-line `<sha> <subject>` for every commit since the last npm release. */
  commitsSinceRelease: z.array(z.string()).default([]),
  commitCount: z.number().default(0),
});

const changelogSchema = z.object({
  changelogPath: z.string(),
  ok: z.boolean(),
  sidebarUpdated: z.boolean().default(false),
  /** How many commits this release covers, per the npm-based probe. */
  commitsSinceRelease: z.number().default(0),
});

const marketingContentSchema = z.object({
  ok: z.boolean(),
  markerPath: z.string(),
  message: z.string(),
});

const bumpResultSchema = z.object({
  newVersion: z.string(),
});

const publishResultSchema = z.object({
  published: z.boolean(),
  message: z.string(),
});

const majorApprovalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

const featureDocSyncSchema = z.object({
  ok: z.boolean(),
  missingFeatures: z.array(z.string()).default([]),
  missingDocs: z.array(z.string()).default([]),
  notes: z.string().default(""),
});

const featureDocSyncGateSchema = z.object({
  ok: z.boolean(),
});

const { Workflow, Task, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  probe: probeSchema,
  changelog: changelogSchema,
  marketingContent: marketingContentSchema,
  majorApproval: majorApprovalSchema,
  featureDocSync: featureDocSyncSchema,
  featureDocSyncGate: featureDocSyncGateSchema,
  bumpResult: bumpResultSchema,
  publishResult: publishResultSchema,
});

export default smithers((ctx) => {
  const isMajor = ctx.input.bump === "major";

  return (
    <Workflow name="release">
      <Sequence>
        <Task id="probe" output={outputs.probe}>
          {async () => {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const root = process.cwd();
            const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
              version: string;
            };
            const parts = pkg.version.split(".").map((s) => Number(s));
            if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
              throw new Error(`Cannot parse version "${pkg.version}" — expected MAJOR.MINOR.PATCH`);
            }
            let [maj, min, pat] = parts as [number, number, number];
            if (ctx.input.bump === "major") {
              maj += 1;
              min = 0;
              pat = 0;
            } else if (ctx.input.bump === "minor") {
              min += 1;
              pat = 0;
            } else {
              pat += 1;
            }
            const next = `${maj}.${min}.${pat}`;

            // Source of truth for "the last release" is npm, not a local git
            // tag or HEAD. A local tag can be ahead of what actually shipped,
            // or missing, which is how a changelog ends up undercounting the
            // commits in a release. Ask npm what the published `latest` is,
            // resolve that to a git ref, and list every commit since.
            const { execSync } = await import("node:child_process");
            const run = (cmd: string) =>
              execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
            let lastPublishedVersion: string | null = null;
            let lastReleaseRef: string | null = null;
            let commitsSinceRelease: string[] = [];
            try {
              lastPublishedVersion = run("npm view smithers-orchestrator version") || null;
            } catch {
              // Offline or never-published: fall back to nothing rather than
              // failing the whole release. The changelog gate still runs.
              lastPublishedVersion = null;
            }
            if (lastPublishedVersion) {
              // Prefer the annotated tag; fall back to the release commit
              // (`chore(release): <version>`) if the tag is missing locally.
              const candidates = [`v${lastPublishedVersion}`, lastPublishedVersion];
              for (const ref of candidates) {
                try {
                  run(`git rev-parse --verify --quiet ${ref}^{commit}`);
                  lastReleaseRef = ref;
                  break;
                } catch {
                  // try next candidate
                }
              }
              if (!lastReleaseRef) {
                try {
                  const sha = run(
                    `git log --grep="release): ${lastPublishedVersion}" --fixed-strings -n 1 --format=%H`,
                  );
                  if (sha) lastReleaseRef = sha;
                } catch {
                  lastReleaseRef = null;
                }
              }
              if (lastReleaseRef) {
                try {
                  const out = run(`git log ${lastReleaseRef}..HEAD --oneline --no-merges`);
                  commitsSinceRelease = out.split("\n").map((l) => l.trim()).filter(Boolean);
                } catch {
                  commitsSinceRelease = [];
                }
              }
            }

            return {
              currentVersion: pkg.version,
              nextVersion: next,
              // ctx.input fields arrive null (not the zod default) when no
              // --input is passed, so coalesce to match the patch default the
              // version math above already uses; otherwise the probe row fails
              // its `bump` enum and the whole release errors before bumping.
              bump: ctx.input.bump ?? "patch",
              changelogPath: `docs/changelogs/${next}.mdx`,
              lastPublishedVersion,
              lastReleaseRef,
              commitsSinceRelease,
              commitCount: commitsSinceRelease.length,
            };
          }}
        </Task>

        <Task id="changelog-check" output={outputs.changelog}>
          {async () => {
            const fs = await import("node:fs");
            const path = await import("node:path");
            const probe = ctx.outputMaybe(outputs.probe, { nodeId: "probe" });
            if (!probe) throw new Error("probe did not complete");
            const abs = path.resolve(process.cwd(), probe.changelogPath);
            if (!fs.existsSync(abs)) {
              throw new Error(
                `Missing changelog at ${probe.changelogPath}.\n` +
                  `Write the changelog for v${probe.nextVersion} before releasing, then re-run.`,
              );
            }

            // Ensure the changelog page is registered in the Mintlify sidebar
            // (docs/docs.json). The file existing on disk is not enough — an
            // unregistered page never shows up in the published docs sidebar.
            const pageId = `changelogs/${probe.nextVersion}`;
            const docsJsonPath = path.resolve(process.cwd(), "docs/docs.json");
            let sidebarUpdated = false;
            if (fs.existsSync(docsJsonPath)) {
              const raw = fs.readFileSync(docsJsonPath, "utf8");
              const docs = JSON.parse(raw) as unknown;
              const findChangelogGroup = (node: unknown): { pages: unknown[] } | null => {
                if (Array.isArray(node)) {
                  for (const item of node) {
                    const found = findChangelogGroup(item);
                    if (found) return found;
                  }
                  return null;
                }
                if (node && typeof node === "object") {
                  const obj = node as Record<string, unknown>;
                  if (obj.group === "Changelog" && Array.isArray(obj.pages)) {
                    return obj as { pages: unknown[] };
                  }
                  for (const value of Object.values(obj)) {
                    const found = findChangelogGroup(value);
                    if (found) return found;
                  }
                }
                return null;
              };
              const group = findChangelogGroup(docs);
              if (!group) {
                throw new Error(
                  `Could not find a "Changelog" group in docs/docs.json to register ${pageId}.`,
                );
              }
              if (!group.pages.includes(pageId)) {
                // Newest first — prepend so the latest release sits at the top.
                group.pages.unshift(pageId);
                fs.writeFileSync(docsJsonPath, `${JSON.stringify(docs, null, 2)}\n`);
                sidebarUpdated = true;
              }
            }

            // Surface the real scope of this release (commits since the last
            // npm publish) so the changelog can be checked for completeness.
            // This is the data that, when ignored, lets a 67-commit release
            // ship a "two small fixes" changelog.
            const since = probe.lastPublishedVersion
              ? `v${probe.lastPublishedVersion}`
              : "(no published version found on npm)";
            console.log(
              `[release] v${probe.nextVersion} covers ${probe.commitCount} commit(s) since ${since}:`,
            );
            for (const line of probe.commitsSinceRelease) console.log(`  ${line}`);
            console.log(
              `[release] Confirm ${probe.changelogPath} reflects all ${probe.commitCount} commit(s) above before publishing.`,
            );

            return {
              changelogPath: probe.changelogPath,
              ok: true,
              sidebarUpdated,
              commitsSinceRelease: probe.commitCount,
            };
          }}
        </Task>

        <Task
          id="marketing-content-check"
          output={outputs.marketingContent}
          skipIf={!ctx.input.requireMarketingContent}
        >
          {async () => {
            const probe = ctx.outputMaybe(outputs.probe, { nodeId: "probe" });
            if (!probe) throw new Error("probe did not complete");
            const { hasApprovedMarketingContent } = await import("../lib/release-content/files");
            const result = hasApprovedMarketingContent(
              probe.nextVersion,
              ctx.input.marketingArtifactDir,
            );
            if (!result.ok) {
              throw new Error(
                `${result.message}\n` +
                  `Run the release-content workflow with dryRun=false, review the previews, approve the gate, then re-run release.`,
              );
            }
            return result;
          }}
        </Task>

        <Task
          id="feature-doc-sync"
          output={outputs.featureDocSync}
          agent={agents.research}
          skipIf={ctx.input.skipFeatureDocSync}
          heartbeatTimeoutMs={300000}
        >
          <FeatureDocSyncAuditPrompt />
        </Task>

        <Task
          id="feature-doc-sync-gate"
          output={outputs.featureDocSyncGate}
          skipIf={ctx.input.skipFeatureDocSync}
        >
          {async () => {
            const audit = ctx.outputMaybe(outputs.featureDocSync, {
              nodeId: "feature-doc-sync",
            }) as z.infer<typeof featureDocSyncSchema> | undefined;
            if (!audit) return { ok: true };
            if (!audit.ok) {
              const sections = [
                audit.missingFeatures.length
                  ? `Missing from .smithers/specs/features.ts:\n  - ${audit.missingFeatures.join("\n  - ")}`
                  : "",
                audit.missingDocs.length
                  ? `Missing from docs/:\n  - ${audit.missingDocs.join("\n  - ")}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n\n");
              throw new Error(
                `Feature/doc sync audit failed before release.\n\n${sections}\n\n` +
                  `${audit.notes}\n\n` +
                  `Record the new features in .smithers/specs/features.ts and document them ` +
                  `under docs/ (the API reference lives in docs/reference/), then re-run release. ` +
                  `To bypass intentionally, re-run with input { "skipFeatureDocSync": true }.`,
              );
            }
            return { ok: true };
          }}
        </Task>

        {isMajor ? (
          <Approval
            id="major-approval"
            output={outputs.majorApproval}
            request={{
              title: `Approve MAJOR version bump`,
              summary:
                "Pre-1.0 policy: major releases require explicit human approval. Approving will run `pnpm version major`.",
            }}
            onDeny="fail"
          />
        ) : null}

        <Task id="bump" output={outputs.bumpResult}>
          {async () => {
            const { execSync } = await import("node:child_process");
            const fs = await import("node:fs");
            const path = await import("node:path");
            const probe = ctx.outputMaybe(outputs.probe, { nodeId: "probe" });
            if (!probe) throw new Error("probe did not complete");
            execSync(`pnpm version ${probe.bump}`, { cwd: process.cwd(), stdio: "inherit" });
            const pkg = JSON.parse(
              fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
            ) as { version: string };
            return { newVersion: pkg.version };
          }}
        </Task>

        <Task id="publish" output={outputs.publishResult}>
          {async () => {
            const bump = ctx.outputMaybe(outputs.bumpResult, { nodeId: "bump" });
            const newVersion = bump?.newVersion ?? "?";
            if (!ctx.input.runPublish) {
              return {
                published: false,
                message:
                  `Bumped to v${newVersion}. Skipped publish (runPublish=false). ` +
                  `Run \`pnpm release\` manually when ready.`,
              };
            }
            const { execSync } = await import("node:child_process");
            const flags = ctx.input.skipChecks ? " -- --skip-checks" : "";
            execSync(`pnpm release${flags}`, { cwd: process.cwd(), stdio: "inherit" });
            return { published: true, message: `Published v${newVersion} via pnpm release.` };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
