// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Share pack
// smithers-description: Validate, prepare, publish, and list a Smithers workflow pack in awesome-smithers.
// smithers-tags: packs, sharing, github
// smithers-system: true
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, UI } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({
  repo: z.string().optional().describe("GitHub repository to create for the pack."),
  registry: z.string().optional().describe("awesome-smithers repository override."),
  dryRun: z.boolean().default(false),
});
const stepSchema = z.object({ ok: z.boolean(), detail: z.string() });
const completionSchema = z.object({ completed: z.boolean(), detail: z.string() });
const prepareSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
  stagingRoot: z.string().nullable().default(null),
});
const outputSchema = z.object({
  validated: z.boolean(),
  prepared: z.boolean(),
  published: z.boolean(),
  shared: z.boolean(),
  detail: z.string(),
});
const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({
  input: inputSchema,
  validate: stepSchema,
  completion: completionSchema,
  revalidate: stepSchema,
  prepare: prepareSchema,
  publish: stepSchema,
  share: stepSchema,
  output: outputSchema,
});
const cliModule = (name: string) =>
  process.env.SMITHERS_CLI_SRC_DIR
    ? `${process.env.SMITHERS_CLI_SRC_DIR}/${name}.js`
    : `@smithers-orchestrator/cli/${name}`;

async function validateManifest(repo: string | undefined, registry: string | undefined) {
  const { loadManifest } = await import(cliModule("manifest"));
  const { findPackRoot, resolveShareRepositories } = await import(cliModule("share"));
  const packRoot = findPackRoot(process.cwd());
  const manifest = loadManifest(`${packRoot}/smithers.toon`);
  try {
    resolveShareRepositories({ repository: repo, manifestRepository: manifest.repository, registry });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason} (manifest ${packRoot}/smithers.toon has repository=${JSON.stringify(manifest.repository)}${repo === undefined ? "" : `, input repo=${JSON.stringify(repo)}`})`,
    );
  }
  if (!manifest.description) throw new Error("smithers.toon needs a description before the pack can be listed");
  return manifest;
}

export default smithers((ctx) => {
  const validate = ctx.outputMaybe("validate", { nodeId: "validate-manifest" });
  const completion = ctx.outputMaybe("completion", { nodeId: "complete-manifest" });
  const revalidate = ctx.outputMaybe("revalidate", { nodeId: "revalidate-manifest" });
  const prepare = ctx.outputMaybe("prepare", { nodeId: "prepare-pack" });
  const publish = ctx.outputMaybe("publish", { nodeId: "publish-pack" });
  const shared = ctx.outputMaybe("share", { nodeId: "share-registry" });
  const manifestReady = validate?.ok === true || revalidate?.ok === true;
  // The agent completes an incomplete manifest exactly once; if deterministic
  // revalidation still fails afterwards, the run terminates with that detail.
  // Mount stays keyed on the validation verdict (not on completion's absence)
  // so the finished agent task remains in the tree instead of unmounting.
  const needsCompletion = validate?.ok === false;
  const canPrepare = manifestReady;
  const canPublish = prepare?.ok === true && !ctx.input.dryRun;
  const canShare = prepare?.ok === true && (ctx.input.dryRun || publish?.ok === true);
  // A failed validation is NOT terminal until the completion agent has had
  // its one chance and revalidation still fails — otherwise the terminal
  // output task would race the completion task it is supposed to wait for.
  const manifestTerminal = revalidate ? !revalidate.ok : validate?.ok === false && completion !== undefined;
  const terminalFailure = manifestTerminal || [prepare, publish, shared].some((row) => row && !row.ok);
  const done = shared?.ok === true || terminalFailure;
  return (
    <Workflow name="share-pack">
      <Sequence>
        <Task id="validate-manifest" output={outputs.validate} retries={0}>
          {async () => {
            try {
              await validateManifest(ctx.input.repo, ctx.input.registry);
              return { ok: true, detail: "smithers.toon is valid" };
            } catch (error) {
              return { ok: false, detail: error instanceof Error ? error.message : String(error) };
            }
          }}
        </Task>
        {needsCompletion ? (
          <Task id="complete-manifest" output={outputs.completion} agent={agents.cheapFast}>
            {`The pack manifest .smithers/smithers.toon in this repository is incomplete: ${validate?.detail ?? "unknown"}.
Complete it: fill in name (kebab-case, from the project), a one-sentence description, repository (owner/name${ctx.input.repo ? `; the user wants ${ctx.input.repo}` : "; derive from \`git remote get-url origin\` when available, otherwise leave it and report why"}), and reconcile contents.workflows / contents.ui with the actual files under .smithers/workflows and .smithers/ui (flat <id>.tsx or <id>/workflow.tsx forms; ui entries only for real UI entrypoints).
Edit ONLY .smithers/smithers.toon. Return completed=true when the manifest is filled, with a one-line detail of what you changed.`}
          </Task>
        ) : null}
        {completion ? (
          <Task id="revalidate-manifest" output={outputs.revalidate} retries={0}>
            {async () => {
              try {
                await validateManifest(ctx.input.repo, ctx.input.registry);
                return { ok: true, detail: "smithers.toon is valid after completion" };
              } catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error) };
              }
            }}
          </Task>
        ) : null}
        {canPrepare ? (
          <Task id="prepare-pack" output={outputs.prepare} retries={0}>
            {async () => {
              try {
                const { preparePackForShare } = await import(cliModule("share"));
                // Staging-copy flow: the live .smithers is never mutated. The staging
                // path is persisted so publish uses THIS artifact and cleanup can
                // always find it, even in a fresh process after a durable retry.
                const result = preparePackForShare({ from: process.cwd(), repository: ctx.input.repo });
                return { ok: true, detail: result.detail, stagingRoot: result.stagingRoot };
              } catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error), stagingRoot: null };
              }
            }}
          </Task>
        ) : null}
        {canPublish ? (
          <Task id="publish-pack" output={outputs.publish} retries={0}>
            {async () => {
              try {
                const { publishPackRepository } = await import(cliModule("share"));
                return {
                  ok: true,
                  detail: publishPackRepository({
                    from: process.cwd(),
                    repository: ctx.input.repo,
                    stagingRoot: prepare?.stagingRoot ?? undefined,
                  }),
                };
              } catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error) };
              }
            }}
          </Task>
        ) : null}
        {canShare ? (
          <Task id="share-registry" output={outputs.share} retries={0}>
            {async () => {
              try {
                const { sharePack } = await import(cliModule("share"));
                const result = sharePack({
                  from: process.cwd(),
                  repository: ctx.input.repo,
                  repo: ctx.input.registry,
                  dryRun: ctx.input.dryRun,
                });
                return { ok: true, detail: result.pullRequest ?? result.entry };
              } catch (error) {
                return { ok: false, detail: error instanceof Error ? error.message : String(error) };
              }
            }}
          </Task>
        ) : null}
        {done ? (
          <Task id="output" output={outputs.output}>
            {async () => {
              // Terminal cleanup on every path (success, dry-run, or failure): the
              // staging copy must never outlive the run.
              const stagingRoot = prepare?.stagingRoot;
              if (stagingRoot) {
                const { rmSync } = await import("node:fs");
                rmSync(stagingRoot, { recursive: true, force: true });
              }
              return {
                validated: manifestReady,
                prepared: prepare?.ok === true,
                published: publish?.ok === true,
                shared: shared?.ok === true,
                detail:
                  [revalidate ?? validate, prepare, publish, shared].find((row) => row && !row.ok)?.detail ??
                  shared?.detail ??
                  "Share did not complete",
              };
            }}
          </Task>
        ) : null}
      </Sequence>
      <UI entry="../ui/share-pack.tsx" />
    </Workflow>
  );
});
