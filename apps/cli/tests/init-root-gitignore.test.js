/**
 * Init must keep a user's repo clean: the sqlite run store (smithers.db*) is
 * created in the PROJECT root, outside `.smithers/`'s own scaffolded
 * .gitignore, so `initWorkflowPack` appends an ignore block to the project
 * root .gitignore (git or jj repos only, idempotently, respecting existing
 * rules).
 */
import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutableDir, writeFakeCodexBinary } from "../../../packages/smithers/tests/e2e-helpers.js";
import { ensureRootGitignore, initWorkflowPack } from "../src/workflow-pack.js";

function seededAgentEnv() {
  const binDir = createExecutableDir();
  writeFakeCodexBinary(binDir);
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    OPENAI_API_KEY: "sk-test-openai-key",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
}

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "smithers-gitignore-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("creates a .gitignore with the run-store block in a git repo without one", () => {
  const dir = tempProject();
  mkdirSync(join(dir, ".git"));
  const result = ensureRootGitignore(dir);
  expect(result.status).toBe("created");
  const contents = readFileSync(join(dir, ".gitignore"), "utf8");
  expect(contents).toContain("smithers.db");
  expect(contents).toContain("smithers.db-wal");
});

test("appends the block to an existing .gitignore exactly once", () => {
  const dir = tempProject();
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");
  expect(ensureRootGitignore(dir).status).toBe("updated");
  expect(ensureRootGitignore(dir).status).toBe("unchanged");
  const contents = readFileSync(join(dir, ".gitignore"), "utf8");
  expect(contents.startsWith("node_modules/\n")).toBe(true);
  expect(contents.match(/smithers\.db$/gm)?.length).toBe(1);
});

test("respects an existing smithers.db or *.db rule", () => {
  const dir = tempProject();
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".gitignore"), "smithers.db\n", "utf8");
  expect(ensureRootGitignore(dir).status).toBe("unchanged");
  writeFileSync(join(dir, ".gitignore"), "*.db\n", "utf8");
  expect(ensureRootGitignore(dir).status).toBe("unchanged");
});

test("skips outside a git/jj repository", () => {
  const dir = tempProject();
  const result = ensureRootGitignore(dir);
  expect(result.status).toBe("skipped");
  expect(existsSync(join(dir, ".gitignore"))).toBe(false);
});

test("recognizes a jj-only repository", () => {
  const dir = tempProject();
  mkdirSync(join(dir, ".jj"));
  expect(ensureRootGitignore(dir).status).toBe("created");
});

test("initWorkflowPack ensures the root .gitignore and reports it", () => {
  const dir = tempProject();
  mkdirSync(join(dir, ".git"));
  /** @type {import("../src/workflow-pack.js").RootGitignoreResult | undefined} */
  let reported;
  const result = initWorkflowPack({
    rootDir: dir,
    installSkill: false,
    skipInstall: true,
    env: seededAgentEnv(),
    reporter: {
      gitignoreEnsured: (r) => {
        reported = r;
      },
    },
  });
  expect(result.gitignore?.status).toBe("created");
  expect(reported?.status).toBe("created");
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("smithers.db");
});

test("initWorkflowPack --agents-only leaves the root .gitignore alone", () => {
  const dir = tempProject();
  mkdirSync(join(dir, ".git"));
  const result = initWorkflowPack({
    rootDir: dir,
    agentsOnly: true,
    installSkill: false,
    skipInstall: true,
    env: seededAgentEnv(),
  });
  expect(result.gitignore).toBeUndefined();
  expect(existsSync(join(dir, ".gitignore"))).toBe(false);
});
