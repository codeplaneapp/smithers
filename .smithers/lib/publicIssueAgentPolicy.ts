import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * Fail-closed CLI policy for agents that consume untrusted public issue text.
 *
 * Keep provider authentication on the CLI side. The agent subprocess receives
 * only this small operational environment, while Codex/Claude-specific auth
 * supplied by their adapters is kept out of model-spawned shells by the
 * provider policies below.
 */

export type PublicIssueAgentRole = "read" | "write";

export type PublicIssueAgentPolicyOptions = {
  /** A disposable HOME used by model-spawned commands. */
  safeHome?: string;
  /** The operator HOME to deny even when `safeHome` is different. */
  hostHome?: string;
  /** Exact runtime/toolchain directories that remain readable. */
  toolchainReadPaths?: readonly string[];
};

export const PUBLIC_ISSUE_SAFE_ENV_NAMES = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "GIT_TERMINAL_PROMPT",
  "SMITHERS_BIN",
  "COREPACK_HOME",
] as const;

export const PUBLIC_ISSUE_CODEX_EXTRA_ARGS = [
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
] as const;

const CLAUDE_READ_TOOLS = ["Read", "Glob", "Grep"] as const;
const CLAUDE_WRITE_TOOLS = [
  ...CLAUDE_READ_TOOLS,
  "Edit",
  "Write",
] as const;

const CLAUDE_READ_ALLOW_RULES = ["Read(./**)", "Glob", "Grep"] as const;
const CLAUDE_WRITE_ALLOW_RULES = [
  ...CLAUDE_READ_ALLOW_RULES,
  "Edit(./**)",
  "Write(./**)",
] as const;

const CLAUDE_REMOTE_TOOL_DENIES = [
  "WebFetch",
  "WebSearch",
  "mcp__*",
  "Agent",
  "Skill",
  "Artifact",
  "CronCreate",
  "CronDelete",
  "Monitor",
  "PushNotification",
  "RemoteTrigger",
  "SendUserFile",
  "ShareOnboardingGuide",
] as const;

const CLAUDE_READ_ROLE_DENIES = [
  "Bash",
  "PowerShell",
  "Edit",
  "Write",
  "NotebookEdit",
] as const;

const CLAUDE_DANGEROUS_BASH_DENIES = [
  "Bash(gh *)",
  "Bash(git push*)",
  "Bash(jj git push*)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(ssh *)",
  "Bash(security *)",
  "Bash(pkill *)",
  "Bash(kill *)",
] as const;

const CLAUDE_WORKSPACE_SECRET_DENIES = [
  "Read(./.git)",
  "Read(./.git/**)",
  "Read(./.jj)",
  "Read(./.jj/**)",
  "Read(./.codex)",
  "Read(./.codex/**)",
  "Read(./.claude)",
  "Read(./.claude/**)",
  "Read(./.env)",
  "Read(./.env.*)",
  "Read(./**/.env)",
  "Read(./**/.env.*)",
  "Read(./.smithers/pg/**)",
  "Read(./.smithers/migrated.json)",
  "Edit(./.git)",
  "Edit(./.git/**)",
  "Edit(./.jj)",
  "Edit(./.jj/**)",
  "Edit(./.codex)",
  "Edit(./.codex/**)",
  "Edit(./.claude)",
  "Edit(./.claude/**)",
  "Read(./.codex/**)",
  "Read(./.claude/**)",
  "Edit(./.env)",
  "Edit(./.env.*)",
  "Edit(./**/.env)",
  "Edit(./**/.env.*)",
  "Edit(./.smithers/pg/**)",
  "Edit(./.smithers/migrated.json)",
  "Write(./.git)",
  "Write(./.git/**)",
  "Write(./.jj)",
  "Write(./.jj/**)",
  "Write(./.codex)",
  "Write(./.codex/**)",
  "Write(./.claude)",
  "Write(./.claude/**)",
  "Write(./.env)",
  "Write(./.env.*)",
  "Write(./**/.env)",
  "Write(./**/.env.*)",
  "Write(./.smithers/pg/**)",
  "Write(./.smithers/migrated.json)",
] as const;

export const PUBLIC_ISSUE_HOME_CREDENTIAL_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.config",
  "~/.kube",
  "~/.docker",
  "~/.claude",
  "~/.codex",
  "~/.npmrc",
  "~/.netrc",
  "~/.git-credentials",
  "~/.local/share",
] as const;

const CLAUDE_HOME_CREDENTIAL_READ_DENIES = [
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.azure/**)",
  "Read(~/.config/**)",
  "Read(~/.kube/**)",
  "Read(~/.docker/**)",
  "Read(~/.claude/**)",
  "Read(~/.codex/**)",
  "Read(~/.npmrc)",
  "Read(~/.netrc)",
  "Read(~/.git-credentials)",
  "Read(~/.local/share/**)",
] as const;

const CLAUDE_SANDBOX_SECRET_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
] as const;

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export const PUBLIC_ISSUE_TOOLCHAIN_BINARIES = [
  "bash",
  "git",
  "jj",
  "rg",
  "node",
  "bun",
  "pnpm",
] as const;

export type PublicIssueCodexPolicy = {
  inheritEnv: false;
  env: Record<string, string>;
  yolo: false;
  config: string[];
  extraArgs: string[];
};

export type PublicIssueClaudePolicy = {
  inheritEnv: false;
  env: Record<string, string>;
  yolo: false;
  permissionMode: "dontAsk";
  allowedTools: string[];
  disallowedTools: string[];
  tools: string[];
  noChrome: true;
  noSessionPersistence: true;
  disableSlashCommands: true;
  strictMcpConfig: true;
  mcpConfig: string[];
  settings: string;
  settingSources: "";
  extraArgs: string[];
};

/** Copy only non-secret process primitives; all other ambient names disappear. */
export function buildPublicIssueSafeEnv(
  source: EnvironmentSource = process.env,
  options: Pick<PublicIssueAgentPolicyOptions, "safeHome"> = {},
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of PUBLIC_ISSUE_SAFE_ENV_NAMES) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) safe[name] = value;
  }
  if (options.safeHome) {
    safe.HOME = options.safeHome;
    safe.USERPROFILE = options.safeHome;
  }
  safe.GIT_TERMINAL_PROMPT = "0";
  return safe;
}

function normalizedReadPaths(paths: readonly string[] | undefined): string[] {
  return [...new Set((paths ?? []).map((path) => path.trim()).filter(Boolean))].sort();
}

function existingCorepackHome(
  source: EnvironmentSource,
  options: PublicIssueAgentPolicyOptions,
): string | undefined {
  const candidates = [
    source.COREPACK_HOME?.trim(),
    options.hostHome ? join(options.hostHome, ".cache", "node", "corepack") : undefined,
  ];
  return candidates.find((path): path is string => Boolean(path && existsSync(path)));
}

function readablePackageRoot(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const commandLineTools = normalized.match(/^(.*\/CommandLineTools)(?:\/|$)/);
  if (commandLineTools?.[1]) return commandLineTools[1];
  const nvm = normalized.match(/^(.*\/\.nvm\/versions\/node\/[^/]+)/);
  if (nvm?.[1]) return nvm[1];
  const bun = normalized.match(/^(.*\/\.bun\/bin)(?:\/|$)/);
  if (bun?.[1]) return bun[1];
  const homebrewOpt = normalized.match(/^(.*\/opt\/[^/]+)/);
  if (homebrewOpt?.[1]) return homebrewOpt[1];
  const cellar = normalized.match(/^(.*\/Cellar\/[^/]+\/[^/]+)/);
  if (cellar?.[1]) return cellar[1];
  return dirname(path);
}

function resolveDarwinDeveloperTool(binary: string, executable: string): string | undefined {
  if (
    process.platform !== "darwin"
    || !executable.startsWith("/usr/bin/")
    || !existsSync("/usr/bin/xcrun")
  ) return undefined;

  try {
    const resolved = execFileSync("/usr/bin/xcrun", ["--find", binary], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return resolved && resolved !== executable && existsSync(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve exact non-system Mach-O library roots needed by an installed tool. */
function resolveDarwinLibraryReadPaths(executable: string): string[] {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/otool")) return [];

  const roots = new Set<string>();
  const inspected = new Set<string>();
  const pending = [executable];

  // Tool binaries have a small dependency graph; cap traversal so malformed
  // binaries cannot turn policy construction into unbounded host inspection.
  while (pending.length > 0 && inspected.size < 128) {
    const current = pending.shift()!;
    if (inspected.has(current)) continue;
    inspected.add(current);

    let output: string;
    try {
      output = execFileSync("/usr/bin/otool", ["-L", current], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      });
    } catch {
      // Scripts and non-Mach-O binaries do not have dylib load commands.
      continue;
    }

    for (const line of output.split("\n").slice(1)) {
      const dependency = line.trim().match(/^(\/.*?) \(compatibility version /)?.[1];
      if (!dependency || !existsSync(dependency)) continue;
      if (dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/Library/")) {
        continue;
      }

      roots.add(readablePackageRoot(dependency));
      try {
        const resolved = realpathSync(dependency);
        roots.add(readablePackageRoot(resolved));
        pending.push(resolved);
      } catch {
        pending.push(dependency);
      }
    }
  }

  return [...roots];
}

/** Resolve only the installed runtime roots needed by repo checks. */
export function resolvePublicIssueToolchainReadPaths(
  source: EnvironmentSource = process.env,
  binaries: readonly string[] = PUBLIC_ISSUE_TOOLCHAIN_BINARIES,
): string[] {
  const pathEntries = (source.PATH || source.Path || "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const extensions = process.platform === "win32"
    ? (source.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  const roots = new Set<string>();

  for (const binary of binaries) {
    let resolved: string | undefined;
    for (const pathEntry of pathEntries) {
      for (const extension of extensions) {
        const candidate = join(pathEntry, `${binary}${extension}`);
        if (!existsSync(candidate)) continue;
        roots.add(dirname(candidate));
        try {
          resolved = realpathSync(candidate);
        } catch {
          resolved = candidate;
        }
        break;
      }
      if (resolved) break;
    }
    if (resolved) {
      roots.add(readablePackageRoot(resolved));
      for (const path of resolveDarwinLibraryReadPaths(resolved)) roots.add(path);
      const developerTool = resolveDarwinDeveloperTool(binary, resolved);
      if (developerTool) {
        roots.add(readablePackageRoot(developerTool));
        for (const path of resolveDarwinLibraryReadPaths(developerTool)) roots.add(path);
      }
    }
  }

  if (process.platform === "darwin" && existsSync("/System/Library/OpenSSL")) {
    roots.add("/System/Library/OpenSSL");
  }
  return [...roots].sort();
}

function codexFilesystemConfig(
  workspaceAccess: "read" | "write",
  toolchainReadPaths: readonly string[],
  vcsMetadataAccess: "deny" | "read" = "deny",
  safeHome?: string,
): string {
  const entries = [
    "glob_scan_max_depth=8",
    `${JSON.stringify(":root")}="deny"`,
    `${JSON.stringify(":minimal")}="read"`,
    `${JSON.stringify(":tmpdir")}="write"`,
    `${JSON.stringify(":slash_tmp")}="deny"`,
    ...(safeHome ? [`${JSON.stringify(safeHome)}="write"`] : []),
    `${JSON.stringify(":workspace_roots")}={`
      + [
        `${JSON.stringify(".")}="${workspaceAccess}"`,
        `${JSON.stringify(".git")}=${JSON.stringify(vcsMetadataAccess)}`,
        `${JSON.stringify(".jj")}=${JSON.stringify(vcsMetadataAccess)}`,
        `${JSON.stringify(".codex")}="deny"`,
        `${JSON.stringify(".claude")}="deny"`,
        `${JSON.stringify(".env")}="deny"`,
        `${JSON.stringify(".env.*")}="deny"`,
        `${JSON.stringify("**/.env")}="deny"`,
        `${JSON.stringify("**/.env.*")}="deny"`,
        `${JSON.stringify(".smithers/pg")}="deny"`,
        `${JSON.stringify(".smithers/migrated.json")}="deny"`,
      ].join(",")
      + "}",
    ...toolchainReadPaths.map((path) => `${JSON.stringify(path)}="read"`),
  ];
  return `{${entries.join(",")}}`;
}

function tomlInlineStringMap(values: Readonly<Record<string, string>>): string {
  return `{${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${JSON.stringify(name)}=${JSON.stringify(value)}`)
    .join(",")}}`;
}

/**
 * Codex 0.138+ permission-profile configuration. Do not add `sandbox` here:
 * permission profiles and legacy sandbox modes are mutually exclusive.
 */
export function buildPublicIssueCodexPolicy(
  role: PublicIssueAgentRole,
  source: EnvironmentSource = process.env,
  options: PublicIssueAgentPolicyOptions = {},
): PublicIssueCodexPolicy {
  const profile = `public-issue-${role}`;
  const workspaceAccess = role === "write" ? "write" : "read";
  const corepackHome = existingCorepackHome(source, options);
  const toolchainReadPaths = normalizedReadPaths([
    ...(options.toolchainReadPaths ?? []),
    ...(corepackHome ? [corepackHome] : []),
  ]);
  const env = buildPublicIssueSafeEnv(source, options);
  if (corepackHome) env.COREPACK_HOME = corepackHome;

  return {
    inheritEnv: false,
    env,
    yolo: false,
    config: [
      `default_permissions="${profile}"`,
      `permissions.${profile}.filesystem=${codexFilesystemConfig(workspaceAccess, toolchainReadPaths, "deny", options.safeHome)}`,
      `permissions.${profile}.network.enabled=false`,
      `shell_environment_policy.inherit="none"`,
      `shell_environment_policy.include_only=${JSON.stringify(PUBLIC_ISSUE_SAFE_ENV_NAMES)}`,
      `shell_environment_policy.set=${tomlInlineStringMap(env)}`,
      "allow_login_shell=false",
      `web_search="disabled"`,
      `approval_policy="never"`,
    ],
    extraArgs: [...PUBLIC_ISSUE_CODEX_EXTRA_ARGS],
  };
}

/** Fixed-command local verification policy; unlike agents, gates may read VCS metadata. */
export function buildLocalGateCodexPolicy(
  source: EnvironmentSource = process.env,
  options: PublicIssueAgentPolicyOptions = {},
): PublicIssueCodexPolicy {
  const profile = "local-issue-gate";
  const corepackHome = existingCorepackHome(source, options);
  const env = buildPublicIssueSafeEnv(source, options);
  if (corepackHome) env.COREPACK_HOME = corepackHome;
  const toolchainReadPaths = normalizedReadPaths([
    ...(options.toolchainReadPaths ?? []),
    ...(corepackHome ? [corepackHome] : []),
  ]);
  return {
    inheritEnv: false,
    env,
    yolo: false,
    config: [
      `default_permissions="${profile}"`,
      `permissions.${profile}.filesystem=${codexFilesystemConfig("write", toolchainReadPaths, "read", options.safeHome)}`,
      `permissions.${profile}.network.enabled=false`,
      `shell_environment_policy.inherit="none"`,
      `shell_environment_policy.include_only=${JSON.stringify(PUBLIC_ISSUE_SAFE_ENV_NAMES)}`,
      `shell_environment_policy.set=${tomlInlineStringMap(env)}`,
      "allow_login_shell=false",
      `web_search="disabled"`,
      `approval_policy="never"`,
    ],
    extraArgs: [...PUBLIC_ISSUE_CODEX_EXTRA_ARGS],
  };
}

function claudeSettings(
  role: PublicIssueAgentRole,
  allowedTools: string[],
  options: PublicIssueAgentPolicyOptions,
) {
  const deny = [
    ...CLAUDE_REMOTE_TOOL_DENIES,
    ...CLAUDE_DANGEROUS_BASH_DENIES,
    ...CLAUDE_WORKSPACE_SECRET_DENIES,
    ...CLAUDE_HOME_CREDENTIAL_READ_DENIES,
    ...(role === "read" ? CLAUDE_READ_ROLE_DENIES : []),
  ];
  const deniedHomes = options.hostHome ? [options.hostHome] : ["~/"];
  const readable = [".", ...normalizedReadPaths(options.toolchainReadPaths)];
  const workspaceMetadata = ["./.git", "./.jj", "./.codex", "./.claude"];
  const runtimeDenied = ["./.smithers/pg", "./.smithers/migrated.json"];

  return {
    disableAllHooks: true,
    disableAgentView: true,
    disableArtifact: true,
    channelsEnabled: false,
    permissions: {
      defaultMode: "dontAsk",
      disableBypassPermissionsMode: "disable",
      disableAutoMode: "disable",
      allow: allowedTools,
      ask: [],
      deny,
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      allowUnsandboxedCommands: false,
      enableWeakerNetworkIsolation: false,
      enableWeakerNestedSandbox: false,
      allowAppleEvents: false,
      filesystem: {
        denyRead: [...deniedHomes, ...workspaceMetadata, ...runtimeDenied],
        allowRead: readable,
        ...(role === "read"
          ? { denyWrite: ["."] }
          : {
              denyWrite: [...workspaceMetadata, ...runtimeDenied],
              allowWrite: ["."],
            }),
      },
      credentials: {
        files: PUBLIC_ISSUE_HOME_CREDENTIAL_PATHS.map((path) => ({
          path,
          mode: "deny",
        })),
        envVars: CLAUDE_SANDBOX_SECRET_ENV_NAMES.map((name) => ({
          name,
          mode: "deny",
        })),
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
    },
  };
}

/** Claude Code policy using safe mode plus a strict, empty MCP configuration. */
export function buildPublicIssueClaudePolicy(
  role: PublicIssueAgentRole,
  source: EnvironmentSource = process.env,
  options: PublicIssueAgentPolicyOptions = {},
): PublicIssueClaudePolicy {
  const corepackHome = existingCorepackHome(source, options);
  const effectiveOptions = {
    ...options,
    toolchainReadPaths: normalizedReadPaths([
      ...(options.toolchainReadPaths ?? []),
      ...(corepackHome ? [corepackHome] : []),
    ]),
  };
  const env = buildPublicIssueSafeEnv(source, effectiveOptions);
  if (corepackHome) env.COREPACK_HOME = corepackHome;
  const tools = [
    ...(role === "write" ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_TOOLS),
  ];
  const disallowedTools = [
    ...CLAUDE_REMOTE_TOOL_DENIES,
    ...CLAUDE_DANGEROUS_BASH_DENIES,
    ...CLAUDE_WORKSPACE_SECRET_DENIES,
    ...CLAUDE_HOME_CREDENTIAL_READ_DENIES,
    ...(role === "read" ? CLAUDE_READ_ROLE_DENIES : []),
  ];

  return {
    inheritEnv: false,
    env,
    yolo: false,
    permissionMode: "dontAsk",
    allowedTools: [
      ...(role === "write" ? CLAUDE_WRITE_ALLOW_RULES : CLAUDE_READ_ALLOW_RULES),
    ],
    disallowedTools,
    tools,
    noChrome: true,
    noSessionPersistence: true,
    disableSlashCommands: true,
    strictMcpConfig: true,
    mcpConfig: [JSON.stringify({ mcpServers: {} })],
    settings: JSON.stringify(claudeSettings(
      role,
      role === "write" ? [...CLAUDE_WRITE_ALLOW_RULES] : [...CLAUDE_READ_ALLOW_RULES],
      effectiveOptions,
    )),
    settingSources: "",
    extraArgs: ["--safe-mode"],
  };
}

export function buildPublicIssueAgentPolicy(
  role: PublicIssueAgentRole,
  source: EnvironmentSource = process.env,
  options: PublicIssueAgentPolicyOptions = {},
): {
  codex: PublicIssueCodexPolicy;
  claude: PublicIssueClaudePolicy;
} {
  return {
    codex: buildPublicIssueCodexPolicy(role, source, options),
    claude: buildPublicIssueClaudePolicy(role, source, options),
  };
}
