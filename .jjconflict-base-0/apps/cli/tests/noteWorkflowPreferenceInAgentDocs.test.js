// Unit tests for noteWorkflowPreferenceInAgentDocs — the helper that makes
// `smithers init` append "when to use smithers.sh workflows" guidance to a
// project's existing CLAUDE.md / AGENTS.md so the coding agent knows when to
// reach for durable workflows vs plain subagents.

import { expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { noteWorkflowPreferenceInAgentDocs } from "../src/noteWorkflowPreferenceInAgentDocs.js";

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "smithers-agent-docs-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function statusFor(summary, name) {
  return summary.files.find((file) => file.path.endsWith(name))?.status;
}

test("appends the guidance block to an existing CLAUDE.md", () => {
  const root = makeSandbox();
  const path = join(root, "CLAUDE.md");
  writeFileSync(path, "# My project\n\nExisting instructions.\n");

  const summary = noteWorkflowPreferenceInAgentDocs({ projectRoot: root });

  expect(statusFor(summary, "CLAUDE.md")).toBe("updated");
  const contents = readFileSync(path, "utf8");
  expect(contents).toContain("# My project");
  expect(contents).toContain("Existing instructions.");
  expect(contents).toContain("Smithers workflows");
  expect(contents).toContain("best judgment");
  expect(contents).toContain("multi-step plans");
  expect(contents).toContain("reusable smithers workflow");
  expect(contents).toContain("smithers workflow run <id>");
});

test("edits both CLAUDE.md and AGENTS.md when both exist", () => {
  const root = makeSandbox();
  writeFileSync(join(root, "CLAUDE.md"), "# Claude\n");
  writeFileSync(join(root, "AGENTS.md"), "# Agents\n");

  const summary = noteWorkflowPreferenceInAgentDocs({ projectRoot: root });

  expect(statusFor(summary, "CLAUDE.md")).toBe("updated");
  expect(statusFor(summary, "AGENTS.md")).toBe("updated");
  expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("Smithers workflows");
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("Smithers workflows");
});

test("matches the doc filename case-insensitively (agents.md)", () => {
  const root = makeSandbox();
  const path = join(root, "agents.md");
  writeFileSync(path, "# lowercase agents\n");

  const summary = noteWorkflowPreferenceInAgentDocs({ projectRoot: root });

  expect(summary.files).toHaveLength(1);
  expect(summary.files[0].status).toBe("updated");
  expect(readFileSync(path, "utf8")).toContain("Smithers workflows");
});

test("preserves the original content above the appended block", () => {
  const root = makeSandbox();
  const path = join(root, "CLAUDE.md");
  const original = "# Project\n\nLine one.\n";
  writeFileSync(path, original);

  noteWorkflowPreferenceInAgentDocs({ projectRoot: root });

  expect(readFileSync(path, "utf8").startsWith(original)).toBe(true);
});

test("does nothing when no agent doc exists (never creates one)", () => {
  const root = makeSandbox();

  const summary = noteWorkflowPreferenceInAgentDocs({ projectRoot: root });

  expect(summary.files).toHaveLength(0);
  expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
  expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
});

test("is idempotent — re-running does not duplicate the block", () => {
  const root = makeSandbox();
  const path = join(root, "CLAUDE.md");
  writeFileSync(path, "# Project\n");

  const first = noteWorkflowPreferenceInAgentDocs({ projectRoot: root });
  const afterFirst = readFileSync(path, "utf8");
  const second = noteWorkflowPreferenceInAgentDocs({ projectRoot: root });
  const afterSecond = readFileSync(path, "utf8");

  expect(first.files[0].status).toBe("updated");
  expect(second.files[0].status).toBe("already-present");
  expect(afterSecond).toBe(afterFirst);
  expect(afterSecond.split("## Smithers workflows").length - 1).toBe(1);
});

test("edits a symlinked alias only once (AGENTS.md -> CLAUDE.md)", () => {
  const root = makeSandbox();
  writeFileSync(join(root, "CLAUDE.md"), "# Shared\n");
  symlinkSync(join(root, "CLAUDE.md"), join(root, "AGENTS.md"));

  noteWorkflowPreferenceInAgentDocs({ projectRoot: root });

  const contents = readFileSync(join(root, "CLAUDE.md"), "utf8");
  // Both names point at one inode; the block must appear exactly once.
  expect(contents.split("## Smithers workflows").length - 1).toBe(1);
});

test("separates cleanly from content that does not end in a newline", () => {
  const root = makeSandbox();
  const path = join(root, "CLAUDE.md");
  writeFileSync(path, "no trailing newline");

  noteWorkflowPreferenceInAgentDocs({ projectRoot: root });

  expect(readFileSync(path, "utf8")).toContain(
    "no trailing newline\n\n<!-- smithers:prefer-workflows START -->",
  );
});

test("honors a custom fileNames list", () => {
  const root = makeSandbox();
  writeFileSync(join(root, "CLAUDE.md"), "# Claude\n");
  writeFileSync(join(root, "GEMINI.md"), "# Gemini\n");

  const summary = noteWorkflowPreferenceInAgentDocs({ projectRoot: root, fileNames: ["GEMINI.md"] });

  expect(summary.files).toHaveLength(1);
  expect(summary.files[0].path.endsWith("GEMINI.md")).toBe(true);
  expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).not.toContain("Smithers workflows");
});
