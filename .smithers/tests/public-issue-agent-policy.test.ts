import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  PUBLIC_ISSUE_CODEX_EXTRA_ARGS,
  PUBLIC_ISSUE_SAFE_ENV_NAMES,
  buildPublicIssueAgentPolicy,
  buildPublicIssueClaudePolicy,
  buildPublicIssueCodexPolicy,
  buildLocalGateCodexPolicy,
  buildPublicIssueSafeEnv,
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

describe("public issue agent policy", () => {
  test("copies only the explicit operational environment allowlist", () => {
    const safe = buildPublicIssueSafeEnv(hostileEnv);

    expect(safe).toEqual({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      LANG: "C.UTF-8",
      TMPDIR: "/safe/tmp",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(Object.keys(safe).every((name) =>
      (PUBLIC_ISSUE_SAFE_ENV_NAMES as readonly string[]).includes(name)
    )).toBe(true);
    for (const name of AMBIENT_SECRET_NAMES) expect(safe).not.toHaveProperty(name);
    expect(JSON.stringify(safe)).not.toContain("secret-value");
    expect(JSON.stringify(safe)).not.toContain("postgres://");
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
    const readFilesystem = read.config.find((entry) =>
      entry.startsWith("permissions.public-issue-read.filesystem=")
    ) ?? "";
    expect(readFilesystem).toContain('":root"="deny"');
    expect(readFilesystem).toContain('":minimal"="read"');
    expect(readFilesystem).toContain('":tmpdir"="write"');
    expect(readFilesystem).toContain('":slash_tmp"="deny"');
    expect(readFilesystem).toContain('"/tmp/issue-home"="write"');
    expect(readFilesystem).toContain('glob_scan_max_depth=8');
    expect(readFilesystem).toContain('":workspace_roots"={"."="read",".git"="deny",".jj"="deny"');
    expect(readFilesystem).toContain('".env"="deny"');
    expect(readFilesystem).toContain('".smithers/pg"="deny"');
    expect(readFilesystem).toContain('"/Users/operator/.nvm/versions/node/v24"="read"');
    expect(read.config).toContain("permissions.public-issue-read.network.enabled=false");
    expect(read.config).toContain('shell_environment_policy.inherit="none"');
    expect(read.config).toContain(`shell_environment_policy.include_only=${JSON.stringify(PUBLIC_ISSUE_SAFE_ENV_NAMES)}`);
    expect(read.config).toContain("allow_login_shell=false");
    expect(read.config).toContain('web_search="disabled"');
    expect(read.config).toContain('approval_policy="never"');
    expect(write.config.find((entry) => entry.startsWith("permissions.public-issue-write.filesystem=")))
      .toContain('":workspace_roots"={"."="write",".git"="deny",".jj"="deny"');
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
    const filesystem = gate.config.find((entry) =>
      entry.startsWith("permissions.local-issue-gate.filesystem=")
    ) ?? "";
    expect(gate.config).toContain('default_permissions="local-issue-gate"');
    expect(filesystem).toContain('":workspace_roots"={"."="write",".git"="read",".jj"="read"');
    expect(filesystem).toContain('".smithers/pg"="deny"');
    expect(gate.config).toContain("permissions.local-issue-gate.network.enabled=false");
    expect(filesystem).toContain('"/tmp/gate-home"="write"');
  });

  test("pins Corepack to an existing tool cache without reopening the host home", async () => {
    const hostHome = await mkdtemp(join(tmpdir(), "smithers-corepack-home-"));
    const corepackHome = join(hostHome, ".cache", "node", "corepack");
    await mkdir(corepackHome, { recursive: true });

    try {
      const options = { safeHome: "/tmp/issue-home", hostHome };
      const combined = buildPublicIssueAgentPolicy("write", hostileEnv, options);
      const filesystem = combined.codex.config.find((entry) =>
        entry.startsWith("permissions.public-issue-write.filesystem=")
      ) ?? "";
      const claudeSettings = JSON.parse(combined.claude.settings);

      expect(combined.codex.env.COREPACK_HOME).toBe(corepackHome);
      expect(combined.claude.env.COREPACK_HOME).toBe(corepackHome);
      expect(filesystem).toContain(`${JSON.stringify(corepackHome)}="read"`);
      expect(filesystem).not.toContain(`${JSON.stringify(hostHome)}="read"`);
      expect(claudeSettings.sandbox.filesystem.allowRead).toContain(corepackHome);
      expect(claudeSettings.sandbox.filesystem.denyRead).toContain(hostHome);
    } finally {
      await rm(hostHome, { recursive: true, force: true });
    }
  });

  test("limits Claude read roles to file inspection and fails closed", () => {
    const policy = buildPublicIssueClaudePolicy("read", hostileEnv);
    const settings = JSON.parse(policy.settings);

    expect(policy.inheritEnv).toBe(false);
    expect(policy.yolo).toBe(false);
    expect(policy.permissionMode).toBe("dontAsk");
    expect(policy.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(policy.allowedTools).toEqual(["Read(./**)", "Glob", "Grep"]);
    expect(policy.disallowedTools).toEqual(expect.arrayContaining([
      "Bash",
      "Edit",
      "Write",
      "WebFetch",
      "WebSearch",
      "mcp__*",
      "Read(~/.ssh/**)",
    ]));
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
    expect(settings.sandbox.credentials.files).toEqual(expect.arrayContaining([
      { path: "~/.ssh", mode: "deny" },
      { path: "~/.claude", mode: "deny" },
      { path: "~/.codex", mode: "deny" },
    ]));
    expect(settings.sandbox.credentials.envVars).toEqual(expect.arrayContaining([
      { name: "ANTHROPIC_API_KEY", mode: "deny" },
      { name: "ANTHROPIC_AUTH_TOKEN", mode: "deny" },
    ]));
    for (const name of AMBIENT_SECRET_NAMES) expect(policy.env).not.toHaveProperty(name);
  });

  test("adds only workspace-scoped edit tools for Claude write roles", () => {
    const policy = buildPublicIssueClaudePolicy("write", hostileEnv);
    const settings = JSON.parse(policy.settings);

    expect(policy.tools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
    ]);
    expect(policy.allowedTools).toEqual(expect.arrayContaining([
      "Read(./**)",
      "Edit(./**)",
      "Write(./**)",
    ]));
    expect(policy.allowedTools).not.toContain("Bash");
    expect(policy.disallowedTools).not.toContain("Edit");
    expect(policy.disallowedTools).toEqual(expect.arrayContaining([
      "WebFetch",
      "WebSearch",
      "mcp__*",
      "Read(./.env)",
      "Read(./.smithers/pg/**)",
      "Edit(./.git/**)",
      "Write(./.jj/**)",
    ]));
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
      denyRead: ["/Users/operator", "./.git", "./.jj", "./.codex", "./.claude", "./.smithers/pg", "./.smithers/migrated.json"],
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
    expect(policy.disallowedTools).toEqual(expect.arrayContaining([
      "Bash(gh *)",
      "Bash(git push*)",
      "Bash(curl *)",
      "Bash(pkill *)",
      "Edit(./.git)",
      "Write(./.jj)",
    ]));
  });

  test("returns both provider policies with independently copied data", () => {
    const combined = buildPublicIssueAgentPolicy("write", hostileEnv);
    expect(combined.codex.env).toEqual(combined.claude.env);
    expect(combined.codex.env).not.toBe(combined.claude.env);
    expect(combined.codex.extraArgs).not.toBe(PUBLIC_ISSUE_CODEX_EXTRA_ARGS);
  });

  test.skipIf(!Bun.which("codex"))(
    "runs the available toolchain inside the real Codex sandbox without home or network access",
    async () => {
      const sandboxRoot = join(repoRoot, ".smithers", "sandboxes");
      await mkdir(sandboxRoot, { recursive: true });
      const runtime = await mkdtemp(join(tmpdir(), "smithers-public-issue-policy-"));
      const safeHome = join(runtime, "home");
      const safeTmp = join(runtime, "tmp");
      const codexHome = await mkdtemp(join(sandboxRoot, "policy-codex-home-"));
      await Promise.all([
        mkdir(safeHome, { recursive: true }),
        mkdir(safeTmp, { recursive: true }),
      ]);

      try {
        const toolchainReadPaths = resolvePublicIssueToolchainReadPaths();
        const policy = buildPublicIssueCodexPolicy("write", {
          ...process.env,
          TMPDIR: safeTmp,
          TMP: safeTmp,
          TEMP: safeTmp,
        }, {
          safeHome,
          hostHome: homedir(),
          toolchainReadPaths,
        });
        const availableToolCommands = [
          ["node", "node --version"],
          ["bun", "bun --version"],
          ["pnpm", "pnpm --version"],
          ["git", "git --version"],
          ["jj", "(cd \"$TMPDIR\" && jj --version)"],
          ["rg", "rg --version >/dev/null"],
        ]
          .filter(([binary]) => Bun.which(binary!))
          .map(([, command]) => command!);
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
            ...availableToolCommands,
            "test -r package.json",
            "touch \"$TMPDIR/policy-canary\"",
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
        if (Bun.which("jj")) expect(result.stdout.toString()).toContain("jj ");
        expect(result.stderr.toString()).not.toContain("data did not match");
      } finally {
        await rm(runtime, { recursive: true, force: true });
        await rm(codexHome, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
