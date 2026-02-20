import { tool, zodSchema } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { nowMs } from "../utils/time";
import { sha256Hex } from "../utils/hash";
import { resolveSandboxPath, assertPathWithinRoot } from "./utils";
import { getToolContext } from "./context";
import { logToolCall } from "./logToolCall";

export const write = tool({
  description: "Write a file",
  inputSchema: zodSchema(z.object({ path: z.string(), content: z.string() })),
  execute: async ({ path, content }: { path: string; content: string }) => {
    const ctx = getToolContext();
    const root = ctx?.rootDir ?? process.cwd();
    const started = nowMs();
    const max = ctx?.maxOutputBytes ?? 200_000;
    const contentBytes = Buffer.byteLength(content, "utf8");
    const logInput = { path, contentBytes, contentHash: sha256Hex(content) };
    try {
      const resolved = resolveSandboxPath(root, path);
      await assertPathWithinRoot(root, resolved);
      if (contentBytes > max) {
        throw new Error(`Content too large (${contentBytes} bytes)`);
      }
      await fs.mkdir(dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf8");
      await logToolCall(
        "write",
        logInput,
        { ok: true },
        "success",
        undefined,
        started,
      );
      return "ok";
    } catch (err) {
      await logToolCall("write", logInput, null, "error", err, started);
      throw err;
    }
  },
});
