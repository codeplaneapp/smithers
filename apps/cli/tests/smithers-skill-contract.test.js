import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

function readRepoFile(path) {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

// The packaged CLI copies are generated verbatim from the canonical skill by
// `bun scripts/generate-llms.ts`. If they drift, `smithers init` ships a stale
// skill — exactly the bug where an old plugin copy taught the wrong (JSX/Ralph,
// plan-mode) mental model and agents described instead of acted. This guard
// fails loudly the moment a copy diverges; fix it by re-running `pnpm docs:llms`.
test("packaged CLI skill copy is byte-identical to the canonical skill", () => {
  const canonical = readRepoFile("skills/smithers/SKILL.md");
  const packaged = readRepoFile("apps/cli/docs/SKILL.md");
  expect(packaged).toBe(canonical);
});

test("packaged CLI llms-full bundle is byte-identical to the skill-bundled copy", () => {
  const bundled = readRepoFile("skills/smithers/llms-full.txt");
  const packaged = readRepoFile("apps/cli/docs/llms-full.txt");
  expect(packaged).toBe(bundled);
});

// Freshness contract: the canonical skill must stay on the current control-plane
// model and must never regress to the retired `smthrs` JSX/Ralph
// skill that pushed agents into read-only plan mode.
test("canonical skill carries the current frontmatter, not the retired orchestrator skill", () => {
  const skill = readRepoFile("skills/smithers/SKILL.md");
  const frontmatter = skill.slice(0, skill.indexOf("\n---", 4) + 4);

  expect(frontmatter).toContain("name: smithers\n");
  expect(frontmatter).not.toContain("name: smthrs");
  // The retired skill recommended plan mode in frontmatter; plan mode is
  // read-only, which is what made agents narrate instead of write the file.
  expect(skill).not.toContain("recommend-plan-mode");
  // Tutorial-era framing that taught the wrong mental model.
  expect(skill).not.toContain("Ralph Wiggum Loop");
});

// The exact failure this skill guards against: an agent asked to "create a
// Smithers workflow" prints how-to prose (or stops in plan mode) instead of
// invoking its tools. The "Do it - don't describe it" section must survive doc
// edits, so assert its load-bearing instructions are present.
test("skill contains the execute-don't-describe imperative", () => {
  const skill = readRepoFile("skills/smithers/SKILL.md");

  expect(skill).toContain("Do it - don't describe it");
  expect(skill).toContain("Describing the work is not the work.");
  // Names the concrete create-a-workflow action and forbids the plan-mode trap.
  expect(skill).toMatch(/\.smithers\/workflows\/<id>\.tsx/);
  expect(skill).toContain("Don't stall in read-only plan mode.");
  // The on-ramp must show the author-then-render path agents are expected to run.
  expect(skill).toContain("smithers workflow create");
  expect(skill).toContain("smithers graph .smithers/workflows/");
});

test("skill makes workflow tests an indivisible registered authoring rule", () => {
  const skill = readRepoFile("skills/smithers/SKILL.md");

  expect(skill).toContain("A workflow and its tests are one indivisible change");
  expect(skill).toContain("renderWorkflow` from `smthrs/testing");
  expect(skill).toContain(".smithers/tests/hello.test.tsx");
  expect(skill).toContain("./tests/hello.test.tsx");
  expect(skill).toContain("expected node ids");
  expect(skill).toContain("expected order");
  expect(skill).toContain("outputSchema");
  expect(skill).toContain("branches and loops");
  expect(skill).toContain("floor");
  expect(skill).toContain("never substitutes for the registered test");
});

// `smithers oneshot` was removed. No skill may keep routing agents to it.
test("skills no longer route to the removed oneshot command", () => {
  for (const path of [
    "skills/smithers/SKILL.md",
    "claude-plugin/skills/smithers/SKILL.md",
    "codex-plugin/skills/smithers/SKILL.md",
  ]) {
    expect(readRepoFile(path), path).not.toMatch(/oneshot/i);
  }
});

test("smithers skill documents current agents command and LoopUntilScored source", () => {
  const skill = readRepoFile("skills/smithers/SKILL.md");

  expect(skill).toContain("accounts with `smithers agents add|list|remove`.");
  expect(skill).not.toContain("smithers agent add|list|remove");

  const boxComponentList = skill.match(/More ship in the box \(([^)]+)\)/s)?.[1] ?? "";
  expect(boxComponentList).toContain("<CheckSuite>");
  expect(boxComponentList).not.toContain("<LoopUntilScored>");

  const seededComponentsLayout = skill.slice(skill.indexOf("├── components/"), skill.indexOf("├── ui/"));
  expect(seededComponentsLayout).toContain("LoopUntilScored");
  expect(seededComponentsLayout).toMatch(/seeded local-pack/i);
});

// Bug 01kzweq27e2645ty9x5yezkrwk: a review node dispatched a codex agent whose
// harness had this skill installed. The "route any clear single-goal ask through
// smithers" rule hijacked the node's own prompt — the agent launched a CHILD
// run, polled `smithers status` in a sleep loop for ~30 minutes, then edited
// the tree it was told to review. Smithers now sets SMITHERS_INSIDE_RUN on every
// agent it spawns; every skill that teaches orchestration must state the guard
// FIRST, ahead of the routing rules it overrides.
const ORCHESTRATION_SKILLS = [
  "skills/smithers/SKILL.md",
  "apps/cli/docs/SKILL.md",
  "codex-plugin/skills/smithers/SKILL.md",
  "claude-plugin/skills/smithers/SKILL.md",
  "apps/cli/src/hermes-plugin/skills/orchestrate/SKILL.md",
  "apps/cli/src/openclaw-plugin/skills/orchestrate/SKILL.md",
];

test.each(ORCHESTRATION_SKILLS)("%s guards against recursing into Smithers from inside a node", (path) => {
  const skill = readRepoFile(path);

  expect(skill).toContain("SMITHERS_INSIDE_RUN");
  expect(skill).toMatch(/if you are already inside a smithers run, do not use smithers/i);
  // The guard must come before the routing rules it overrides, or an agent that
  // reads top-down acts on "route this through smithers" first.
  const guardIndex = skill.search(/##[^\n]*already inside a Smithers run/i);
  const routingIndex = skill.search(/^##[^\n]*(Right-size the route|Route first|Default)/im);
  expect(guardIndex).toBeGreaterThan(-1);
  expect(routingIndex).toBeGreaterThan(guardIndex);
});

// The body only reaches the model once the skill is invoked; the frontmatter
// description is in context from the first turn. An agent that acts on the
// description alone reads "you are an ORCHESTRATOR, route this through
// Smithers" and recurses without ever loading the guard section above, which is
// how the bug reproduced. The guard has to be in both places.
test.each(ORCHESTRATION_SKILLS)("%s states the guard in its frontmatter description", (path) => {
  const frontmatter = readRepoFile(path).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

  expect(frontmatter).toContain("SMITHERS_INSIDE_RUN");
});
