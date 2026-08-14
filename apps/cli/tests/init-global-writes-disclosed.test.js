import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { initOptions } from "../src/init-command.js";
import { skillTargets } from "../src/installCuratedSkill.js";

// `smithers init` reads as a project-local command but installs the curated
// skill into machine-wide agent directories. That side effect has to be stated
// where an operator looks before running it: `--help` and the docs (#1464
// AWF-8).

/** The `--skill` flag's help text, as `smithers init --help` renders it. */
function skillHelpText() {
  const shape = /** @type {any} */ (initOptions).shape ?? /** @type {any} */ (initOptions)._def?.shape?.();
  const description = shape?.skill?.description ?? shape?.skill?._def?.description;
  expect(typeof description).toBe("string");
  return /** @type {string} */ (description);
}

test("init --help states that the curated skill is written outside the project", () => {
  const help = skillHelpText();
  expect(help).toMatch(/outside the project/i);
  expect(help).toMatch(/--no-skill/);
});

test("init --help names every global skills directory init writes to", () => {
  const help = skillHelpText();
  const home = homedir();
  const disclosed = new Set(help.match(/~\/[\w./-]+/g) ?? []);
  for (const target of skillTargets(home)) {
    const tilde = `~${target.skillsDir.slice(home.length)}/smithers`;
    expect({ agent: target.id, path: tilde, disclosed: disclosed.has(tilde) }).toEqual({
      agent: target.id,
      path: tilde,
      disclosed: true,
    });
  }
});

test("the init workflow docs page lists the global skill directories", () => {
  const docs = readFileSync(fileURLToPath(new URL("../../../docs/workflows/init.mdx", import.meta.url)), "utf8");
  expect(docs).toMatch(/outside the project/i);
  const home = homedir();
  for (const target of skillTargets(home)) {
    const tilde = `~${target.skillsDir.slice(home.length)}/smithers`;
    expect({ agent: target.id, documented: docs.includes(tilde) }).toEqual({ agent: target.id, documented: true });
  }
  expect(docs).toMatch(/--no-skill/);
});
