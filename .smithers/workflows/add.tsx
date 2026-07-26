// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Add pack (system)
// smithers-description: Durable installation of a Smithers workflow pack from a GitHub, npm, or file spec.
// smithers-tags: system, packs
// smithers-system: true
// smithers-disable-model-invocation: true
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  spec: z
    .string()
    .trim()
    .min(1, "Pack spec is required")
    .describe("Pack spec to install (for example user/repo or npm:pack)."),
  global: z.boolean().default(false),
  yes: z.boolean().default(true),
});
const outputSchema = z.object({ name: z.string(), path: z.string(), scope: z.string(), report: z.string() });
const { Workflow, Task, smithers, outputs } = createSmithers({ input: inputSchema, result: outputSchema });
const cliModule = (name: string) =>
  process.env.SMITHERS_CLI_SRC_DIR
    ? `${process.env.SMITHERS_CLI_SRC_DIR}/${name}.js`
    : `@smithers-orchestrator/cli/${name}`;

export default smithers((ctx) => (
  <Workflow name="add">
    <Task id="install-pack" output={outputs.result} retries={0}>
      {async () => {
        const { addPack } = await import(cliModule("packs"));
        const result = await addPack(ctx.input.spec, {
          from: process.cwd(),
          global: ctx.input.global,
          yes: ctx.input.yes,
        });
        return { name: result.name, path: result.path, scope: result.scope, report: result.report };
      }}
    </Task>
  </Workflow>
));
