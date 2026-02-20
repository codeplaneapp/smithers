import { tool, zodSchema } from "ai";
import { z } from "zod";
import { spawn } from "node:child_process";
import { nowMs } from "../utils/time";
import { resolveSandboxPath, assertPathWithinRoot } from "./utils";
import { getToolContext } from "./context";
import { logToolCall, truncateToBytes } from "./logToolCall";

export const grep = tool({
  description: "Search for a pattern in files",
  inputSchema: zodSchema(
    z.object({ pattern: z.string(), path: z.string().optional() }),
  ),
  execute: async ({ pattern, path }: { pattern: string; path?: string }) => {
    const ctx = getToolContext();
    const root = ctx?.rootDir ?? process.cwd();
    const started = nowMs();
    let logOutput: { output: string; stderr: string } | null = null;
    try {
      const resolvedRoot = resolveSandboxPath(root, path ?? ".");
      await assertPathWithinRoot(root, resolvedRoot);
      const max = ctx?.maxOutputBytes ?? 200_000;
      const timeoutMs = ctx?.timeoutMs ?? 60_000;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let timedOut = false;
      const rg = spawn("rg", ["-n", pattern, resolvedRoot], { detached: true });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (rg.pid) {
            process.kill(-rg.pid, "SIGKILL");
          }
        } catch {
          try {
            rg.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, timeoutMs);
      rg.stdout.on("data", (chunk) => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > max) {
          stdout = stdout.slice(0, max);
        }
      });
      rg.stderr.on("data", (chunk) => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > max) {
          stderr = stderr.slice(0, max);
        }
      });
      const exitCode: number = await new Promise((resolve, reject) => {
        rg.on("error", reject);
        rg.on("close", resolve);
      });
      clearTimeout(timer);
      const stdoutText = truncateToBytes(stdout.toString("utf8"), max);
      const stderrText = truncateToBytes(stderr.toString("utf8"), max);
      logOutput = { output: stdoutText, stderr: stderrText };
      if (timedOut) {
        throw new Error(`Command timed out after ${timeoutMs}ms`);
      }
      if (exitCode === 2) {
        throw new Error(stderrText || "rg failed");
      }
      await logToolCall(
        "grep",
        { pattern, path },
        logOutput,
        "success",
        undefined,
        started,
      );
      return stdoutText;
    } catch (err) {
      await logToolCall(
        "grep",
        { pattern, path },
        logOutput,
        "error",
        err,
        started,
      );
      throw err;
    }
  },
});
