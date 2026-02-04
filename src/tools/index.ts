import { tool } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { applyPatch } from "diff";
import { nowMs } from "../utils/time";
import { resolveSandboxPath } from "./utils";
import { getToolContext, nextToolSeq } from "./context";

async function logToolCall(toolName: string, input: unknown, output: unknown, status: "success" | "error", error?: unknown, startedAtMs?: number) {
  const ctx = getToolContext();
  if (!ctx) return;
  const seq = nextToolSeq(ctx);
  const started = startedAtMs ?? nowMs();
  const finished = nowMs();
  await ctx.db.insertToolCall({
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    iteration: ctx.iteration,
    attempt: ctx.attempt,
    seq,
    toolName,
    inputJson: JSON.stringify(input ?? null),
    outputJson: JSON.stringify(output ?? null),
    startedAtMs: started,
    finishedAtMs: finished,
    status,
    errorJson: error ? JSON.stringify(error) : null,
  });
}

export const read = tool({
  description: "Read a file",
  parameters: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    const ctx = getToolContext();
    const root = ctx?.rootDir ?? process.cwd();
    const resolved = resolveSandboxPath(root, path);
    const started = nowMs();
    try {
      const content = await fs.readFile(resolved, "utf8");
      await logToolCall("read", { path }, { content }, "success", undefined, started);
      return content;
    } catch (err) {
      await logToolCall("read", { path }, null, "error", err, started);
      throw err;
    }
  },
});

export const write = tool({
  description: "Write a file",
  parameters: z.object({ path: z.string(), content: z.string() }),
  execute: async ({ path, content }) => {
    const ctx = getToolContext();
    const root = ctx?.rootDir ?? process.cwd();
    const resolved = resolveSandboxPath(root, path);
    const started = nowMs();
    try {
      await fs.mkdir(dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf8");
      await logToolCall("write", { path }, { ok: true }, "success", undefined, started);
      return "ok";
    } catch (err) {
      await logToolCall("write", { path }, null, "error", err, started);
      throw err;
    }
  },
});

export const edit = tool({
  description: "Apply a unified diff patch to a file",
  parameters: z.object({ path: z.string(), patch: z.string() }),
  execute: async ({ path, patch }) => {
    const ctx = getToolContext();
    const root = ctx?.rootDir ?? process.cwd();
    const resolved = resolveSandboxPath(root, path);
    const started = nowMs();
    try {
      const current = await fs.readFile(resolved, "utf8");
      const updated = applyPatch(current, patch);
      if (updated === false) {
        throw new Error("Failed to apply patch");
      }
      await fs.writeFile(resolved, updated, "utf8");
      await logToolCall("edit", { path }, { ok: true }, "success", undefined, started);
      return "ok";
    } catch (err) {
      await logToolCall("edit", { path }, null, "error", err, started);
      throw err;
    }
  },
});

export const grep = tool({
  description: "Search for a pattern in files",
  parameters: z.object({ pattern: z.string(), path: z.string().optional() }),
  execute: async ({ pattern, path }) => {
    const ctx = getToolContext();
    const root = ctx?.rootDir ?? process.cwd();
    const resolvedRoot = resolveSandboxPath(root, path ?? ".");
    const started = nowMs();
    try {
      const results: string[] = [];
      const rg = spawn("rg", ["-n", pattern, resolvedRoot]);
      rg.stdout.on("data", (chunk) => results.push(chunk.toString("utf8")));
      const exitCode: number = await new Promise((resolve) => rg.on("close", resolve));
      const output = results.join("");
      if (exitCode !== 0 && output.length === 0) {
        // no matches
      }
      await logToolCall("grep", { pattern, path }, { output }, "success", undefined, started);
      return output;
    } catch (err) {
      await logToolCall("grep", { pattern, path }, null, "error", err, started);
      throw err;
    }
  },
});

export const bash = tool({
  description: "Execute a shell command",
  parameters: z.object({ cmd: z.string(), args: z.array(z.string()).optional(), opts: z.object({ cwd: z.string().optional() }).optional() }),
  execute: async ({ cmd, args, opts }) => {
    const ctx = getToolContext();
    const root = ctx?.rootDir ?? process.cwd();
    const cwd = opts?.cwd ? resolveSandboxPath(root, opts.cwd) : root;
    const allowNetwork = ctx?.allowNetwork ?? false;
    const started = nowMs();

    if (!allowNetwork) {
      const forbidden = ["curl", "wget", "http://", "https://", "git", "npm", "bun", "pip"]; // coarse guard
      const hay = [cmd, ...(args ?? [])].join(" ");
      if (forbidden.some((f) => hay.includes(f))) {
        const err = new Error("Network access is disabled for bash tool");
        await logToolCall("bash", { cmd, args }, null, "error", err, started);
        throw err;
      }
    }

    const timeoutMs = ctx?.timeoutMs ?? 60_000;
    const maxOutputBytes = ctx?.maxOutputBytes ?? 200_000;

    return await new Promise<string>((resolve, reject) => {
      const child = spawn(cmd, args ?? [], { cwd, env: process.env });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
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
      child.on("close", async (code) => {
        clearTimeout(timer);
        const output = `${stdout.toString("utf8")}${stderr.toString("utf8")}`;
        if (code !== 0) {
          const err = new Error(`Command failed with exit code ${code}`);
          await logToolCall("bash", { cmd, args }, { output }, "error", err, started);
          reject(err);
          return;
        }
        await logToolCall("bash", { cmd, args }, { output }, "success", undefined, started);
        resolve(output);
      });
    });
  },
});

export const tools = { read, write, edit, grep, bash };
