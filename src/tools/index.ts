import { tool, zodSchema } from "ai";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { applyPatch } from "diff";
import { nowMs } from "../utils/time";
import { sha256Hex } from "../utils/hash";
import { errorToJson } from "../utils/errors";
import { resolveSandboxPath, assertPathWithinRoot } from "./utils";
import { getToolContext, nextToolSeq } from "./context";

async function logToolCall(
  toolName: string,
  input: unknown,
  output: unknown,
  status: "success" | "error",
  error?: unknown,
  startedAtMs?: number,
) {
  const ctx = getToolContext();
  if (!ctx) return;
  const seq = nextToolSeq(ctx);
  const started = startedAtMs ?? nowMs();
  const finished = nowMs();
  const maxLogBytes = ctx.maxOutputBytes ?? 200_000;
  const inputJson = safeJson(input, maxLogBytes);
  const outputJson = safeJson(output, maxLogBytes);
  const errorJson = error ? safeJson(errorToJson(error), maxLogBytes) : null;
  await ctx.db.insertToolCall({
    runId: ctx.runId,
    nodeId: ctx.nodeId,
    iteration: ctx.iteration,
    attempt: ctx.attempt,
    seq,
    toolName,
    inputJson,
    outputJson,
    startedAtMs: started,
    finishedAtMs: finished,
    status,
    errorJson,
  });
}

function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
}

function safeJson(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) return json;
  const preview = truncateToBytes(json, maxBytes);
  return JSON.stringify({
    truncated: true,
    bytes: Buffer.byteLength(json, "utf8"),
    preview,
  });
}

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

// Convenience map of built-in tools for agents that expect a tool registry.
export const tools = { read, write, edit, grep, bash };
