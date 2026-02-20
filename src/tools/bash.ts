import { tool, zodSchema } from "ai";
import { z } from "zod";
import { spawn } from "node:child_process";
import { nowMs } from "../utils/time";
import { resolveSandboxPath, assertPathWithinRoot } from "./utils";
import { getToolContext } from "./context";
import { logToolCall, truncateToBytes } from "./logToolCall";

export const bash = tool({
  description: "Execute a shell command",
  inputSchema: zodSchema(
    z.object({
      cmd: z.string(),
      args: z.array(z.string()).optional(),
      opts: z.object({ cwd: z.string().optional() }).optional(),
    }),
  ),
  execute: async ({
    cmd,
    args,
    opts,
  }: {
    cmd: string;
    args?: string[];
    opts?: { cwd?: string };
  }) => {
    const ctx = getToolContext();
    const root = ctx?.rootDir ?? process.cwd();
    const allowNetwork = ctx?.allowNetwork ?? false;
    const started = nowMs();
    let cwd = root;
    try {
      cwd = opts?.cwd ? resolveSandboxPath(root, opts.cwd) : root;
      await assertPathWithinRoot(root, cwd);
      if (!allowNetwork) {
        const hay = [cmd, ...(args ?? [])].join(" ");
        // Block obvious network commands
        const networkCommands = [
          "curl",
          "wget",
          "http://",
          "https://",
          "npm",
          "bun",
          "pip",
        ];
        if (networkCommands.some((f) => hay.includes(f))) {
          throw new Error("Network access is disabled for bash tool");
        }
        // Block git remote operations but allow local ones
        if (hay.includes("git")) {
          const gitRemoteOps = ["push", "pull", "fetch", "clone", "remote"];
          if (gitRemoteOps.some((op) => hay.includes(op))) {
            throw new Error("Git remote operations are disabled for bash tool");
          }
        }
      }
    } catch (err) {
      await logToolCall("bash", { cmd, args }, null, "error", err, started);
      throw err;
    }

    const timeoutMs = ctx?.timeoutMs ?? 60_000;
    const maxOutputBytes = ctx?.maxOutputBytes ?? 200_000;

    return await new Promise<string>((resolve, reject) => {
      const child = spawn(cmd, args ?? [], {
        cwd,
        env: process.env,
        detached: true,
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > maxOutputBytes) {
          stdout = stdout.slice(0, maxOutputBytes);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > maxOutputBytes) {
          stderr = stderr.slice(0, maxOutputBytes);
        }
      });
      child.on("error", async (err) => {
        clearTimeout(timer);
        await logToolCall("bash", { cmd, args }, null, "error", err, started);
        reject(err);
      });
      child.on("close", async (code, signal) => {
        clearTimeout(timer);
        const output = truncateToBytes(
          `${stdout.toString("utf8")}${stderr.toString("utf8")}`,
          maxOutputBytes,
        );
        if (timedOut) {
          const err = new Error(`Command timed out after ${timeoutMs}ms`);
          await logToolCall(
            "bash",
            { cmd, args },
            { output },
            "error",
            err,
            started,
          );
          reject(err);
          return;
        }
        if (code !== 0) {
          const err = new Error(
            signal
              ? `Command failed with signal ${signal}`
              : `Command failed with exit code ${code}`,
          );
          await logToolCall(
            "bash",
            { cmd, args },
            { output },
            "error",
            err,
            started,
          );
          reject(err);
          return;
        }
        await logToolCall(
          "bash",
          { cmd, args },
          { output },
          "success",
          undefined,
          started,
        );
        resolve(output);
      });
    });
  },
});
