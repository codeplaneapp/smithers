import { tool, zodSchema } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { nowMs } from "../utils/time";
import { resolveSandboxPath, assertPathWithinRoot } from "./utils";
import { getToolContext } from "./context";
import { logToolCall, truncateToBytes } from "./logToolCall";

export const read: any = tool({
  description: "Read a file",
  inputSchema: zodSchema(z.object({ path: z.string() })),
  execute: async ({ path }: { path: string }) => {
    const ctx = getToolContext();
    const root = ctx?.rootDir ?? process.cwd();
    const started = nowMs();
    try {
      const resolved = resolveSandboxPath(root, path);
      await assertPathWithinRoot(root, resolved);
      const max = ctx?.maxOutputBytes ?? 200_000;
      const stats = await fs.stat(resolved);
      if (stats.size > max) {
        throw new Error(`File too large (${stats.size} bytes)`);
      }
      const content = await fs.readFile(resolved, "utf8");
      const output = truncateToBytes(content, max);
      await logToolCall(
        "read",
        { path },
        { content: output },
        "success",
        undefined,
        started,
      );
      return output;
    } catch (err) {
      await logToolCall("read", { path }, null, "error", err, started);
      throw err;
    }
  },
});
