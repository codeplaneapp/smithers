// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Share pack
// smithers-description: Validate, prepare, publish, and list a Smithers workflow pack in awesome-smithers.
// smithers-tags: packs, sharing, github
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, UI } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  repo: z.string().optional().describe("GitHub repository to create for the pack."),
  registry: z.string().optional().describe("awesome-smithers repository override."),
  dryRun: z.boolean().default(false),
});
const stepSchema = z.object({ ok: z.boolean(), detail: z.string() });
const outputSchema = z.object({ validated: z.boolean(), prepared: z.boolean(), published: z.boolean(), shared: z.boolean(), detail: z.string() });
const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({ input: inputSchema, validate: stepSchema, prepare: stepSchema, publish: stepSchema, share: stepSchema, output: outputSchema });
const cliModule = (name: string) => process.env.SMITHERS_CLI_SRC_DIR ? `${process.env.SMITHERS_CLI_SRC_DIR}/${name}.js` : `@smithers-orchestrator/cli/${name}`;

export default smithers((ctx) => {
  const validate = ctx.outputMaybe("validate", { nodeId: "validate-manifest" });
  const prepare = ctx.outputMaybe("prepare", { nodeId: "prepare-pack" });
  const publish = ctx.outputMaybe("publish", { nodeId: "publish-pack" });
  const shared = ctx.outputMaybe("share", { nodeId: "share-registry" });
  const canPrepare = validate?.ok === true;
  const canPublish = prepare?.ok === true && !ctx.input.dryRun;
  const canShare = prepare?.ok === true && (ctx.input.dryRun || publish?.ok === true);
  const terminalFailure = [validate, prepare, publish, shared].some((row) => row && !row.ok);
  return <Workflow name="share-pack"><Sequence>
    <Task id="validate-manifest" output={outputs.validate} retries={0}>{async () => {
      try {
        const { loadManifest } = await import(cliModule("manifest"));
        const { findPackRoot, resolveShareRepositories } = await import(cliModule("share"));
        const manifest = loadManifest(`${findPackRoot(process.cwd())}/smithers.toon`);
        resolveShareRepositories({ repository: ctx.input.repo, manifestRepository: manifest.repository, registry: ctx.input.registry });
        return { ok: true, detail: "smithers.toon is valid" };
      } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
    }}</Task>
    {canPrepare ? <Task id="prepare-pack" output={outputs.prepare} retries={0}>{async () => {
      try {
        const { preparePackForShare } = await import(cliModule("share"));
        // Staging-copy flow: the live .smithers is never mutated.
        return { ok: true, detail: preparePackForShare({ from: process.cwd(), repository: ctx.input.repo }).detail };
      } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
    }}</Task> : null}
    {canPublish ? <Task id="publish-pack" output={outputs.publish} retries={0}>{async () => {
      try {
        const { publishPackRepository } = await import(cliModule("share"));
        return { ok: true, detail: publishPackRepository({ from: process.cwd(), repository: ctx.input.repo }) };
      } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
    }}</Task> : null}
    {canShare ? <Task id="share-registry" output={outputs.share} retries={0}>{async () => {
      try {
        const { sharePack } = await import(cliModule("share"));
        const result = sharePack({ from: process.cwd(), repository: ctx.input.repo, repo: ctx.input.registry, dryRun: ctx.input.dryRun });
        return { ok: true, detail: result.pullRequest ?? result.entry };
      } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
    }}</Task> : null}
    {(shared?.ok === true || terminalFailure) ? <Task id="output" output={outputs.output}>{() => ({ validated: validate?.ok === true, prepared: prepare?.ok === true, published: publish?.ok === true, shared: shared?.ok === true, detail: [validate, prepare, publish, shared].find((row) => row && !row.ok)?.detail ?? shared?.detail ?? "Share did not complete" })}</Task> : null}
  </Sequence><UI entry="../ui/share-pack.tsx" /></Workflow>;
});
