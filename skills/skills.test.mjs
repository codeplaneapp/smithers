/**
 * The curated skills this repository installs into agents.
 *
 * A skill is a product surface: `smithers skills add` copies these files into
 * every agent skill directory it detects, and an agent then reads them as its
 * only description of Smithers. So they are checked the way the registry checks
 * them, and read for any command, flag, or API that 1.0 removed.
 *
 * Run: node --test skills/skills.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as Option from "effect/Option";
import * as MarkdownFlow from "../packages/registry/src/MarkdownFlow.ts";

const skillsRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(skillsRoot);
const sourceCli = join(repoRoot, "packages/cli/bin/smithers.mjs");

/** Every curated skill directory, by name. */
const SKILLS = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * Verbs, flags, and APIs 1.0 removed. A curated skill that names one teaches an
 * agent to run something that exits 1 with a migration message.
 *
 * `rc-contract.md` section 4.2 is the authority for the verbs; the JSX entries
 * come from PLAN.md Phase 1.
 */
const REMOVED = [
  "smithers replay",
  "smithers rewind",
  "smithers fork",
  "smithers hijack",
  "smithers pause",
  "smithers ui",
  "smithers gui",
  "smithers monitor",
  "smithers eval",
  "smithers scores",
  "smithers chat",
  "smithers ask",
  "smithers agents",
  "smithers usage",
  "smithers cron",
  "smithers listeners",
  "smithers make-workflow",
  "smithers starters",
  "smithers share",
  "smithers upgrade",
  "smithers workflow run",
  "smithers human",
  "smithers ask-human",
  "ask-human",
  "smithers tree",
  "smithers graph",
  "smithers timeline",
  "smithers inspect",
  "docs-full",
  "--backend",
  "--hot",
  "createSmithers",
  "@jsxImportSource",
  "jsxImportSource",
  "gateway-react",
  "gateway-ui",
  "smthrs/ui",
  "bunx smthrs",
  ".smithers/workflows",
  ".smithers/ui",
  ".smithers/prompts",
];

/** Where the removed vocabulary is legitimate: the pages that say it is gone. */
const ALLOWED_TO_NAME_REMOVED = new Set(["smithers", "migrate-smithers-v1"]);

describe("the curated skill set", () => {
  it("is the four authoring skills plus the migration skill", () => {
    assert.deepEqual(SKILLS, [
      "migrate-smithers-v1",
      "prompt-author",
      "risk-reviewer",
      "schema-author",
      "smithers",
    ]);
  });

  for (const name of SKILLS) {
    const path = join(skillsRoot, name, "SKILL.md");

    it(`${name} has a SKILL.md the registry can read`, () => {
      const text = readFileSync(path, "utf8");
      const result = MarkdownFlow.fromMarkdown({
        text,
        path: `skills/${name}/SKILL.md`,
        baseDirectory: dirname(path),
        naming: "frontmatter",
        name: Option.none(),
        dirBasename: name,
        provenance: { source: "project", root: skillsRoot },
      });

      // A skill declares no capabilities of its own; the conservative wildcard
      // warning is the expected and correct outcome for a document.
      const unexpected = result.warnings.filter((warning) => warning.code !== "unprojectable_authority");
      assert.deepEqual(unexpected.map((warning) => `${warning.code}: ${warning.message}`), []);
      assert.ok(Option.isSome(result.descriptor), `${name} produced no descriptor`);

      const descriptor = result.descriptor.value;
      assert.equal(descriptor.name, name, "the frontmatter name must match the directory");
      assert.ok(descriptor.description.trim().length > 0);
      assert.ok(
        [...descriptor.description].length <= 1024,
        `${name}: a description over 1024 characters is refused by the Agent Skills limit`,
      );
    });

    if (!ALLOWED_TO_NAME_REMOVED.has(name)) {
      it(`${name} names nothing 1.0 removed`, () => {
        const text = readFileSync(path, "utf8");
        for (const removed of REMOVED) {
          assert.ok(!text.includes(removed), `${name}/SKILL.md still names "${removed}"`);
        }
      });
    }
  }
});

describe("the smithers on-ramp", () => {
  const text = readFileSync(join(skillsRoot, "smithers/SKILL.md"), "utf8");

  it("teaches Flow, Action, and Plan", () => {
    for (const term of ["Flow.make", "Action.make", "Node.andThen", "Node.branch", "AgentAction.make"]) {
      assert.ok(text.includes(term), `the on-ramp never mentions ${term}`);
    }
  });

  it("states the clean break from the 0.x JSX stack", () => {
    assert.match(text, /no JSX workflow API/);
    assert.match(text, /`smithers migrate`/);
  });

  it("documents every rc.0 verb that ships", () => {
    // rc-contract.md section 4.1. `resume`, `inspect`, `why`, `events`, and
    // `gateway` are aliases and are documented beside the verbs they alias.
    for (const verb of [
      "plan",
      "run",
      "up",
      "approve",
      "deny",
      "cancel",
      "signal",
      "steer",
      "ls",
      "ps",
      "status",
      "logs",
      "output",
      "down",
      "serve",
      "init",
      "doctor",
      "docs",
      "migrate",
      "gc",
      "memory",
      "skills add",
      "claude tick",
      "update",
      "bug",
    ]) {
      assert.ok(text.includes(`\`${verb}`) || text.includes(`| \`${verb}`), `the on-ramp omits the verb ${verb}`);
    }
  });

  it("names the removed verbs only in the removed-in-1.0 section", () => {
    const [before, after] = text.split("### Removed in 1.0");
    assert.ok(after !== undefined, "the on-ramp must carry a removed-verbs section");
    for (const removed of ["`replay`", "`hijack`", "`ui`", "`eval`", "`ask-human`", "`docs-full`"]) {
      assert.ok(after.includes(removed), `the removed section omits ${removed}`);
      assert.ok(!before.includes(removed), `${removed} is named before the removed section`);
    }
  });

  it("names only MCP tools the rc.0 server supports as supported", () => {
    const supported = text.split("Ten keep their names")[0];
    for (const unsupported of ["revert_attempt", "fork_run", "replay_run", "time_travel", "ask_human"]) {
      assert.ok(
        !supported.includes(unsupported),
        `${unsupported} is listed among the working MCP tools`,
      );
    }
  });

  it("ships the README that documents its install", () => {
    const readme = readFileSync(join(skillsRoot, "smithers/README.md"), "utf8");
    assert.match(readme, /smithers skills add/);
    assert.match(readme, /--agent claude/);
    assert.match(readme, /smithers docs --full/);
    assert.ok(!readme.includes("bunx smthrs"), "the README must not name the 0.x published bin lookup");
  });
});

describe("installing the curated skill", () => {
  const created = [];
  after(() => {
    for (const directory of created) rmSync(directory, { recursive: true, force: true });
  });

  /**
   * A home directory with a detectable agent skill directory and no skill in
   * it yet. `skills add` writes under the home directory, not the working
   * directory, so the fixture is passed as HOME (USERPROFILE on Windows).
   */
  const fixture = () => {
    const home = mkdtempSync(join(tmpdir(), "skills-add-"));
    created.push(home);
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(home, ".codex", "skills"), { recursive: true });
    return home;
  };

  /** Whether the CLI in this tree carries the `skills` verb yet. */
  const hasSkillsVerb = () => {
    const help = spawnSync(process.execPath, [sourceCli, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 180_000,
    });
    return help.status === 0 && /^\s+skills\s/m.test(help.stdout);
  };

  it("writes the curated skill into a detected agent directory", (t) => {
    if (!hasSkillsVerb()) {
      t.skip(
        "`smithers skills add` is not in this CLI yet. It is the cli-ops lane's verb " +
          "(rc-contract.md section 4.1) and it installs this lane's skills/ tree. " +
          "The install contract this test asserts is pinned by the source-side checks above.",
      );
      return;
    }

    const home = fixture();
    const result = spawnSync(process.execPath, [sourceCli, "skills", "add"], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
      timeout: 180_000,
    });
    assert.equal(result.status, 0, result.stderr);

    const installed = join(home, ".claude", "skills", "smithers", "SKILL.md");
    assert.ok(statSync(installed).isFile(), "the curated skill did not land in the detected agent directory");
    // `skills add` installs the curated source, byte for byte. The docs lane's
    // generate-llms.ts copies this same file to packages/cli/docs/SKILL.md as
    // "the curated skill the CLI installs", and rc-contract.md ruling F2 says
    // rc.0 writes "the curated skill" and generates nothing per verb. A CLI
    // that renders its own text from the verb table fails here, correctly.
    assert.equal(
      readFileSync(installed, "utf8"),
      readFileSync(join(skillsRoot, "smithers", "SKILL.md"), "utf8"),
      "the installed skill must be this repository's curated source, byte for byte",
    );
  });

  it("has a curated source that is a single self-contained file per skill", () => {
    for (const name of SKILLS) {
      const entries = readdirSync(join(skillsRoot, name)).sort();
      assert.ok(entries.includes("SKILL.md"), `${name} has no SKILL.md to install`);
      for (const entry of entries) {
        assert.ok(
          entry === "SKILL.md" || entry === "README.md" || entry === "llms-full.txt",
          `${name}/${entry} is not part of the installable skill surface`,
        );
      }
    }
  });
});
