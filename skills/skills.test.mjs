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
import * as Agents from "../packages/cli/src/Agents.ts";
import * as Unsupported from "../packages/cli/src/Unsupported.ts";
import * as Verb from "../packages/cli/src/Verb.ts";
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
 * Every alias rc-contract section 4.2 keeps. Naming one of these is correct,
 * not a defect: `inspect`, `why`, `events`, `resume`, `gateway`, and
 * `workflow list` all still resolve.
 */
const ALIASES = Verb.shipped.flatMap((entry) => entry.aliases);

/**
 * `smithers <verb>` for every verb the CLI itself registers as removed.
 *
 * Read from `Unsupported.removedVerbs` rather than copied, because a
 * hand-copied list drifts: the copy this replaced called `smithers inspect`
 * removed, when it is a surviving alias of `status`. A group verb contributes
 * its removed subcommands, not its bare name, so `workflow list` (an alias of
 * `ls`) is not swept up with `workflow run`.
 */
const REMOVED_VERBS = Unsupported.removedVerbs.flatMap((entry) =>
  entry.subcommands === undefined
    ? [`smithers ${entry.name}`]
    : entry.subcommands.map((subcommand) => `smithers ${entry.name} ${subcommand}`)
);

/**
 * The 0.x flags, JSX APIs, and pack paths 1.0 removed. These have no CLI table
 * to read: PLAN.md Phase 1 deleted them from the tree.
 */
const REMOVED_APIS = [
  "ask-human",
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

/**
 * Verbs, flags, and APIs 1.0 removed. A curated skill that names one teaches an
 * agent to run something that exits 1 with a migration message.
 */
const REMOVED = [...REMOVED_VERBS, ...REMOVED_APIS];

/**
 * Whether a document names one removed token as a whole token.
 *
 * Substring matching reads `smithers logs` as the removed alias
 * `smithers log`, so the boundary is what separates a real defect from a
 * shipped verb that starts the same way.
 */
const names = (text, removed) =>
  new RegExp(`${removed.replaceAll(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![A-Za-z0-9_-])`).test(text);

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
          assert.ok(!names(text, removed), `${name}/SKILL.md still names "${removed}"`);
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

  /** The rows of the on-ramp's command table, which is where a verb has to appear. */
  const commandTable = text
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .join("\n");

  it("treats no surviving alias as a removed verb", () => {
    // rc-contract section 4.2 keeps six aliases. A removed-verb list that
    // swept one up would fail every skill that documents it correctly.
    for (const alias of ALIASES) {
      assert.ok(
        !REMOVED_VERBS.includes(`smithers ${alias}`),
        `${alias} survives as an alias of a shipped verb, so it is not a removed verb`,
      );
    }
    assert.ok(ALIASES.includes("inspect") && ALIASES.includes("workflow list"), "the alias set must be non-empty");
  });

  it("documents every rc.0 verb that ships", () => {
    // Read from the CLI's own verb table, not restated here: a hand-copy is a
    // second source of truth that goes stale the first time cli-ops adds or
    // renames a verb, and the check would still pass. `resume`, `inspect`,
    // `why`, `events`, and `gateway` are aliases, documented beside the verbs
    // they alias; the two subcommands are named because the on-ramp teaches
    // them by name.
    for (const verb of [...Verb.shipped.map((entry) => entry.name), "skills add", "claude tick"]) {
      // The verb has to open a backticked span in a table row and end there:
      // a bare `includes("`run")` also matches `` `run_workflow` ``, so the
      // check passed on verbs the table never listed.
      const listed = new RegExp("`" + verb.replaceAll("-", "\\-") + "(?![A-Za-z0-9_-])");
      assert.ok(listed.test(commandTable), `the on-ramp's command table omits the verb ${verb}`);
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

  it("does not promise that the companion skills install themselves", () => {
    // rc-contract.md ruling F2: `skills add` writes the single curated
    // `smithers` skill. The README said the other four were "installed the
    // same way", which sends a reader to a command that never writes them.
    const readme = readFileSync(join(skillsRoot, "smithers/README.md"), "utf8");
    const companions = readme.split("## The companion skills")[1];
    assert.ok(companions !== undefined, "the README must say where the companion skills come from");
    assert.ok(
      !/installed the same way/.test(companions),
      "the README claims `skills add` installs the companion skills, and it does not",
    );
    assert.match(companions, /does\s+not install them/);
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
    // Ruling F2: one curated skill, and no per-verb set. 0.x wrote 64
    // `smithers-<verb>` directories here, and 43 of them scripted verbs 1.0
    // removed, so an agent that read them would run commands that exit 1.
    assert.deepEqual(
      readdirSync(join(home, ".claude", "skills")).sort(),
      ["smithers"],
      "`skills add` wrote something other than the single curated skill",
    );
  });

  it("installs this repository's curated source, byte for byte", (t) => {
    if (!hasSkillsVerb()) {
      t.skip("`smithers skills add` is not in this CLI yet.");
      return;
    }
    // Pending cli-ops, not pending this lane. `packages/cli/**` is that lane's
    // fence (triage.md SPEC AMENDMENT 4, and the 2026-08-29 16:25 fence
    // ruling), so the fix ships as deferred hunk records 4 and 6 in
    // migration/phase4/pack-skills-plugins-deferred-hunks.{md,patch}:
    // `Agents.skill()` reads packages/cli/docs/SKILL.md, then this file, and
    // refuses rather than substituting a rendering of the verb table.
    //
    // The skip is gated on whether that code is PRESENT, never on whether the
    // install matched: a case that skips itself the moment its assertion would
    // fail pins nothing, and would call a wrong adoption "still renders the
    // verb table". Once `Agents.skillMissing` exists, the byte-identity
    // assertion below runs and any other installed content is a failure.
    if (typeof Agents.skillMissing !== "function") {
      t.skip(
        "`packages/cli/src/Agents.ts` has no `skillMissing`, so deferred hunk records 4 and 6 " +
          "(migration/phase4/pack-skills-plugins-deferred-hunks.patch) are not adopted yet. " +
          "rc-contract.md ruling F2 is met when they land, and this case then holds the install " +
          "to the curated file byte for byte.",
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

    const installed = readFileSync(join(home, ".claude", "skills", "smithers", "SKILL.md"), "utf8");
    const curated = readFileSync(join(skillsRoot, "smithers", "SKILL.md"), "utf8");
    assert.equal(installed, curated, "the installed skill must be this repository's curated source, byte for byte");
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
