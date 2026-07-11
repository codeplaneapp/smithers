import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const FORMER = ["vcs","implement","research-plan-implement","review","plan","research","ticket-create","tickets-create","ralph","improve-test-coverage","debug","grill-me","feature-enum","audit","mission","workflow-skill","kanban","hello","context-engineer","route-task","extract-skill","triage-run","context-doctor","backpressure-plan","eval-author","report-slideshow","smithering","delegation-chain","make-workflow-tutorial"];

test("former init workflows remain represented as documented copyable examples", () => {
  const inventory = readFileSync(resolve(ROOT, "examples/init-pack/README.md"), "utf8");
  for (const id of FORMER) {
    const example = resolve(ROOT, "examples/init-pack", `${id}.tsx`);
    expect(existsSync(example), `${id} lost its example`).toBe(true);
    const source = readFileSync(example, "utf8");
    expect(source.startsWith("// Example only:")).toBe(true);
    expect(source).not.toContain(`export { default } from "../../.smithers/workflows/${id}.tsx"`);
    expect(source).toContain("default init pack");
    expect(source).toContain("smithers graph examples/init-pack/");
    expect(inventory).toContain(`| ${id} |`);
  }
});
