import { expect, onTestFinished, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveSkillDeselections, skillTargets } from "../src/installCuratedSkill.js";
import { loadManifest } from "../src/manifest.js";
import {
  applyWorkflowPackUpdates,
  ensureRootGitignore,
  initWorkflowPack,
  loadPackSelections,
  resolveEffectiveAgentDocs,
} from "../src/workflow-pack.js";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const LOCAL_RUNTIME = join(REPO_ROOT, "packages/smithers");

function tempProject(prefix = "smithers-pack-coverage-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeExecutable(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}

function seededAgentEnv(root, extra = {}) {
  const binDir = join(root, "agent-bin");
  writeExecutable(join(binDir, "codex"), "#!/bin/sh\nexit 0\n");
  return {
    ...process.env,
    PATH: binDir,
    OPENAI_API_KEY: "sk-test-openai-key",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    ...extra,
  };
}

function baseOptions(root, extra = {}) {
  return {
    rootDir: root,
    installSkill: false,
    skipInstall: true,
    env: seededAgentEnv(root),
    ...extra,
  };
}

function withProcessPath(path, fn) {
  const previous = process.env.PATH;
  process.env.PATH = path;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

test("pack selections tolerate missing, malformed, and non-array data", () => {
  const root = tempProject();
  const pack = join(root, ".smithers");
  mkdirSync(pack, { recursive: true });

  expect(loadPackSelections(pack)).toEqual({ deselectedAgentDocs: [] });
  writeFileSync(join(pack, "pack-selections.json"), "{not json", "utf8");
  expect(loadPackSelections(pack)).toEqual({ deselectedAgentDocs: [] });
  writeFileSync(join(pack, "pack-selections.json"), JSON.stringify({ deselectedAgentDocs: "AGENTS.md" }), "utf8");
  expect(loadPackSelections(pack)).toEqual({ deselectedAgentDocs: [] });
  writeFileSync(
    join(pack, "pack-selections.json"),
    JSON.stringify({ deselectedAgentDocs: ["agents.md", "unknown.md"] }),
    "utf8",
  );
  expect(loadPackSelections(pack)).toEqual({ deselectedAgentDocs: ["agents.md", "unknown.md"] });
  expect(resolveEffectiveAgentDocs(pack)).toEqual(["CLAUDE.md"]);

  writeFileSync(join(pack, "pack-selections.json"), JSON.stringify({ deselectedAgentDocs: [] }), "utf8");
  expect(resolveEffectiveAgentDocs(pack)).toBeUndefined();
});

test("selected agent docs persist, survive null selection, and ignore persistence errors", () => {
  const root = tempProject();
  const options = baseOptions(root, { selectedAgentDocs: ["agents.md"], reporter: {} });
  initWorkflowPack(options);
  const selectionsPath = join(root, ".smithers", "pack-selections.json");
  expect(JSON.parse(readFileSync(selectionsPath, "utf8"))).toEqual({
    deselectedAgentDocs: ["CLAUDE.md"],
  });
  expect(resolveEffectiveAgentDocs(join(root, ".smithers"))).toEqual(["AGENTS.md"]);

  initWorkflowPack({ ...options, selectedAgentDocs: null });
  expect(JSON.parse(readFileSync(selectionsPath, "utf8"))).toEqual({
    deselectedAgentDocs: ["CLAUDE.md"],
  });

  rmSync(selectionsPath);
  mkdirSync(selectionsPath);
  expect(() => initWorkflowPack({ ...options, selectedAgentDocs: [] })).not.toThrow();
});

test("re-init reports drift, preserves user files, and applies selected updates", () => {
  const root = tempProject();
  const options = baseOptions(root);
  initWorkflowPack(options);
  const pack = join(root, ".smithers");
  const packagePath = join(pack, "package.json");
  const agentPath = join(pack, "agents", "codex.ts");
  writeFileSync(packagePath, '{"customized":true}\n', "utf8");
  writeFileSync(agentPath, "// user-owned agent\n", "utf8");
  rmSync(join(pack, "bunfig.toml"));
  mkdirSync(join(pack, "bunfig.toml"));

  const skipped = [];
  let scaffolded;
  const result = initWorkflowPack({
    ...options,
    reporter: {
      onSkip: (path) => skipped.push(path),
      scaffolded: (counts) => {
        scaffolded = counts;
      },
    },
  });

  expect(result.preservedPaths).toEqual([join(pack, "executions")]);
  expect(result.changedFiles.map((file) => file.path)).toContain(".smithers/package.json");
  expect(result.changedFiles.map((file) => file.path)).not.toContain(".smithers/bunfig.toml");
  expect(skipped).toContain(".smithers/agents/codex.ts");
  expect(scaffolded.preservedCount).toBe(1);
  expect(scaffolded.skippedCount).toBeGreaterThan(0);

  const packageUpdate = result.changedFiles.find((file) => file.path === ".smithers/package.json");
  const extraUpdate = {
    absolutePath: join(pack, "nested", "generated.txt"),
    contents: "generated\n",
  };
  expect(applyWorkflowPackUpdates([packageUpdate, extraUpdate])).toEqual([packagePath, extraUpdate.absolutePath]);
  expect(readFileSync(packagePath, "utf8")).toBe(packageUpdate.contents);
  expect(readFileSync(extraUpdate.absolutePath, "utf8")).toBe("generated\n");

  rmSync(join(pack, "bunfig.toml"), { recursive: true });
  writeFileSync(packagePath, '{"force-me":true}\n', "utf8");
  initWorkflowPack({ ...options, force: true, reporter: {} });
  expect(readFileSync(packagePath, "utf8")).toBe(packageUpdate.contents);
  expect(readFileSync(agentPath, "utf8")).toBe("// user-owned agent\n");
});

test("preserved-file skips fall back to stderr without a reporter", () => {
  const root = tempProject();
  const options = baseOptions(root, { agentsOnly: true });
  initWorkflowPack(options);
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  onTestFinished(() => stderr.mockRestore());

  initWorkflowPack(options);
  expect(stderr).toHaveBeenCalled();
  expect(String(stderr.mock.calls[0][0])).toContain("skipped: already exists");
});

test("agents-only custom scaffolding writes only agents and an empty manifest", () => {
  const root = tempProject();
  const result = initWorkflowPack(baseOptions(root, { agentsOnly: true, scaffoldCustomAgent: true }));
  const pack = join(root, ".smithers");

  expect(result.install).toEqual({ status: "skipped", reason: "agents-only" });
  expect(existsSync(join(pack, "agents", "custom.ts"))).toBe(true);
  expect(readFileSync(join(pack, "agents", "index.ts"), "utf8")).toContain('export { CustomAgent } from "./custom";');
  expect(loadManifest(join(pack, "smithers.toon")).contents).toEqual({ workflows: [], ui: [] });
  expect(existsSync(join(pack, "package.json"))).toBe(false);
});

test("global init writes directly to SMITHERS_HOME without touching project gitignore", () => {
  const root = tempProject();
  const smithersHome = join(root, "global-home");
  mkdirSync(join(root, ".git"));
  const result = initWorkflowPack(
    baseOptions(root, {
      global: true,
      env: seededAgentEnv(root, { SMITHERS_HOME: smithersHome }),
    }),
  );

  expect(result.rootDir).toBe(smithersHome);
  expect(existsSync(join(smithersHome, "package.json"))).toBe(true);
  expect(existsSync(join(smithersHome, ".smithers"))).toBe(false);
  expect(existsSync(join(root, ".gitignore"))).toBe(false);
  expect(result.gitignore).toBeUndefined();
});

test("root gitignore handles non-newline files, existing markers, and filesystem errors", () => {
  const root = tempProject();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".gitignore"), "dist/", "utf8");
  expect(ensureRootGitignore(root).status).toBe("updated");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("dist/\n\n# Smithers");
  expect(ensureRootGitignore(root).status).toBe("unchanged");

  writeFileSync(join(root, ".gitignore"), "./smithers.db*\n", "utf8");
  expect(ensureRootGitignore(root).status).toBe("unchanged");

  rmSync(join(root, ".gitignore"));
  mkdirSync(join(root, ".gitignore"));
  const failed = ensureRootGitignore(root);
  expect(failed.status).toBe("skipped");
  expect(failed.reason).toBeTruthy();
});

test("bun install reports ENOENT and non-zero exits with captured output", () => {
  const missingRoot = tempProject("smithers-install-missing-");
  const emptyPath = join(missingRoot, "empty-path");
  mkdirSync(emptyPath);
  const calls = [];
  const missing = withProcessPath(emptyPath, () =>
    initWorkflowPack({
      ...baseOptions(missingRoot),
      skipInstall: false,
      reporter: {
        installStart: () => calls.push("start"),
        installDone: (result, captured) => calls.push({ result, captured }),
      },
    }),
  );
  expect(missing.install.status).toBe("failed");
  expect(missing.install.reason).toContain("not found on PATH");
  expect(calls[0]).toBe("start");
  expect(calls[1].captured).toEqual({ stdout: "", stderr: "" });

  const failedRoot = tempProject("smithers-install-failed-");
  const binDir = join(failedRoot, "bun-bin");
  writeExecutable(join(binDir, "bun"), '#!/bin/sh\nprintf "captured-out"\nprintf "captured-err" >&2\nexit 7\n');
  let done;
  const failed = withProcessPath(binDir, () =>
    initWorkflowPack({
      ...baseOptions(failedRoot),
      skipInstall: false,
      reporter: {
        installDone: (result, captured) => {
          done = { result, captured };
        },
      },
    }),
  );
  expect(failed.install.reason).toContain("status 7");
  expect(done.result).toEqual(failed.install);
  expect(done.captured).toEqual({ stdout: "captured-out", stderr: "captured-err" });
});

test("bun install success links the local runtime and supports inherited stdio", () => {
  const root = tempProject("smithers-install-ok-");
  const binDir = join(root, "bun-bin");
  writeExecutable(join(binDir, "bun"), "#!/bin/sh\n/bin/mkdir -p node_modules/smthrs\nexit 0\n");
  const result = withProcessPath(binDir, () =>
    initWorkflowPack({
      ...baseOptions(root),
      skipInstall: false,
    }),
  );
  const runtimeLink = join(root, ".smithers", "node_modules", "smthrs");
  expect(result.install).toEqual({ status: "ok" });
  expect(lstatSync(runtimeLink).isSymbolicLink()).toBe(true);
  expect(realpathSync(runtimeLink)).toBe(realpathSync(LOCAL_RUNTIME));

  const quietRoot = tempProject("smithers-install-quiet-");
  const quietBin = join(quietRoot, "bun-bin");
  writeExecutable(join(quietBin, "bun"), "#!/bin/sh\nexit 0\n");
  let captured;
  const quiet = withProcessPath(quietBin, () =>
    initWorkflowPack({
      ...baseOptions(quietRoot),
      skipInstall: false,
      reporter: {
        installDone: (_install, output) => {
          captured = output;
        },
      },
    }),
  );
  expect(quiet.install).toEqual({ status: "ok" });
  expect(captured).toEqual({ stdout: "", stderr: "" });
});

test("bun install reports local-runtime link failures and unknown statuses", () => {
  const linkRoot = tempProject("smithers-install-link-failure-");
  const binDir = join(linkRoot, "bun-bin");
  writeExecutable(join(binDir, "bun"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(linkRoot, ".smithers"), { recursive: true });
  writeFileSync(join(linkRoot, ".smithers", "node_modules"), "not a directory", "utf8");
  const linkFailure = withProcessPath(binDir, () =>
    initWorkflowPack({
      ...baseOptions(linkRoot),
      skipInstall: false,
      reporter: {},
    }),
  );
  expect(linkFailure.install.status).toBe("failed");
  expect(linkFailure.install.reason).toContain("linking the local source runtime failed");

  const permissionRoot = tempProject("smithers-install-permission-");
  const permissionBin = join(permissionRoot, "bun-bin");
  mkdirSync(permissionBin);
  writeExecutable(join(permissionBin, "bun"), "#!/bin/sh\nkill -9 $$\n");
  const unknown = withProcessPath(permissionBin, () =>
    initWorkflowPack({
      ...baseOptions(permissionRoot),
      skipInstall: false,
      reporter: {},
    }),
  );
  expect(unknown.install.reason).toContain("status unknown");
});

test("skill and agent-doc callbacks honor explicit and persisted selections", () => {
  const root = tempProject("smithers-pack-skill-");
  const home = join(root, "home");
  const sourceDir = join(root, "skill-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "SKILL.md"), "# Test skill\n", "utf8");
  writeFileSync(join(sourceDir, "llms-full.txt"), "Test docs\n", "utf8");
  writeFileSync(join(root, "AGENTS.md"), "# Existing rules\n", "utf8");
  const callbacks = [];

  const explicit = initWorkflowPack({
    ...baseOptions(root, {
      installSkill: true,
      selectedSkillTargets: [],
      selectedAgentDocs: ["AGENTS.md"],
      skillOptions: { homeDir: home, sourceDir, detections: [] },
      reporter: {
        skillInstalled: () => callbacks.push("skill"),
        agentDocsNoted: () => callbacks.push("docs"),
      },
    }),
  });
  expect(explicit.skill).toBeDefined();
  expect(explicit.agentDocs).toBeDefined();
  expect(callbacks).toEqual(["skill", "docs"]);
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("Smithers workflows");
  expect(JSON.parse(readFileSync(join(home, ".smithers", "skill-deselections.json"), "utf8")).optedOut).toEqual(
    skillTargets(home).map((target) => target.id),
  );

  saveSkillDeselections(home, ["claude"]);
  const persistedRoot = tempProject("smithers-pack-skill-persisted-");
  const persisted = initWorkflowPack({
    ...baseOptions(persistedRoot, {
      installSkill: true,
      skillOptions: { homeDir: home, sourceDir, detections: [] },
    }),
  });
  expect(persisted.skill.skipped.map((entry) => entry.agent)).not.toContain("Claude Code");
});

test("skill deselection persistence failures do not block init", () => {
  const root = tempProject("smithers-pack-skill-error-");
  const home = join(root, "home");
  const sourceDir = join(root, "skill-source");
  mkdirSync(home, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(home, ".smithers"), "not a directory", "utf8");
  writeFileSync(join(sourceDir, "SKILL.md"), "# Test skill\n", "utf8");
  writeFileSync(join(sourceDir, "llms-full.txt"), "Test docs\n", "utf8");

  const result = initWorkflowPack({
    ...baseOptions(root, {
      installSkill: true,
      selectedSkillTargets: [],
      skillOptions: { homeDir: home, sourceDir, detections: [] },
    }),
  });
  expect(result.skill).toBeDefined();
});
