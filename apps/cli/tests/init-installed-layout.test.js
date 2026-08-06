// Regression test for the `bunx smthrs init` path bug.
//
// Before the fix, workflow-pack.js resolved `../../../package.json` relative
// to `apps/cli/src/workflow-pack.js`. That worked inside the monorepo (it
// landed on the root package.json) but failed in a published install, where
// the file lives at `node_modules/@smthrs/cli/src/` and the
// relative path resolves to `node_modules/package.json` — which does not
// exist. Init would throw ENOENT before writing a single file.
//
// This test reproduces the installed layout in a temp directory and verifies
// `initWorkflowPack` succeeds and pins `smthrs` to a real
// version range (not `"latest"`).

import { expect, onTestFinished, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_SRC = resolve(REPO_ROOT, "apps/cli/src");

/**
 * @param {string} path
 * @param {string} contents
 */
function writeFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function buildFakeInstallTree() {
  const root = mkdtempSync(join(tmpdir(), "smithers-installed-layout-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const cwd = join(root, "user-proj");
  const nm = join(cwd, "node_modules");
  // Simulate how pnpm/npm/bunx lay out the published package. Intentionally
  // do NOT include a `package.json` at `node_modules/` — this is the exact
  // condition that triggered the ENOENT before the fix.
  const smithersDir = join(nm, "smthrs");
  const cliDir = join(nm, "@smthrs", "cli");
  const errorsDir = join(nm, "@smthrs", "errors");
  const accountsDir = join(nm, "@smthrs", "accounts");

  writeFile(
    join(smithersDir, "package.json"),
    JSON.stringify({
      name: "smthrs",
      version: "99.0.0",
      type: "module",
      bin: { smithers: "./src/bin/smithers.js" },
    }) + "\n",
  );
  writeFile(join(smithersDir, "src/bin/smithers.js"), '#!/usr/bin/env node\nimport "@smthrs/cli";\n');

  writeFile(
    join(cliDir, "package.json"),
    JSON.stringify({
      name: "@smthrs/cli",
      version: "99.0.0",
      type: "module",
    }) + "\n",
  );
  cpSync(join(CLI_SRC, "workflow-pack.js"), join(cliDir, "src/workflow-pack.js"));
  cpSync(join(CLI_SRC, "manifest.js"), join(cliDir, "src/manifest.js"));
  cpSync(join(CLI_SRC, "agent-detection.js"), join(cliDir, "src/agent-detection.js"));
  cpSync(join(CLI_SRC, "registered-agent-id.js"), join(cliDir, "src/registered-agent-id.js"));
  cpSync(join(CLI_SRC, "sota-models.generated.js"), join(cliDir, "src/sota-models.generated.js"));
  cpSync(join(CLI_SRC, "init-templates.generated.js"), join(cliDir, "src/init-templates.generated.js"));
  cpSync(join(CLI_SRC, "installCuratedSkill.js"), join(cliDir, "src/installCuratedSkill.js"));
  cpSync(
    join(CLI_SRC, "noteWorkflowPreferenceInAgentDocs.js"),
    join(cliDir, "src/noteWorkflowPreferenceInAgentDocs.js"),
  );
  cpSync(join(CLI_SRC, "seeded-workflow-pack.generated.js"), join(cliDir, "src/seeded-workflow-pack.generated.js"));

  // Packaged curated-skill source (apps/cli/docs) so init can install the
  // skill straight from the tarball with no network access.
  writeFile(join(cliDir, "docs/SKILL.md"), "# Smithers skill\n");
  writeFile(join(cliDir, "docs/llms-full.txt"), "FULL DOCS BUNDLE\n");

  // Stub out the errors package so agent-detection.js can import it.
  writeFile(
    join(errorsDir, "package.json"),
    JSON.stringify({
      name: "@smthrs/errors",
      version: "99.0.0",
      type: "module",
      exports: { ".": "./src/index.js" },
    }) + "\n",
  );
  writeFile(
    join(errorsDir, "src/index.js"),
    [
      "export class SmithersError extends Error {",
      "  constructor(code, message, context) {",
      "    super(message);",
      "    this.code = code;",
      "    this.context = context;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  writeFile(
    join(accountsDir, "package.json"),
    JSON.stringify({
      name: "@smthrs/accounts",
      version: "99.0.0",
      type: "module",
      exports: { ".": "./src/index.js" },
    }) + "\n",
  );
  writeFile(
    join(accountsDir, "src/index.js"),
    [
      'import { homedir } from "node:os";',
      'import { join } from "node:path";',
      "export function listAccounts() { return []; }",
      // Agent detection probes each registered account inside its own configDir,
      // so the stub must expose the same account -> provider-env mapping the real
      // package does. `listAccounts()` returns nothing here, so a minimal
      // implementation is faithful enough.
      "export function accountToProviderEnv() { return {}; }",
      "export function accountsRoot(env = process.env) {",
      "  if (env.SMITHERS_HOME) return env.SMITHERS_HOME;",
      '  return join(env.HOME ?? homedir(), ".smithers");',
      "}",
      // registered-agent-id.js re-exports these from @smthrs/accounts.
      'export function registeredAgentId(label) { return `smithers-account:${label}`; }',
      "export function registeredAgentLabel(agentId) {",
      '  if (typeof agentId !== "string" || !agentId.startsWith("smithers-account:")) return undefined;',
      '  return agentId.slice("smithers-account:".length) || undefined;',
      "}",
      "",
    ].join("\n"),
  );

  // Stub out the usage package so agent-detection.js can import
  // @smthrs/usage/readClaudeCredentials. The module only uses node builtins,
  // so the real source is copied verbatim with the published `./*` exports.
  const usageDir = join(nm, "@smthrs", "usage");
  writeFile(
    join(usageDir, "package.json"),
    JSON.stringify({
      name: "@smthrs/usage",
      version: "99.0.0",
      type: "module",
      exports: { "./*": "./src/*.js" },
    }) + "\n",
  );
  mkdirSync(join(usageDir, "src"), { recursive: true });
  cpSync(
    join(REPO_ROOT, "packages/usage/src/readClaudeCredentials.js"),
    join(usageDir, "src/readClaudeCredentials.js"),
  );

  // Fake zod + typescript so require.resolve finds versions.
  writeFile(
    join(nm, "zod", "package.json"),
    JSON.stringify({ name: "zod", version: "4.99.0", main: "index.js" }) + "\n",
  );
  writeFile(join(nm, "zod", "index.js"), "export default {};\n");
  writeFile(join(nm, "typescript", "package.json"), JSON.stringify({ name: "typescript", version: "5.99.0" }) + "\n");

  for (const [packageName, version] of [
    ["react", "19.99.0"],
    ["react-dom", "19.99.0"],
    ["mermaid", "11.99.0"],
    ["@milkdown/crepe", "7.99.0"],
    ["@xyflow/react", "12.99.0"],
    ["dagre", "0.99.0"],
    ["yaml", "2.99.0"],
    ["@types/react", "19.99.0"],
    ["@types/react-dom", "19.99.0"],
    ["@types/mdx", "2.99.0"],
    ["@types/node", "25.99.0"],
    ["@types/dagre", "0.99.0"],
  ]) {
    writeFile(join(nm, packageName, "package.json"), JSON.stringify({ name: packageName, version }) + "\n");
  }
  cpSync(realpathSync(resolve(REPO_ROOT, "apps/cli/node_modules/@toon-format/toon")), join(nm, "@toon-format/toon"), {
    recursive: true,
  });

  // Fake claude binary so init has an agent to write into agents.ts.
  const binDir = join(root, "bin");
  writeFile(
    join(binDir, "claude"),
    [
      "#!/bin/sh",
      'if [ "$1 $2" = "auth status" ]; then',
      '  printf \'{"loggedIn":true,"authMethod":"claude.ai"}\\n\'',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "claude"), 0o755);
  writeFile(join(binDir, "bun"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(binDir, "bun"), 0o755);
  writeFile(join(root, "home", ".claude", ".credentials.json"), "{}\n");

  return {
    cwd,
    cliWorkflowPack: join(cliDir, "src/workflow-pack.js"),
    cliPackage: join(cliDir, "package.json"),
    nodeModules: nm,
    home: join(root, "home"),
    path: `${binDir}:/usr/bin:/bin`,
  };
}

test("initWorkflowPack succeeds when run from a published install layout", () => {
  const tree = buildFakeInstallTree();
  // Seed agent docs so init appends smithers.sh workflow guidance to them.
  writeFile(join(tree.cwd, "CLAUDE.md"), "# User project\n\nHand-written rules.\n");
  writeFile(join(tree.cwd, "AGENTS.md"), "# Agents doc\n");

  // Run init in a fresh child process using the faked node_modules layout —
  // running inline would resolve deps against the monorepo's node_modules.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
            import { initWorkflowPack } from ${JSON.stringify(tree.cliWorkflowPack)};
            const result = initWorkflowPack({ installSkill: true });
            process.stdout.write(JSON.stringify({
                ok: true,
                writtenCount: result.writtenFiles.length,
                rootDir: result.rootDir,
                skillInstalledInto: (result.skill?.installed ?? []).map((entry) => entry.agent),
                agentDocsUpdated: (result.agentDocs?.files ?? [])
                    .filter((file) => file.status === "updated")
                    .map((file) => file.path.split("/").pop()),
            }));
            `,
    ],
    {
      cwd: tree.cwd,
      env: {
        HOME: tree.home,
        PATH: tree.path,
      },
      encoding: "utf8",
    },
  );

  if (child.status !== 0) {
    throw new Error(`child failed (code=${child.status}):\nstdout: ${child.stdout}\nstderr: ${child.stderr}`);
  }
  const summary = JSON.parse(child.stdout);
  expect(summary.ok).toBe(true);
  expect(summary.writtenCount).toBeGreaterThan(30);
  expect(realpathSync(summary.rootDir)).toBe(realpathSync(join(tree.cwd, ".smithers")));

  const generated = JSON.parse(readFileSync(join(tree.cwd, ".smithers/package.json"), "utf8"));
  // The CLI's own version (99.0.0) should be pinned, not "latest".
  expect(generated.dependencies["smthrs"]).toBe("^99.0.0");
  expect(generated.dependencies["@smthrs/cli"]).toBe("^99.0.0");
  // And installed dep versions should be picked up via createRequire.
  expect(generated.dependencies.react).toBe("19.99.0");
  expect(generated.dependencies["react-dom"]).toBe("19.99.0");
  expect(generated.dependencies.zod).toBe("4.99.0");
  expect(generated.dependencies["@milkdown/crepe"]).toBe("7.99.0");
  expect(generated.dependencies.mermaid).toBe("11.99.0");
  expect(generated.dependencies["@xyflow/react"]).toBe("12.99.0");
  expect(generated.dependencies.dagre).toBe("0.99.0");
  expect(generated.dependencies.yaml).toBe("2.99.0");
  expect(generated.devDependencies.typescript).toBe("5.99.0");
  expect(generated.devDependencies["@types/react"]).toBe("19.99.0");
  expect(generated.devDependencies["@types/react-dom"]).toBe("19.99.0");
  expect(generated.devDependencies["@types/mdx"]).toBe("2.99.0");
  expect(generated.devDependencies["@types/node"]).toBe("25.99.0");
  expect(generated.devDependencies["@types/dagre"]).toBe("0.99.0");
  for (const file of [
    "ui/docs-driven-development.tsx",
    "ui/ddd-shared.tsx",
    "lib/ddd/build.ts",
    "lib/ddd/dddRoot.ts",
    "lib/ddd/validateFeatures.ts",
  ]) {
    const installed = join(tree.cwd, ".smithers", file);
    expect(existsSync(installed), `published pack omitted ${file}`).toBe(true);
    expect(readFileSync(installed, "utf8").length).toBeGreaterThan(0);
  }
  expect(existsSync(join(tree.cwd, ".smithers/components"))).toBe(false);

  // init also installed the curated skill into the detected agent (Claude Code,
  // present via the faked ~/.claude credentials) straight from the packaged
  // docs — no mkdir/curl by the user.
  expect(summary.skillInstalledInto).toContain("Claude Code");
  const skillDir = join(tree.home, ".claude", "skills", "smithers");
  expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe("# Smithers skill\n");
  expect(readFileSync(join(skillDir, "llms-full.txt"), "utf8")).toBe("FULL DOCS BUNDLE\n");

  // init also appended workflow guidance to both existing agent docs, keeping
  // the user's hand-written rules above the appended block.
  expect(summary.agentDocsUpdated).toContain("CLAUDE.md");
  expect(summary.agentDocsUpdated).toContain("AGENTS.md");
  const claudeMd = readFileSync(join(tree.cwd, "CLAUDE.md"), "utf8");
  expect(claudeMd).toContain("Hand-written rules.");
  expect(claudeMd).toContain("Smithers workflows");
  expect(claudeMd).toContain("smithers.sh");
  expect(readFileSync(join(tree.cwd, "AGENTS.md"), "utf8")).toContain("Smithers workflows");
});

test("published init falls back when its own or dependency versions are unavailable", () => {
  const tree = buildFakeInstallTree();
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { rmSync, writeFileSync } from "node:fs";
        import { initWorkflowPack } from ${JSON.stringify(tree.cliWorkflowPack)};
        rmSync(${JSON.stringify(tree.cliPackage)});
        writeFileSync(${JSON.stringify(join(tree.nodeModules, "@types/node/package.json"))}, "{invalid json");
        rmSync(${JSON.stringify(join(tree.nodeModules, "@types/dagre/package.json"))});
        const result = initWorkflowPack({
          installSkill: false,
          skipInstall: true,
          env: { HOME: ${JSON.stringify(tree.home)}, PATH: ${JSON.stringify(tree.path)} },
        });
        process.stdout.write(JSON.stringify({ rootDir: result.rootDir }));
      `,
    ],
    {
      cwd: tree.cwd,
      env: {
        HOME: tree.home,
        PATH: tree.path,
      },
      encoding: "utf8",
    },
  );
  if (child.status !== 0) {
    throw new Error(`child failed (code=${child.status}):\nstdout: ${child.stdout}\nstderr: ${child.stderr}`);
  }

  const generated = JSON.parse(readFileSync(join(JSON.parse(child.stdout).rootDir, "package.json"), "utf8"));
  expect(generated.dependencies["smthrs"]).toBe("latest");
  expect(generated.dependencies["@smthrs/cli"]).toBe("latest");
  expect(generated.devDependencies["@types/node"]).toBe("25.6.0");
  expect(generated.devDependencies["@types/dagre"]).toBe("0.7.54");
});
