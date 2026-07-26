import { readFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "./defineTool.js";
import { assertReadableFileWithinLimit, getToolRuntimeOptions, resolveToolPath, truncateToBytes } from "./utils.js";

export async function readFileTool(path) {
  const { rootDir, maxOutputBytes } = getToolRuntimeOptions();
  const resolved = await resolveToolPath(rootDir, path);
  await assertReadableFileWithinLimit(resolved, maxOutputBytes);
  const content = await readFile(resolved, "utf8");
  return truncateToBytes(content, maxOutputBytes);
}

const readSchema = z.object({ path: z.string() });

/** @type {import("../tools.js").DefinedTool<typeof readSchema, string>} */
export const read = defineTool({
  name: "read",
  description: "Read a file",
  schema: readSchema,
  execute: async ({ path }) => readFileTool(path),
});
