import { Effect } from "effect";
import { z } from "zod";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { defineTool } from "./defineTool.js";
import { captureProcess, getToolRuntimeOptions, resolveToolPath, truncateToBytes } from "./utils.js";

// Deny egress, keep the machine: loopback TCP and unix-domain sockets are the
// substrate of local test compositions (dev servers, local postgres, socket
// simulators) and move no bytes off the host, so `allowNetwork: false` leaves
// them reachable. Only remote endpoints are denied. Rules are direction-scoped
// because a broad `(allow network* (local ip "localhost:*"))` also matches the
// local endpoint of an OUTBOUND socket and silently re-opens egress (verified
// empirically with sandbox-exec + curl).
const DARWIN_NETWORK_DENY_PROFILE = [
  "(version 1) (allow default) (deny network*)",
  '(allow network-outbound (remote ip "localhost:*"))',
  "(allow network-outbound (remote unix-socket))",
  '(allow network-inbound (local ip "localhost:*"))',
  '(allow network-bind (local ip "localhost:*"))',
  "(allow network-bind (local unix-socket))",
].join(" ");
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
    throw new SmithersError("INVALID_INPUT", `${name} exceeds ${maxLength} characters.`, {
      maxLength,
      length: value.length,
    });
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
    throw new SmithersError("INVALID_INPUT", `args exceeds ${BASH_TOOL_MAX_ARGS} entries.`, {
      maxLength: BASH_TOOL_MAX_ARGS,
      length: args.length,
    });
  }
  for (const [index, arg] of (args ?? []).entries()) {
    assertOptionalStringMaxLength(`args[${index}]`, arg, BASH_TOOL_MAX_ARG_LENGTH);
  }
  const commandLine = [cmd, ...(args ?? [])].join(" ");
  assertOptionalStringMaxLength("command", commandLine, BASH_TOOL_MAX_COMMAND_LENGTH);
  assertOptionalStringMaxLength("opts.cwd", opts?.cwd, BASH_TOOL_MAX_CWD_LENGTH);

  if (!Number.isFinite(ctx.maxOutputBytes) || ctx.maxOutputBytes <= 0) {
    throw new SmithersError("INVALID_INPUT", "maxOutputBytes must be positive.");
  }
  if (ctx.maxOutputBytes > BASH_TOOL_MAX_OUTPUT_BYTES) {
    throw new SmithersError("INVALID_INPUT", `maxOutputBytes exceeds ${BASH_TOOL_MAX_OUTPUT_BYTES}.`, {
      maxOutputBytes: ctx.maxOutputBytes,
      maxAllowed: BASH_TOOL_MAX_OUTPUT_BYTES,
    });
  }
  if (!Number.isFinite(ctx.timeoutMs) || ctx.timeoutMs <= 0) {
    throw new SmithersError("INVALID_INPUT", "timeoutMs must be positive.");
  }
  if (ctx.timeoutMs > BASH_TOOL_MAX_TIMEOUT_MS) {
    throw new SmithersError("INVALID_INPUT", `timeoutMs exceeds ${BASH_TOOL_MAX_TIMEOUT_MS}.`, {
      timeoutMs: ctx.timeoutMs,
      maxAllowed: BASH_TOOL_MAX_TIMEOUT_MS,
    });
  }
}

// curl/wget are allowed when every URL they carry is loopback: fetching a
// local dev server is exactly what a local test harness does. Package managers
// stay blocked outright because they reach registries regardless of argv.
const FETCH_EXECUTABLES = new Set(["curl", "wget"]);
// Value-taking flags whose following token is local request/output metadata,
// not another fetch target. Endpoint-bearing flags such as curl --proxy are
// deliberately absent: a bare remote hostname there must fail closed too.
const FETCH_LOCAL_VALUE_FLAGS = {
  curl: new Set([
    "-A",
    "--user-agent",
    "-b",
    "--cookie",
    "-c",
    "--cookie-jar",
    "--cacert",
    "--cert",
    "--connect-timeout",
    "-d",
    "--data",
    "--data-ascii",
    "--data-binary",
    "--data-raw",
    "--data-urlencode",
    "-H",
    "--header",
    "--key",
    "--max-time",
    "-o",
    "--output",
    "--retry",
    "-u",
    "--user",
    "-w",
    "--write-out",
    "-X",
    "--request",
  ]),
  wget: new Set([
    "--body-data",
    "--ca-certificate",
    "--certificate",
    "--header",
    "--method",
    "-O",
    "--output-document",
    "-P",
    "--directory-prefix",
    "--password",
    "--post-data",
    "--timeout",
    "--tries",
    "--user",
    "--user-agent",
  ]),
};
const PACKAGE_EXECUTABLES = new Set(["npm", "bun", "pip"]);
const GIT_REMOTE_OPS = new Set(["push", "pull", "fetch", "clone", "remote"]);
const URL_SCHEMES = ["http://", "https://"];
const NETWORK_DISABLED_HINT =
  "Loopback stays reachable (localhost, 127.0.0.1, *.localhost, unix sockets); for real egress set allowNetwork: true (--allow-network on up/eval/oneshot).";
// git's global options come before the subcommand, and these consume the next
// argument, so `git -C /repo fetch` still resolves to the `fetch` subcommand.
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--exec-path", "--git-dir", "--namespace", "--work-tree"]);
// A shell runs its `-c` payload as a script, so the payload's command positions
// are executables that actually run and are checked too.
const INTERPRETER_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh"]);
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function tokenExecutableName(token) {
  const stripped = token.split(/[/\\]/).pop() ?? token;
  return stripped;
}

// `cmd` is spawned directly and never shell-parsed, but callers occasionally
// pass a whole command line, so resolve the executable from the trimmed string
// and from its leading token: `bashTool("curl https://x")` is still caught here
// instead of failing later at spawn.
function commandExecutables(cmd) {
  const trimmed = String(cmd).trim();
  const [leading = trimmed] = trimmed.split(/\s+/);
  return [...new Set([trimmed, leading].map(tokenExecutableName))];
}

// A genuine URL argument is one whose value *is* a URL: the whole argument, or
// the value half of `--flag=<url>`. Prose that merely mentions a URL (a commit
// message, an echoed doc line) performs no network I/O.
function urlValues(arg) {
  const equals = arg.indexOf("=");
  const values = arg.startsWith("-") && equals > 0 ? [arg, arg.slice(equals + 1)] : [arg];
  return values.filter((value) => URL_SCHEMES.some((scheme) => value.startsWith(scheme)));
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

function isLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return isLoopbackHost(url.hostname);
}

function isRemoteUrlArgument(arg) {
  return urlValues(arg).some((value) => !isLoopbackUrl(value));
}

function fetchTargets(executable, argv) {
  const valueFlags = FETCH_LOCAL_VALUE_FLAGS[executable] ?? new Set();
  const targets = [];
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!positionalOnly && arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && executable === "curl" && arg.startsWith("--url=")) {
      targets.push(arg.slice("--url=".length));
      continue;
    }
    if (!positionalOnly && arg === "--url" && executable === "curl") {
      if (typeof argv[index + 1] === "string") targets.push(argv[++index]);
      continue;
    }
    if (!positionalOnly && valueFlags.has(arg)) {
      index += 1;
      continue;
    }
    if (!positionalOnly && arg.startsWith("-")) continue;
    targets.push(arg);
  }
  return targets;
}

function gitSubcommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (GIT_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return null;
}

// Command positions inside a shell `-c` payload: the start of the script and
// whatever follows `;`, a newline, a pipe, `&&`, or a subshell. Matching only
// those keeps `sh -c "curl https://x"` blocked while leaving quoted prose such
// as `sh -c 'git commit -m "fetch upstream"'` alone.
function interpreterCommands(executables, argv) {
  if (!executables.some((name) => INTERPRETER_EXECUTABLES.has(name))) {
    return [];
  }
  const commands = [];
  for (const [index, arg] of argv.entries()) {
    if (index === 0 || !/^-[a-z]*c$/.test(argv[index - 1])) {
      continue;
    }
    for (const segment of arg.split(/[\n;&|`()]+/)) {
      const tokens = segment.trim().split(/\s+/).filter(Boolean);
      while (tokens.length > 0 && SHELL_ASSIGNMENT.test(tokens[0])) {
        tokens.shift();
      }
      if (tokens.length > 0) {
        commands.push(tokens);
      }
    }
  }
  return commands;
}

function throwNetworkDisabled(executable) {
  throw new SmithersError(
    "TOOL_NETWORK_DISABLED",
    `Network access is disabled for the bash tool. ${NETWORK_DISABLED_HINT}`,
    executable ? { executable } : undefined,
  );
}

function assertLocalExecutable(executable, argv) {
  if (FETCH_EXECUTABLES.has(executable)) {
    // curl/wget must name a loopback URL to run; a bare hostname or a remote
    // URL is (potential) egress. Every positional fetch target has to be a
    // recognized loopback URL, even when another target is already loopback.
    const urls = argv.flatMap(urlValues);
    const targets = fetchTargets(executable, argv);
    if (targets.length === 0 || !targets.every(isLoopbackUrl) || !urls.every(isLoopbackUrl)) {
      throwNetworkDisabled(executable);
    }
    return;
  }
  if (PACKAGE_EXECUTABLES.has(executable)) {
    throwNetworkDisabled(executable);
  }
  if (executable === "git" && GIT_REMOTE_OPS.has(gitSubcommand(argv))) {
    throw new SmithersError(
      "TOOL_GIT_REMOTE_DISABLED",
      `Git remote operations are disabled for the bash tool. ${NETWORK_DISABLED_HINT}`,
    );
  }
}

function assertNetworkAllowed(cmd, args, allowNetwork) {
  if (allowNetwork) {
    return;
  }
  // Match the executables that actually run, never argument *text*: a commit
  // message, an echoed doc line, or a grep pattern mentioning `npm`, `fetch`,
  // or a URL opens no socket. This denylist is bypassable defense-in-depth
  // (see resolveNetworkIsolatedCommand), so scanning every whitespace-delimited
  // token bought no isolation and only rejected benign local commands.
  // Loopback URLs are exempt everywhere: they are what a local test harness is
  // made of, and the darwin kernel profile permits them too.
  const executables = commandExecutables(cmd);
  const argv = (args ?? []).map((arg) => String(arg));
  if (argv.some(isRemoteUrlArgument)) {
    throwNetworkDisabled();
  }
  for (const executable of executables) {
    assertLocalExecutable(executable, argv);
  }
  for (const tokens of interpreterCommands(executables, argv)) {
    assertLocalExecutable(tokenExecutableName(tokens[0]), tokens.slice(1));
  }
}

export async function bashTool(cmd, args = [], opts = undefined) {
  const runtime = getToolRuntimeOptions();
  validateBashInvocation(cmd, args, opts, runtime);
  assertNetworkAllowed(cmd, args, runtime.allowNetwork);
  const cwd = opts?.cwd ? await resolveToolPath(runtime.rootDir, opts.cwd) : runtime.rootDir;
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
  const result = await captureProcess(command, commandArgs, {
    cwd,
    env: process.env,
    detached: true,
    maxOutputBytes: runtime.maxOutputBytes,
    timeoutMs: runtime.timeoutMs,
  });
  const output = truncateToBytes(`${result.stdout}${result.stderr}`, runtime.maxOutputBytes);
  if (result.exitCode !== 0) {
    throw new SmithersError("TOOL_COMMAND_FAILED", `Command failed with exit code ${result.exitCode}`, {
      cmd,
      args,
      output,
    });
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
