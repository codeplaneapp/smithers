import { Effect } from "effect";
import { z } from "zod";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { defineTool } from "./defineTool.js";
import {
  captureProcess,
  getToolRuntimeOptions,
  resolveToolPath,
  truncateToBytes,
} from "./utils.js";

const DARWIN_NETWORK_DENY_PROFILE = "(version 1) (allow default) (deny network*)";
export const BASH_TOOL_MAX_COMMAND_LENGTH = 8_192;
export const BASH_TOOL_MAX_ARGS = 128;
export const BASH_TOOL_MAX_ARG_LENGTH = 8_192;
export const BASH_TOOL_MAX_CWD_LENGTH = 1_024;
export const BASH_TOOL_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const BASH_TOOL_MAX_TIMEOUT_MS = 60 * 60 * 1000;

// Wrap a command so the OS blocks all network access, and report whether that
// isolation is actually enforced. Only macOS `sandbox-exec` gives a real kernel
// sandbox here. On every other platform (and on darwin without sandbox-exec) we
// cannot enforce isolation, so `enforced` is false and the caller must not
// assume the process is network-sandboxed: the token/URL denylist in
// assertNetworkAllowed still runs as defense-in-depth, but it is bypassable (a
// shell, an interpreter, a renamed binary), so it is NOT isolation.
export function resolveNetworkIsolatedCommand(cmd, args) {
  if (process.platform === "darwin") {
    const sandboxExec = globalThis.Bun?.which?.("sandbox-exec") ?? null;
    if (sandboxExec) {
      return {
        command: sandboxExec,
        args: ["-p", DARWIN_NETWORK_DENY_PROFILE, cmd, ...args],
        enforced: true,
      };
    }
  }
  return { command: cmd, args, enforced: false };
}

// Structured observability warning (Effect logging, not raw console) surfaced
// when a caller asked for `allowNetwork:false` but this platform cannot enforce
// network isolation, so they are not silently left unprotected.
export function warnNetworkIsolationUnenforced() {
  return Effect.runPromise(
    Effect.logWarning("smithers.tool.network_isolation_unenforced").pipe(
      Effect.annotateLogs({
        code: "TOOL_NETWORK_ISOLATION_UNENFORCED",
        platform: process.platform,
        detail:
          "allowNetwork:false was requested but OS-level network isolation is not enforced on this platform; the bash tool falls back to a bypassable command denylist.",
      }),
      Effect.withLogSpan("smithers:bash-tool"),
    ),
  ).catch(() => {});
}

let networkIsolationUnenforcedWarned = false;

function noteNetworkIsolationUnenforced() {
  if (networkIsolationUnenforcedWarned) {
    return;
  }
  networkIsolationUnenforcedWarned = true;
  void warnNetworkIsolationUnenforced();
}

function assertOptionalStringMaxLength(name, value, maxLength) {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw new SmithersError("INVALID_INPUT", `${name} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new SmithersError(
      "INVALID_INPUT",
      `${name} exceeds ${maxLength} characters.`,
      { maxLength, length: value.length },
    );
  }
}

function validateBashInvocation(cmd, args, opts, ctx) {
  if (typeof cmd !== "string" || cmd.trim().length === 0) {
    throw new SmithersError("INVALID_INPUT", "cmd must be a non-empty string.");
  }
  assertOptionalStringMaxLength("cmd", cmd, BASH_TOOL_MAX_COMMAND_LENGTH);
  if (args !== undefined && !Array.isArray(args)) {
    throw new SmithersError("INVALID_INPUT", "args must be an array.");
  }
  if ((args?.length ?? 0) > BASH_TOOL_MAX_ARGS) {
    throw new SmithersError(
      "INVALID_INPUT",
      `args exceeds ${BASH_TOOL_MAX_ARGS} entries.`,
      { maxLength: BASH_TOOL_MAX_ARGS, length: args.length },
    );
  }
  for (const [index, arg] of (args ?? []).entries()) {
    assertOptionalStringMaxLength(
      `args[${index}]`,
      arg,
      BASH_TOOL_MAX_ARG_LENGTH,
    );
  }
  const commandLine = [cmd, ...(args ?? [])].join(" ");
  assertOptionalStringMaxLength(
    "command",
    commandLine,
    BASH_TOOL_MAX_COMMAND_LENGTH,
  );
  assertOptionalStringMaxLength("opts.cwd", opts?.cwd, BASH_TOOL_MAX_CWD_LENGTH);

  if (!Number.isFinite(ctx.maxOutputBytes) || ctx.maxOutputBytes <= 0) {
    throw new SmithersError("INVALID_INPUT", "maxOutputBytes must be positive.");
  }
  if (ctx.maxOutputBytes > BASH_TOOL_MAX_OUTPUT_BYTES) {
    throw new SmithersError(
      "INVALID_INPUT",
      `maxOutputBytes exceeds ${BASH_TOOL_MAX_OUTPUT_BYTES}.`,
      {
        maxOutputBytes: ctx.maxOutputBytes,
        maxAllowed: BASH_TOOL_MAX_OUTPUT_BYTES,
      },
    );
  }
  if (!Number.isFinite(ctx.timeoutMs) || ctx.timeoutMs <= 0) {
    throw new SmithersError("INVALID_INPUT", "timeoutMs must be positive.");
  }
  if (ctx.timeoutMs > BASH_TOOL_MAX_TIMEOUT_MS) {
    throw new SmithersError(
      "INVALID_INPUT",
      `timeoutMs exceeds ${BASH_TOOL_MAX_TIMEOUT_MS}.`,
      { timeoutMs: ctx.timeoutMs, maxAllowed: BASH_TOOL_MAX_TIMEOUT_MS },
    );
  }
}

function tokenExecutableName(token) {
  const stripped = token.split(/[/\\]/).pop() ?? token;
  return stripped;
}

function assertNetworkAllowed(cmd, args, allowNetwork) {
  if (allowNetwork) {
    return;
  }
  const tokens = [cmd, ...(args ?? [])].flatMap((part) =>
    String(part).split(/\s+/).filter(Boolean),
  );
  const executables = new Set(tokens.map(tokenExecutableName));
  const networkExecutables = ["curl", "wget", "npm", "bun", "pip"];
  const hasNetworkExecutable = networkExecutables.some((name) =>
    executables.has(name),
  );
  const urlSchemes = ["http://", "https://"];
  const hasUrlToken = tokens.some((token) =>
    urlSchemes.some((scheme) => token.startsWith(scheme)),
  );
  if (hasNetworkExecutable || hasUrlToken) {
    throw new SmithersError(
      "TOOL_NETWORK_DISABLED",
      "Network access is disabled for bash tool",
    );
  }
  if (executables.has("git")) {
    const gitRemoteOps = new Set(["push", "pull", "fetch", "clone", "remote"]);
    if (tokens.some((token) => gitRemoteOps.has(token))) {
      throw new SmithersError(
        "TOOL_GIT_REMOTE_DISABLED",
        "Git remote operations are disabled for bash tool",
      );
    }
  }
}

export async function bashTool(cmd, args = [], opts = undefined) {
  const runtime = getToolRuntimeOptions();
  validateBashInvocation(cmd, args, opts, runtime);
  assertNetworkAllowed(cmd, args, runtime.allowNetwork);
  const cwd = opts?.cwd
    ? await resolveToolPath(runtime.rootDir, opts.cwd)
    : runtime.rootDir;
  let command = cmd;
  let commandArgs = args;
  if (!runtime.allowNetwork) {
    const isolation = resolveNetworkIsolatedCommand(cmd, args);
    command = isolation.command;
    commandArgs = isolation.args;
    if (!isolation.enforced) {
      noteNetworkIsolationUnenforced();
    }
  }
  const result = await captureProcess(
    command,
    commandArgs,
    {
      cwd,
      env: process.env,
      detached: true,
      maxOutputBytes: runtime.maxOutputBytes,
      timeoutMs: runtime.timeoutMs,
    },
  );
  const output = truncateToBytes(
    `${result.stdout}${result.stderr}`,
    runtime.maxOutputBytes,
  );
  if (result.exitCode !== 0) {
    throw new SmithersError(
      "TOOL_COMMAND_FAILED",
      `Command failed with exit code ${result.exitCode}`,
      { cmd, args, output },
    );
  }
  return output;
}

const bashSchema = z.object({
  cmd: z.string(),
  args: z.array(z.string()).optional(),
  opts: z.object({ cwd: z.string().optional() }).optional(),
});

/** @type {import("../tools.js").DefinedTool<typeof bashSchema, string>} */
export const bash = defineTool({
  name: "bash",
  description: "Run an executable with arguments",
  schema: bashSchema,
  sideEffect: true,
  idempotent: false,
  execute: async ({ cmd, args, opts }, _ctx) => bashTool(cmd, args, opts),
});
