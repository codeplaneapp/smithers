import { tool, zodSchema } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { applyPatch } from "diff";
import { nowMs } from "../utils/time";
import { sha256Hex } from "../utils/hash";
import { resolveSandboxPath, assertPathWithinRoot } from "./utils";
import { getToolContext } from "./context";
import { logToolCall } from "./logToolCall";

export const edit = tool({
  description: "Apply a unified diff patch to a file",
  inputSchema: zodSchema(z.object({ path: z.string(), patch: z.string() })),
  execute: async ({ path, patch }: { path: string; patch: string }) => {
    const ctx = getToolContext();
    const root = ctx?.rootDir ?? process.cwd();
    const started = nowMs();
    const max = ctx?.maxOutputBytes ?? 200_000;
    const patchBytes = Buffer.byteLength(patch, "utf8");
    const logInput = { path, patchBytes, patchHash: sha256Hex(patch) };
    try {
      const resolved = resolveSandboxPath(root, path);
      await assertPathWithinRoot(root, resolved);
      if (patchBytes > max) {
        throw new Error(`Patch too large (${patchBytes} bytes)`);
      }
      const stats = await fs.stat(resolved);
      if (stats.size > max) {
        throw new Error(`File too large (${stats.size} bytes)`);
      }
      const current = await fs.readFile(resolved, "utf8");
      const updated = applyPatch(current, patch);
      if (updated === false) {
        throw new Error("Failed to apply patch");
      }
      await fs.writeFile(resolved, updated, "utf8");
      await logToolCall(
        "edit",
        logInput,
        { ok: true },
        "success",
        undefined,
        started,
      );
      return "ok";
    } catch (err) {
      await logToolCall("edit", logInput, null, "error", err, started);
      throw err;
    }
  },
});
