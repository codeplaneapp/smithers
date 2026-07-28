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
// model and must never regress to the retired `smithers-orchestrator` JSX/Ralph
// skill that pushed agents into read-only plan mode.
test("canonical skill carries the current frontmatter, not the retired orchestrator skill", () => {
  const skill = readRepoFile("skills/smithers/SKILL.md");
  const frontmatter = skill.slice(0, skill.indexOf("\n---", 4) + 4);

  expect(frontmatter).toContain("name: smithers\n");
  expect(frontmatter).not.toContain("name: smithers-orchestrator");
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
  expect(skill).toContain("renderWorkflow` from `smithers-orchestrator/testing");
  expect(skill).toContain(".smithers/tests/hello.test.tsx");
  expect(skill).toContain("./tests/hello.test.tsx");
  expect(skill).toContain("expected node ids");
  expect(skill).toContain("expected order");
  expect(skill).toContain("outputSchema");
  expect(skill).toContain("branches and loops");
  expect(skill).toContain("floor");
  expect(skill).toContain("never substitutes for the registered test");
});

// Agents were overengineering large single-goal asks (make CI green, repo-wide
// docs audits, dependency upgrades) into full workflows. The skill must keep
// routing those to `smithers oneshot`: the scale claim (one strong agent
// one-shots up to ~300k tokens, proven by real /goal prompts) and the
// shape-not-size rule. The oneshot-routing eval suite pins the behavior
// end-to-end; this pins the wording that makes it pass.
test("skill routes large single-goal asks to oneshot, not workflows", () => {
  const skill = readRepoFile("skills/smithers/SKILL.md");

  expect(skill).toContain("Size does not pick the route; shape does.");
  expect(skill).toMatch(/roughly 300k\s+tokens/);
  // The old caps that pushed anything big into workflow authoring. (The skill
  // may still MENTION context windows to refute them as a routing reason.)
  expect(skill).not.toContain("fits in roughly 100k tokens");
  expect(skill).not.toMatch(/finish\s+in one context window/);
  // The plugin skill must carry the same routing doctrine (it had none).
  const plugin = readRepoFile("claude-plugin/skills/smithers/SKILL.md");
  expect(plugin).toContain("smithers oneshot");
  expect(plugin).toContain("Size does not pick the route; shape does.");
  expect(plugin).toMatch(/roughly 300k\s+tokens/);
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
