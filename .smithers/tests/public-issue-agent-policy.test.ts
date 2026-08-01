import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import {
  PUBLIC_ISSUE_CODEX_EXTRA_ARGS,
  PUBLIC_ISSUE_SAFE_ENV_NAMES,
  buildPublicIssueAgentPolicy,
  buildPublicIssueClaudePolicy,
  buildPublicIssueCodexPolicy,
  buildLocalGateCodexPolicy,
  buildPublicIssueSafeEnv,
  resolveHomebrewDynamicLibraryReadPathClosure,
  resolveHomebrewDynamicLibraryReadPaths,
  resolvePublicIssueToolchainReadPaths,
} from "../lib/publicIssueAgentPolicy";

const hostileEnv = {
  PATH: "/safe/bin",
  HOME: "/safe/home",
  LANG: "C.UTF-8",
  TMPDIR: "/safe/tmp",
  OPENAI_API_KEY: "openai-secret-value",
  ANTHROPIC_API_KEY: "anthropic-secret-value",
  GH_TOKEN: "github-secret-value",
  GITHUB_TOKEN: "github-secret-value-2",
  AWS_SECRET_ACCESS_KEY: "aws-secret-value",
  DATABASE_URL: "postgres://secret",
  SSH_AUTH_SOCK: "/secret/agent.sock",
  ADMIN_API_KEY: "admin-secret-value",
  TF_VAR_github_token: "terraform-secret-value",
  NODE_OPTIONS: "--require /tmp/ambient-code.js",
  OPENSSL_CONF: "/secret/openssl.cnf",
} as const;

const AMBIENT_SECRET_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "DATABASE_URL",
  "SSH_AUTH_SOCK",
  "ADMIN_API_KEY",
  "TF_VAR_github_token",
  "NODE_OPTIONS",
] as const;
const repoRoot = join(import.meta.dir, "../..");

function pathContains(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function firstRegularFile(
  root: string,
  predicate: (path: string) => boolean,
  depth = 3,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && predicate(path)) return path;
  }
  if (depth <= 0) return undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await firstRegularFile(join(root, entry.name), predicate, depth - 1);
    if (found) return found;
  }
  return undefined;
}

async function homebrewSandboxCanaries(toolchainReadPaths: readonly string[]): Promise<{
  linkedLibrary?: string;
  unrelatedFormulaFile?: string;
}> {
  if (process.platform !== "darwin") return {};
  const admittedRoots: string[] = [];
  for (const path of toolchainReadPaths) {
    try {
      admittedRoots.push(await realpath(path));
    } catch {
      // Ignore paths that disappeared after toolchain discovery.
    }
  }

  let linkedLibrary: string | undefined;
  let unrelatedFormulaFile: string | undefined;

  for (const optRoot of toolchainReadPaths.filter((path) => path.endsWith("/opt"))) {
    let entries;
    try {
      entries = await readdir(optRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const formulaPath = join(optRoot, entry.name);
      let formulaRoot: string;
      try {
        formulaRoot = await realpath(formulaPath);
      } catch {
        continue;
      }
      const admitted = admittedRoots.some((root) => pathContains(root, formulaRoot) || pathContains(formulaRoot, root));
      if (admitted && !linkedLibrary) {
        const canonicalLibrary = await firstRegularFile(formulaRoot, (path) => path.endsWith(".dylib"));
        if (canonicalLibrary) {
          linkedLibrary = join(formulaPath, relative(formulaRoot, canonicalLibrary));
        }
      } else if (!admitted && !unrelatedFormulaFile) {
        const canonicalFile = await firstRegularFile(formulaRoot, () => true, 2);
        if (canonicalFile) {
          unrelatedFormulaFile = join(formulaPath, relative(formulaRoot, canonicalFile));
        }
      }
      if (linkedLibrary && unrelatedFormulaFile) {
        return { linkedLibrary, unrelatedFormulaFile };
      }
    }
  }
  return { linkedLibrary, unrelatedFormulaFile };
}

describe("public issue agent policy", () => {
  test("copies only the explicit operational environment allowlist", () => {
    const safe = buildPublicIssueSafeEnv(hostileEnv);

    expect(safe).toEqual({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LANG: "C.UTF-8",
      TMPDIR: "/safe/tmp",
      GIT_TERMINAL_PROMPT: "0",
      OPENSSL_CONF: process.platform === "win32" ? "NUL" : "/dev/null",
      npm_config_manage_package_manager_versions: "false",
    });
    expect(Object.keys(safe).every((name) => (PUBLIC_ISSUE_SAFE_ENV_NAMES as readonly string[]).includes(name))).toBe(
      true,
    );
    for (const name of AMBIENT_SECRET_NAMES) expect(safe).not.toHaveProperty(name);
    expect(JSON.stringify(safe)).not.toContain("secret-value");
    expect(JSON.stringify(safe)).not.toContain("postgres://");
    expect(JSON.stringify(safe)).not.toContain("/secret/openssl.cnf");
  });

  test("builds exact read and write Codex permission profiles without legacy escape hatches", () => {
    const options = {
      safeHome: "/tmp/issue-home",
      hostHome: "/Users/operator",
      toolchainReadPaths: ["/Users/operator/.nvm/versions/node/v24", "/opt/homebrew/Cellar/jj/0.39"],
    } as const;
    const read = buildPublicIssueCodexPolicy("read", hostileEnv, options);
    const write = buildPublicIssueCodexPolicy("write", hostileEnv, options);

    expect(read.inheritEnv).toBe(false);
    expect(read.yolo).toBe(false);
    expect(read.extraArgs).toEqual([...PUBLIC_ISSUE_CODEX_EXTRA_ARGS]);
    expect(read.config).toContain('default_permissions="public-issue-read"');
    const readFilesystem =
      read.config.find((entry) => entry.startsWith("permissions.public-issue-read.filesystem=")) ?? "";
    expect(readFilesystem).toContain('":root"="deny"');
    expect(readFilesystem).toContain('":minimal"="read"');
    expect(readFilesystem).toContain('":tmpdir"="write"');
    expect(readFilesystem).toContain('":slash_tmp"="deny"');
    expect(readFilesystem).toContain("glob_scan_max_depth=8");
    expect(readFilesystem).toContain('":workspace_roots"={"."="read",".git"="deny",".jj"="deny"');
    expect(readFilesystem).toContain('".env"="deny"');
    expect(readFilesystem).toContain('".smithers/pg"="deny"');
    expect(readFilesystem).toContain('"/Users/operator/.nvm/versions/node/v24"="read"');
    expect(read.config).toContain("permissions.public-issue-read.network.enabled=false");
    expect(read.config).toContain('shell_environment_policy.inherit="none"');
    expect(read.config).toContain(
      `shell_environment_policy.include_only=${JSON.stringify(PUBLIC_ISSUE_SAFE_ENV_NAMES)}`,
    );
    expect(read.config).toContain("allow_login_shell=false");
    expect(read.config).toContain('web_search="disabled"');
    expect(read.config).toContain('approval_policy="never"');
    expect(write.config.find((entry) => entry.startsWith("permissions.public-issue-write.filesystem="))).toContain(
      '":workspace_roots"={"."="write",".git"="deny",".jj"="deny"',
    );
    expect(read.env.HOME).toBe("/tmp/issue-home");
    expect(read.env.USERPROFILE).toBe("/tmp/issue-home");

    for (const policy of [read, write]) {
      expect(policy).not.toHaveProperty("sandbox");
      expect(policy).not.toHaveProperty("fullAuto");
      expect(policy).not.toHaveProperty("dangerouslyBypassApprovalsAndSandbox");
      expect(policy.extraArgs.join(" ")).not.toContain("bypass");
      for (const name of AMBIENT_SECRET_NAMES) expect(policy.env).not.toHaveProperty(name);
    }
  });

  test("gives only the deterministic local gate read access to VCS metadata", () => {
    const gate = buildLocalGateCodexPolicy(hostileEnv, {
      safeHome: "/tmp/gate-home",
      toolchainReadPaths: ["/safe/bin"],
    });
    const filesystem = gate.config.find((entry) => entry.startsWith("permissions.local-issue-gate.filesystem=")) ?? "";
    expect(gate.config).toContain('default_permissions="local-issue-gate"');
    expect(filesystem).toContain('":workspace_roots"={"."="write",".git"="read",".jj"="read"');
    expect(filesystem).toContain('".smithers/pg"="deny"');
    expect(gate.config).toContain("permissions.local-issue-gate.network.enabled=false");
  });

  test("limits Claude read roles to file inspection and fails closed", () => {
    const policy = buildPublicIssueClaudePolicy("read", hostileEnv);
    const settings = JSON.parse(policy.settings);

    expect(policy.inheritEnv).toBe(false);
    expect(policy.yolo).toBe(false);
    expect(policy.permissionMode).toBe("dontAsk");
    expect(policy.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(policy.allowedTools).toEqual(["Read(./**)", "Glob", "Grep"]);
    expect(policy.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Edit", "Write", "WebFetch", "WebSearch", "mcp__*", "Read(~/.ssh/**)"]),
    );
    expect(policy.extraArgs).toEqual(["--safe-mode"]);
    expect(policy.noSessionPersistence).toBe(true);
    expect(policy.noChrome).toBe(true);
    expect(policy.disableSlashCommands).toBe(true);
    expect(policy.strictMcpConfig).toBe(true);
    expect(policy.settingSources).toBe("");
    expect(policy.mcpConfig.map((value) => JSON.parse(value))).toEqual([{ mcpServers: {} }]);
    expect(policy).not.toHaveProperty("dangerouslySkipPermissions");
    expect(policy).not.toHaveProperty("allowDangerouslySkipPermissions");

    expect(settings.permissions).toMatchObject({
      defaultMode: "dontAsk",
      disableBypassPermissionsMode: "disable",
      disableAutoMode: "disable",
      allow: policy.allowedTools,
      ask: [],
    });
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      allowUnsandboxedCommands: false,
      enableWeakerNetworkIsolation: false,
      enableWeakerNestedSandbox: false,
      allowAppleEvents: false,
      filesystem: {
        denyRead: ["~/", "./.git", "./.jj", "./.codex", "./.claude", "./.smithers/pg", "./.smithers/migrated.json"],
        allowRead: ["."],
        denyWrite: ["."],
      },
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
    });
    expect(settings.sandbox.credentials.files).toEqual(
      expect.arrayContaining([
        { path: "~/.ssh", mode: "deny" },
        { path: "~/.claude", mode: "deny" },
        { path: "~/.codex", mode: "deny" },
      ]),
    );
    expect(settings.sandbox.credentials.envVars).toEqual(
      expect.arrayContaining([
        { name: "ANTHROPIC_API_KEY", mode: "deny" },
        { name: "ANTHROPIC_AUTH_TOKEN", mode: "deny" },
      ]),
    );
    for (const name of AMBIENT_SECRET_NAMES) expect(policy.env).not.toHaveProperty(name);
  });

  test("adds only workspace-scoped edit tools for Claude write roles", () => {
    const policy = buildPublicIssueClaudePolicy("write", hostileEnv);
    const settings = JSON.parse(policy.settings);

    expect(policy.tools).toEqual(["Read", "Glob", "Grep", "Edit", "Write"]);
    expect(policy.allowedTools).toEqual(expect.arrayContaining(["Read(./**)", "Edit(./**)", "Write(./**)"]));
    expect(policy.allowedTools).not.toContain("Bash");
    expect(policy.disallowedTools).not.toContain("Edit");
    expect(policy.disallowedTools).toEqual(
      expect.arrayContaining([
        "WebFetch",
        "WebSearch",
        "mcp__*",
        "Read(./.env)",
        "Read(./.smithers/pg/**)",
        "Edit(./.git/**)",
        "Write(./.jj/**)",
      ]),
    );
    expect(settings.sandbox.filesystem).toEqual({
      denyRead: ["~/", "./.git", "./.jj", "./.codex", "./.claude", "./.smithers/pg", "./.smithers/migrated.json"],
      allowRead: ["."],
      denyWrite: ["./.git", "./.jj", "./.codex", "./.claude", "./.smithers/pg", "./.smithers/migrated.json"],
      allowWrite: ["."],
    });
    expect(settings.permissions.allow).toEqual(policy.allowedTools);
  });

  test("denies the real home while reopening only exact toolchain roots", () => {
    const policy = buildPublicIssueClaudePolicy("write", hostileEnv, {
      safeHome: "/tmp/issue-home",
      hostHome: "/Users/operator",
      toolchainReadPaths: ["/Users/operator/.nvm/versions/node/v24"],
    });
    const settings = JSON.parse(policy.settings);

    expect(policy.env.HOME).toBe("/tmp/issue-home");
    expect(settings.sandbox.filesystem).toEqual({
      denyRead: [
        "/Users/operator",
        "./.git",
        "./.jj",
        "./.codex",
        "./.claude",
        "./.smithers/pg",
        "./.smithers/migrated.json",
      ],
      allowRead: [".", "/Users/operator/.nvm/versions/node/v24"],
      denyWrite: ["./.git", "./.jj", "./.codex", "./.claude", "./.smithers/pg", "./.smithers/migrated.json"],
      allowWrite: ["."],
    });
    expect(settings).toMatchObject({
      disableAllHooks: true,
      disableAgentView: true,
      disableArtifact: true,
      channelsEnabled: false,
    });
    expect(policy.disallowedTools).toEqual(
      expect.arrayContaining([
        "Bash(gh *)",
        "Bash(git push*)",
        "Bash(curl *)",
        "Bash(pkill *)",
        "Edit(./.git)",
        "Write(./.jj)",
      ]),
    );
  });

  test("returns both provider policies with independently copied data", () => {
    const combined = buildPublicIssueAgentPolicy("write", hostileEnv);
    expect(combined.codex.env).toEqual(combined.claude.env);
    expect(combined.codex.env).not.toBe(combined.claude.env);
    expect(combined.codex.extraArgs).not.toBe(PUBLIC_ISSUE_CODEX_EXTRA_ARGS);
  });

  // The toolchain/Homebrew read-path resolvers encode POSIX layouts (shell
  // shims, otool dylib closures); their fixtures cannot exist on win32.
  test.skipIf(process.platform === "win32")(
    "reopens only the exact package for a pnpm-managed project-version binary",
    async () => {
      const pnpmHome = await mkdtemp(join(tmpdir(), "smithers-pnpm-policy-"));
      const versionRoot = join(pnpmHome, ".tools", "pnpm", "10.6.1");
      const packageRoot = join(versionRoot, "node_modules", "pnpm");
      const binaryDirectory = join(versionRoot, "bin");
      await Promise.all([
        mkdir(join(packageRoot, "bin"), { recursive: true }),
        mkdir(join(packageRoot, "dist"), { recursive: true }),
        mkdir(binaryDirectory, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(packageRoot, "bin", "pnpm.cjs"), "require('../dist/pnpm.cjs')\n"),
        writeFile(join(packageRoot, "dist", "pnpm.cjs"), "module.exports = {}\n"),
        symlink("../node_modules/pnpm/bin/pnpm.cjs", join(binaryDirectory, "pnpm"), "file"),
      ]);

      try {
        const canonicalPackageRoot = await realpath(packageRoot);
        const roots = resolvePublicIssueToolchainReadPaths({ PATH: binaryDirectory }, ["pnpm"]);

        expect(roots).toContain(binaryDirectory);
        expect(roots).toContain(canonicalPackageRoot);
        expect(roots).not.toContain(pnpmHome);
        expect(roots).not.toContain(join(pnpmHome, ".tools"));
        expect(roots).not.toContain(join(versionRoot, "node_modules"));
      } finally {
        await rm(pnpmHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "reopens only the exact package for a conventionally installed pnpm binary",
    async () => {
      const installRoot = await mkdtemp(join(tmpdir(), "smithers-global-pnpm-policy-"));
      const packageRoot = join(installRoot, "lib", "node_modules", "pnpm");
      const binaryDirectory = join(installRoot, "bin");
      await Promise.all([
        mkdir(join(packageRoot, "bin"), { recursive: true }),
        mkdir(join(packageRoot, "dist"), { recursive: true }),
        mkdir(binaryDirectory, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(packageRoot, "bin", "pnpm.cjs"), "require('../dist/pnpm.cjs')\n"),
        writeFile(join(packageRoot, "dist", "pnpm.cjs"), "module.exports = {}\n"),
        symlink("../lib/node_modules/pnpm/bin/pnpm.cjs", join(binaryDirectory, "pnpm"), "file"),
      ]);

      try {
        const canonicalPackageRoot = await realpath(packageRoot);
        const roots = resolvePublicIssueToolchainReadPaths({ PATH: binaryDirectory }, ["pnpm"]);

        expect(roots).toContain(binaryDirectory);
        expect(roots).toContain(canonicalPackageRoot);
        expect(roots).not.toContain(installRoot);
        expect(roots).not.toContain(join(installRoot, "lib", "node_modules"));
      } finally {
        await rm(installRoot, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "keeps the exact Homebrew formula root for a pnpm package entry point",
    async () => {
      const prefix = await mkdtemp(join(tmpdir(), "smithers-homebrew-pnpm-policy-"));
      const formulaRoot = join(prefix, "Cellar", "pnpm", "10.10.0");
      const packageRoot = join(formulaRoot, "libexec", "lib", "node_modules", "pnpm");
      const formulaBin = join(formulaRoot, "libexec", "bin");
      const binaryDirectory = join(prefix, "bin");
      await Promise.all([
        mkdir(join(packageRoot, "bin"), { recursive: true }),
        mkdir(join(packageRoot, "dist"), { recursive: true }),
        mkdir(formulaBin, { recursive: true }),
        mkdir(binaryDirectory, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(packageRoot, "bin", "pnpm.cjs"), "require('../dist/pnpm.cjs')\n"),
        writeFile(join(packageRoot, "dist", "pnpm.cjs"), "module.exports = {}\n"),
        symlink("../lib/node_modules/pnpm/bin/pnpm.cjs", join(formulaBin, "pnpm"), "file"),
        symlink("../Cellar/pnpm/10.10.0/libexec/bin/pnpm", join(binaryDirectory, "pnpm"), "file"),
      ]);

      try {
        const canonicalFormulaRoot = await realpath(formulaRoot);
        const canonicalPackageRoot = await realpath(packageRoot);
        const roots = resolvePublicIssueToolchainReadPaths({ PATH: binaryDirectory }, ["pnpm"]);

        expect(roots).toContain(canonicalFormulaRoot);
        expect(roots).not.toContain(canonicalPackageRoot);
        expect(roots).not.toContain(join(prefix, "Cellar", "pnpm"));
      } finally {
        await rm(prefix, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "adds only Homebrew opt traversal and exact linked Cellar roots",
    async () => {
      const prefix = await mkdtemp(join(tmpdir(), "smithers-homebrew-policy-"));
      const llhttpCellarRoot = join(prefix, "Cellar", "llhttp", "9.3.1");
      const llhttpLibrary = join(llhttpCellarRoot, "lib", "libllhttp.9.3.dylib");
      const llhttpOptRoot = join(prefix, "opt", "llhttp");
      await mkdir(join(llhttpCellarRoot, "lib"), { recursive: true });
      await mkdir(join(prefix, "opt"), { recursive: true });
      await writeFile(llhttpLibrary, "fixture");
      await symlink(llhttpCellarRoot, llhttpOptRoot, "dir");

      try {
        const binary = join(prefix, "Cellar", "node", "25.6.1", "bin", "node");
        const roots = resolveHomebrewDynamicLibraryReadPaths(
          binary,
          [
            `${binary}:`,
            `\t${join(llhttpOptRoot, "lib", "libllhttp.9.3.dylib")} (compatibility version 9.3.0, current version 9.3.1)`,
            "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)",
            "\t/other/homebrew/opt/private/lib/private.dylib (compatibility version 1.0.0, current version 1.0.0)",
          ].join("\n"),
        );

        expect(roots).toEqual([join(prefix, "opt"), join(await realpath(prefix), "Cellar", "llhttp", "9.3.1")].sort());
        expect(roots).not.toContain(prefix);
        expect(roots).not.toContain(join(prefix, "Cellar"));
        expect(roots).not.toContain(llhttpOptRoot);
      } finally {
        await rm(prefix, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
      }
    },
  );

  test("rejects empty and traversing Homebrew formula or version segments", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "smithers-homebrew-traversal-"));
    try {
      const binary = join(prefix, "Cellar", "node", "25.6.1", "bin", "node");
      const roots = resolveHomebrewDynamicLibraryReadPaths(
        binary,
        [
          `${binary}:`,
          `\t${prefix}/opt/../private/lib/private.dylib (compatibility version 1.0.0, current version 1.0.0)`,
          `\t${prefix}/opt/./lib/private.dylib (compatibility version 1.0.0, current version 1.0.0)`,
          `\t${prefix}/opt//lib/private.dylib (compatibility version 1.0.0, current version 1.0.0)`,
          `\t${prefix}/Cellar/../1.0/lib/private.dylib (compatibility version 1.0.0, current version 1.0.0)`,
          `\t${prefix}/Cellar/private/../lib/private.dylib (compatibility version 1.0.0, current version 1.0.0)`,
          `\t${prefix}/Cellar//1.0/lib/private.dylib (compatibility version 1.0.0, current version 1.0.0)`,
        ].join("\n"),
      );

      expect(roots).toEqual([]);
    } finally {
      await rm(prefix, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test("admits no logical root when a Homebrew load command cannot be resolved", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "smithers-homebrew-missing-"));
    try {
      const binary = join(prefix, "Cellar", "node", "25.6.1", "bin", "node");
      const roots = resolveHomebrewDynamicLibraryReadPaths(
        binary,
        [
          `${binary}:`,
          `\t${prefix}/opt/missing/lib/libmissing.dylib (compatibility version 1.0.0, current version 1.0.0)`,
          `\t${prefix}/Cellar/missing/1.0/lib/libmissing.dylib (compatibility version 1.0.0, current version 1.0.0)`,
        ].join("\n"),
      );

      expect(roots).toEqual([]);
      expect(roots).not.toContain(join(prefix, "opt"));
      expect(roots).not.toContain(join(prefix, "Cellar", "missing", "1.0"));
    } finally {
      await rm(prefix, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test.skipIf(process.platform === "win32")(
    "walks transitive Homebrew dylibs once even when the graph cycles",
    async () => {
      const temporaryPrefix = await mkdtemp(join(tmpdir(), "smithers-homebrew-closure-"));
      try {
        const prefix = await realpath(temporaryPrefix);
        const binary = join(prefix, "Cellar", "node", "25.6.1", "bin", "node");
        const llhttpRoot = join(prefix, "Cellar", "llhttp", "9.3.1");
        const llhttpLibrary = join(llhttpRoot, "lib", "libllhttp.9.3.dylib");
        const brotliRoot = join(prefix, "Cellar", "brotli", "1.2.0");
        const brotliLibrary = join(brotliRoot, "lib", "libbrotlicommon.1.dylib");
        await Promise.all([
          mkdir(join(binary, ".."), { recursive: true }),
          mkdir(join(llhttpRoot, "lib"), { recursive: true }),
          mkdir(join(brotliRoot, "lib"), { recursive: true }),
          mkdir(join(prefix, "opt"), { recursive: true }),
        ]);
        await Promise.all([
          writeFile(binary, "fixture"),
          writeFile(llhttpLibrary, "fixture"),
          writeFile(brotliLibrary, "fixture"),
          symlink(llhttpRoot, join(prefix, "opt", "llhttp"), "dir"),
          symlink(brotliRoot, join(prefix, "opt", "brotli"), "dir"),
        ]);

        const loadCommand = (owner: string, dependencies: string[]) =>
          [
            `${owner}:`,
            ...dependencies.map((dependency) => `\t${dependency} (compatibility version 1.0.0, current version 1.0.0)`),
          ].join("\n");
        const outputs = new Map([
          [binary, loadCommand(binary, [join(prefix, "opt", "llhttp", "lib", "libllhttp.9.3.dylib")])],
          [
            llhttpLibrary,
            loadCommand(llhttpLibrary, [join(prefix, "opt", "brotli", "lib", "libbrotlicommon.1.dylib")]),
          ],
          [brotliLibrary, loadCommand(brotliLibrary, [join(prefix, "opt", "llhttp", "lib", "libllhttp.9.3.dylib")])],
        ]);
        const inspected: string[] = [];

        const roots = resolveHomebrewDynamicLibraryReadPathClosure(binary, (path) => {
          inspected.push(path);
          return outputs.get(path);
        });

        expect(roots).toEqual([join(prefix, "opt"), llhttpRoot, brotliRoot].sort());
        expect(inspected.sort()).toEqual([binary, llhttpLibrary, brotliLibrary].sort());
      } finally {
        await rm(temporaryPrefix, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
          () => undefined,
        );
      }
    },
  );

  // A corepack-shim pnpm (nvm hosts) resolves its cache under $HOME, which the
  // public-issue policy denies by design, so the toolchain canary can only run
  // where pnpm is a standalone binary (CI installs one). Environment gate, not
  // a policy defect.
  const pnpmIsCorepackShim = (() => {
    const pnpmPath = Bun.which("pnpm");
    if (!pnpmPath) return true;
    try {
      return readFileSync(pnpmPath, "utf8").includes("corepack");
    } catch {
      return false;
    }
  })();
  test.skipIf(!Bun.which("codex") || pnpmIsCorepackShim)(
    "runs the required toolchain inside the real Codex sandbox without home or network access",
    async () => {
      const sandboxRoot = join(repoRoot, ".smithers", "sandboxes");
      await mkdir(sandboxRoot, { recursive: true });
      const runtime = await mkdtemp(join(tmpdir(), "smithers-public-issue-policy-"));
      const safeHome = join(runtime, "home");
      const safeTmp = join(runtime, "tmp");
      const codexHome = await mkdtemp(join(sandboxRoot, "policy-codex-home-"));
      await Promise.all([mkdir(safeHome, { recursive: true }), mkdir(safeTmp, { recursive: true })]);

      try {
        const toolchainReadPaths = resolvePublicIssueToolchainReadPaths();
        const { linkedLibrary, unrelatedFormulaFile } = await homebrewSandboxCanaries(toolchainReadPaths);
        if (toolchainReadPaths.some((path) => path.endsWith("/opt"))) {
          expect(linkedLibrary).toBeDefined();
        }
        if (linkedLibrary) expect(linkedLibrary).toContain("/opt/");
        if (unrelatedFormulaFile) expect(unrelatedFormulaFile).toContain("/opt/");
        const policy = buildPublicIssueCodexPolicy(
          "write",
          {
            ...process.env,
            TMPDIR: safeTmp,
            TMP: safeTmp,
            TEMP: safeTmp,
          },
          {
            safeHome,
            hostHome: homedir(),
            toolchainReadPaths,
          },
        );
        const args = [
          "sandbox",
          "-P",
          "public-issue-write",
          "-C",
          repoRoot,
          ...policy.config.flatMap((entry) => ["-c", entry]),
          "--",
          "bash",
          "-c",
          [
            "node --version",
            "bun --version",
            "pnpm --version",
            "git --version",
            '(cd "$TMPDIR" && jj --version)',
            "rg --version >/dev/null",
            ...(linkedLibrary ? [`test -r ${JSON.stringify(linkedLibrary)}`] : []),
            ...(unrelatedFormulaFile ? [`test ! -r ${JSON.stringify(unrelatedFormulaFile)}`] : []),
            "test -r package.json",
            'touch "$TMPDIR/policy-canary"',
            `test ! -r ${JSON.stringify(join(homedir(), ".ssh"))}`,
            "! curl -fsS --max-time 1 https://example.com >/dev/null 2>&1",
          ].join(" && "),
        ];
        const result = Bun.spawnSync([Bun.which("codex")!, ...args], {
          cwd: repoRoot,
          env: { ...policy.env, CODEX_HOME: codexHome },
          stdout: "pipe",
          stderr: "pipe",
        });

        if (result.exitCode !== 0) {
          throw new Error(
            `Codex sandbox canary exited ${result.exitCode}:\n${result.stdout.toString()}\n${result.stderr.toString()}`,
          );
        }
        expect(result.stdout.toString()).toContain("jj ");
        expect(result.stderr.toString()).not.toContain("data did not match");
      } finally {
        await rm(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
        await rm(codexHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
      }
    },
    // The codex sandbox spawn is fast unloaded (~10s) but competes with every
    // other package suite during `pnpm test`; 30s flakes under that load.
    120_000,
  );
});
