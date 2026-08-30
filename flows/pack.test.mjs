/**
 * The migration pack inputs, checked against the real registry and the real
 * migration detector.
 *
 * These files are data for two consumers that do not exist yet: the Phase 6
 * `migrate-smithers-v1` flow body, and the init pack. Data that nothing runs
 * rots silently, so this suite runs the registry over the prompt bodies and the
 * detector over the fixture, both through their production entry points.
 *
 * Run: node --test flows/pack.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Capability from "../packages/capability/src/Capability.ts";
import * as Discovery from "../packages/registry/src/Discovery.ts";
import * as MarkdownFlow from "../packages/registry/src/MarkdownFlow.ts";
import * as Detect from "../packages/migrate/src/Detect.ts";

const flowsRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(flowsRoot);
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(platform)));

/** The ten prompt bodies this lane stages, by their path-derived flow name. */
const EXPECTED_FLOWS = [
  "create-flow/clarify",
  "create-flow/design",
  "create-flow/document",
  "create-flow/fix",
  "create-flow/provision",
  "create-flow/scaffold",
  "create-skill/clarify",
  "create-skill/design",
  "create-skill/document",
  "create-skill/scaffold",
];

const FIXTURE = "migrate-smithers-v1/test/fixtures/smithers-0x-hello";

/** Every `flow.mdx` under `flows/`, as repository-relative POSIX paths. */
function markdownFlows(directory = flowsRoot) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      found.push(...markdownFlows(full));
    } else if (entry.name === "flow.mdx") {
      found.push(full);
    }
  }
  return found;
}

describe("the staged prompt bodies", () => {
  const files = markdownFlows();

  it("are the ten create-flow and create-skill bodies", () => {
    assert.deepEqual(
      files.map((file) => relative(flowsRoot, dirname(file)).split("\\").join("/")).sort(),
      EXPECTED_FLOWS,
    );
  });

  for (const file of files) {
    const name = relative(flowsRoot, dirname(file)).split("\\").join("/");

    it(`${name} loads through MarkdownFlow with no warnings`, () => {
      const text = readFileSync(file, "utf8");
      const result = MarkdownFlow.fromMarkdown({
        text,
        path: relative(repoRoot, file).split("\\").join("/"),
        baseDirectory: dirname(file),
        naming: "path",
        name: Option.some(name),
        dirBasename: name.split("/").pop(),
        provenance: { source: "project", root: flowsRoot },
      });

      assert.deepEqual(
        result.warnings.map((warning) => `${warning.code}: ${warning.message}`),
        [],
      );
      assert.ok(Option.isSome(result.descriptor), `${name} produced no descriptor`);

      const descriptor = result.descriptor.value;
      assert.equal(descriptor.name, name);
      assert.ok(descriptor.description.length > 0);
      assert.ok(
        [...descriptor.description].length <= 1024,
        "a description over 1024 characters is refused by the Agent Skills limit",
      );
      assert.equal(descriptor.input._tag, "MarkdownArgs");
      assert.equal(descriptor.output._tag, "MarkdownOutput");
    });

    it(`${name} renders a prompt that carries its body and the caller's arguments`, () => {
      const body = MarkdownFlow.loadBody(readFileSync(file, "utf8"), dirname(file));
      const rendered = MarkdownFlow.renderPrompt(body, { args: "THE-ARGUMENTS" });

      assert.ok(rendered.startsWith(body.text.slice(0, 40)), "the body must lead the prompt");
      assert.ok(rendered.includes("THE-ARGUMENTS"), "the caller's arguments must be appended");
      assert.ok(!rendered.includes("---\ndescription:"), "frontmatter must not reach the model");
    });

    it(`${name} states the 1.0 authoring model, never the 0.x one`, () => {
      const text = readFileSync(file, "utf8");
      for (const removed of [
        "createSmithers",
        "<Task",
        "jsxImportSource",
        "gateway-react",
        "gateway-ui",
        "bunx smthrs",
        "docs-full",
        "ask-human",
        "smithers ui ",
        "props.schema",
      ]) {
        assert.ok(!text.includes(removed), `${name} still mentions "${removed}"`);
      }
    });
  }
});

describe("the capabilities the staged prompt bodies declare", () => {
  const files = markdownFlows();

  /** A command line each `proc:spawn` grant has to permit to be worth anything. */
  const COMMANDS = ["pnpm test", "git push origin main", "node scripts/check-docs.mjs"];

  for (const file of files) {
    const name = relative(flowsRoot, dirname(file)).split("\\").join("/");

    it(`${name} declares capabilities the permission kernel can parse`, () => {
      const declared = MarkdownFlow.fromMarkdown({
        text: readFileSync(file, "utf8"),
        path: relative(repoRoot, file).split("\\").join("/"),
        baseDirectory: dirname(file),
        naming: "path",
        name: Option.some(name),
        dirBasename: name.split("/").pop(),
        provenance: { source: "project", root: flowsRoot },
      }).descriptor.value.capabilities;

      for (const literal of declared) {
        // The registry stores whatever string the frontmatter carries, so a
        // typo inside a resource is silently accepted here and only refused
        // later, at the cell boundary, when the action asks for a capability
        // nobody granted. Parse each literal the way the kernel does.
        const parsed = Capability.parse(literal);
        assert.ok(Option.isSome(parsed), `${literal} is not a capability the kernel can parse`);
        assert.equal(
          parsed.value.resource,
          parsed.value.resource.trim(),
          `${literal} has whitespace around its resource, which no request can match`,
        );
      }
    });

    it(`${name} grants a real command line where it asks to spawn one`, () => {
      const declared = MarkdownFlow.fromMarkdown({
        text: readFileSync(file, "utf8"),
        path: relative(repoRoot, file).split("\\").join("/"),
        baseDirectory: dirname(file),
        naming: "path",
        name: Option.some(name),
        dirBasename: name.split("/").pop(),
        provenance: { source: "project", root: flowsRoot },
      }).descriptor.value.capabilities;

      const spawns = declared.filter((literal) => literal.startsWith("proc:spawn"));
      if (spawns.length === 0) return;

      for (const command of COMMANDS) {
        const request = Capability.make("proc:spawn", command);
        assert.ok(
          spawns.some((literal) => {
            const parsed = Capability.parse(literal);
            return Option.isSome(parsed) &&
              Capability.matches(
                new Capability.CapabilityPattern({
                  action: parsed.value.action,
                  resource: parsed.value.resource,
                }),
                request,
              );
          }),
          `${name} declares ${JSON.stringify(spawns)} but none of them permits \`${command}\``,
        );
      }
    });
  }
});

describe("the binary this lane's suites spawn", () => {
  it("is this working tree's source, not a build sitting beside it", () => {
    // `packages/cli/bin/smithers.mjs` prefers `dist/esm/bin.js` and falls back
    // to `src/bin.ts`, which is right for a published install and wrong for a
    // suite that asks what the source does. A stale `dist/` from an earlier
    // commit answered last build's behaviour to every real-CLI assertion in
    // this lane: the skills install, the hook spawns, and the fixture notices
    // were all green over code the tree no longer had.
    const built = join(repoRoot, "packages/cli/dist/esm/bin.js");
    assert.ok(
      !existsSync(built),
      `${relative(repoRoot, built)} exists, so every spawn in this lane runs that build instead of ` +
        "packages/cli/src. Remove packages/cli/dist before running these suites, or rebuild it from " +
        "the current source if something else needs it.",
    );
  });
});

describe("the CLI the staged prompt bodies teach", () => {
  const files = markdownFlows();
  const sourceCli = join(repoRoot, "packages/cli/bin/smithers.mjs");

  /**
   * `smithers <verb> --help`, once per verb path.
   *
   * These bodies are shipped instructions: an agent reads one and runs the
   * command it names. `effect/unstable/cli` answers an undeclared flag with
   * exit 2 and a usage dump, so a prompt that teaches a flag the parser does
   * not have hands the operator a failure instead of an install line. The
   * parser's own listing is the authority, read from the binary in this tree.
   */
  const listings = new Map();
  const help = (path) => {
    if (!listings.has(path)) {
      listings.set(
        path,
        spawnSync(process.execPath, [sourceCli, ...path.split(" "), "--help"], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 180_000,
        }),
      );
    }
    return listings.get(path);
  };

  /** Every `smithers ...` invocation a body names, in code spans or fences. */
  const invocations = (text) =>
    [...text.matchAll(/`smithers ([^`\n]+)`|^\s*smithers ([^\n]+)$/gm)]
      .map((match) => (match[1] ?? match[2]).trim())
      .filter((argv) => argv.length > 0);

  /** The verb path of one invocation: its leading bare words, at most two. */
  const verbPath = (argv) => {
    const words = [];
    for (const token of argv.split(/\s+/)) {
      if (!/^[a-z][a-z-]*$/.test(token) || words.length === 2) break;
      words.push(token);
    }
    return words.join(" ");
  };

  const longFlags = (text) => [...text.matchAll(/--[a-z][a-z-]+/g)].map((match) => match[0]);

  for (const file of files) {
    const name = relative(flowsRoot, dirname(file)).split("\\").join("/");

    it(`${name} names only commands and flags this CLI declares`, () => {
      const text = readFileSync(file, "utf8");
      const named = invocations(text);
      const paths = new Set();

      for (const argv of named) {
        const path = verbPath(argv);
        assert.ok(path.length > 0, `\`smithers ${argv}\` names no verb`);
        const listing = help(path);
        assert.equal(listing.status, 0, `\`smithers ${path}\` is not a command: ${listing.stderr}`);
        paths.add(path);
        for (const flag of longFlags(argv)) {
          assert.ok(
            listing.stdout.includes(flag),
            `\`smithers ${path}\` does not declare ${flag}, which ${name} tells the operator to run; ` +
              "effect/unstable/cli exits 2 on an undeclared flag",
          );
        }
      }

      // A flag named on its own, away from its command, is the same defect
      // wearing a different shape: some command in the body has to declare it.
      const attached = new Set(named.flatMap((argv) => longFlags(argv)));
      for (const [, flag] of text.matchAll(/`(--[a-z][a-z-]+)(?:[ =][^`\n]*)?`/g)) {
        if (attached.has(flag)) continue;
        const declaring = [...paths].find((path) => help(path).stdout.includes(flag));
        assert.ok(
          declaring !== undefined,
          `${name} names ${flag}, and no command it names declares it: ${[...paths].join(", ")}`,
        );
      }
    });
  }
});

describe("discovery over the project flows directory", () => {
  it("finds exactly the staged bodies, with no warnings", async () => {
    const scan = await run(
      Effect.gen(function* () {
        const discovery = Discovery.make(yield* FileSystem.FileSystem, yield* Path.Path);
        return yield* discovery.scan({ source: "project", root: flowsRoot, naming: "path" });
      }),
    );

    assert.deepEqual(
      scan.warnings.map((warning) => `${warning.code} at ${warning.path}: ${warning.message}`),
      [],
    );
    assert.deepEqual([...scan.entries].map((entry) => entry.name).sort(), EXPECTED_FLOWS);
  });

  it("finds no flow inside the 0.x fixture, which is data and not a flow", async () => {
    const scan = await run(
      Effect.gen(function* () {
        const discovery = Discovery.make(yield* FileSystem.FileSystem, yield* Path.Path);
        return yield* discovery.scan({
          source: "project",
          root: join(flowsRoot, "migrate-smithers-v1"),
          naming: "path",
        });
      }),
    );

    assert.deepEqual([...scan.entries].map((entry) => entry.name), []);
  });
});

describe("the smithers-0x-hello fixture", () => {
  const root = join(flowsRoot, FIXTURE);

  it("is a complete 0.x project on disk", () => {
    for (const file of [
      "package.json",
      "tsconfig.json",
      "FIXTURE.md",
      "simple-workflow.jsx",
      "_example-kit.js",
      ".smithers/workflows/hello.tsx",
      ".smithers/agents/index.ts",
      ".smithers/prompts/hello.mdx",
      ".smithers/ui/hello.tsx",
      "prompts/simple-workflow/research.mdx",
      "prompts/simple-workflow/write.mdx",
    ]) {
      assert.ok(statSync(join(root, file)).isFile(), `${file} is missing from the fixture`);
    }
  });

  it("is committed, `.smithers/` pack included", () => {
    // The repository root ignores `.smithers/`, because that is where a 0.x
    // checkout keeps its run state. Here it is the point of the fixture, so the
    // fixtures directory un-ignores it the way packages/migrate's does. Without
    // that negation the pack exists on the author's disk and nowhere else, and
    // every test here passes while a fresh clone has no fixture at all.
    const tracked = spawnSync("git", ["ls-files", "--", `flows/${FIXTURE}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(tracked.status, 0, tracked.stderr);
    const files = tracked.stdout.split("\n").filter((line) => line !== "");
    for (const file of [
      ".smithers/workflows/hello.tsx",
      ".smithers/agents/index.ts",
      ".smithers/prompts/hello.mdx",
      ".smithers/ui/hello.tsx",
    ]) {
      assert.ok(
        files.includes(`flows/${FIXTURE}/${file}`),
        `${file} is on disk but not tracked; check the fixtures .gitignore`,
      );
    }
    assert.equal(files.length, 15, "every fixture file is tracked");
  });

  it("is outside every pnpm workspace glob, so its 0.x dependencies never install", () => {
    const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    const globs = [...workspace.matchAll(/^ {2}- "([^"]+)"$/gm)].map((match) => match[1]);
    assert.ok(globs.length > 0, "the workspace file must declare package globs");
    for (const glob of globs) {
      assert.ok(!glob.startsWith("flows"), `workspace glob "${glob}" would pick up the fixture`);
    }
  });

  it("is detected as a Smithers 0.x project by the migrate detector", async () => {
    const detection = await run(Detect.scan(root));

    assert.deepEqual(
      detection.manifests.flatMap((manifest) => manifest.oldPackages),
      [{ name: "smthrs", version: "0.35.0", field: "dependencies", reason: "old-name" }],
    );

    const tsconfig = detection.tsconfigs.find((entry) => entry.path === "tsconfig.json");
    assert.equal(tsconfig?.jsx, "react-jsx");
    assert.equal(tsconfig?.jsxImportSource, "smthrs");

    assert.deepEqual(
      detection.workflowFiles.map((entry) => `${entry.path}:${entry.api}:${entry.kind}`).sort(),
      [".smithers/workflows/hello.tsx:smthrs:tsx", "simple-workflow.jsx:smthrs:jsx"],
    );

    assert.deepEqual(detection.prompts.map((entry) => entry.path).sort(), [
      ".smithers/prompts/hello.mdx",
      "prompts/simple-workflow/research.mdx",
      "prompts/simple-workflow/write.mdx",
    ]);

    assert.deepEqual(detection.uis.map((entry) => entry.path), [".smithers/ui/hello.tsx"]);
    assert.equal(detection.effectPin, "4.0.0-beta.105");
    assert.ok(
      detection.warnings.some((warning) => warning.code === "effect-pin-conflict"),
      "the beta.105 pin must be reported against the rc.108 the 1.0 tree requires",
    );
  });

  it("carries the 0.x CLI verbs its package scripts invoke", async () => {
    const detection = await run(Detect.scan(join(flowsRoot, FIXTURE)));
    assert.deepEqual(
      detection.scripts.map((hit) => hit.text).sort(),
      ["smithers up", "smithers workflow"],
    );
  });

  it("holds no 0.x run state, so the migration gate has nothing to refuse", () => {
    for (const path of [".smithers/smithers.db", "smithers.db", ".smithers/executions"]) {
      assert.throws(() => statSync(join(root, path)), /ENOENT/, `${path} must not exist in the fixture`);
    }
  });
});

describe("the fixture under the real CLI", () => {
  const staged = [];
  after(() => {
    for (const directory of staged) rmSync(directory, { recursive: true, force: true });
  });

  const cli = join(repoRoot, "packages", "cli", "bin", "smithers.mjs");

  /**
   * A copy of the fixture outside this repository.
   *
   * In place, the fixture resolves its project root to this repository, whose
   * `flows/` directory anchors it, so a command run inside the fixture reads
   * the repository's flows and not the fixture at all. A detached copy is what
   * an external 0.x project looks like.
   */
  const detached = () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-0x-"));
    staged.push(directory);
    const project = join(directory, "project");
    cpSync(join(flowsRoot, FIXTURE), project, { recursive: true });
    return project;
  };

  const smithers = (project, ...args) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8", timeout: 300_000 });

  it("prints the section 6 notice the first time a command runs in it", () => {
    const project = detached();

    const first = smithers(project, "ls");

    assert.equal(first.status, 0, first.stderr);
    // rc-contract.md section 6, verbatim opening. Building the durable layers
    // creates `.flows/`, which is the very thing the detector reads as "this
    // is an rc.0 project", so a reading taken inside the handler found nothing
    // on precisely the run this notice is written for.
    assert.match(first.stderr, /^Found Smithers 0\.x state at .*\.smithers\./);
    assert.match(first.stderr, /1\.0\.0-rc\.0 does not load, resume, or migrate 0\.x run databases/);
    assert.match(first.stderr, /https:\/\/smithers\.sh\/migration\/1\.0#run-data/);

    const second = smithers(project, "ls");

    // Once `.flows/` exists the project is mid-migration, and section 6 stops
    // the notice rather than repeating it on every command forever.
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stderr, "");
  });

  it("passes the migrate verb's 0.x run gate, having no run state to refuse", () => {
    const project = detached();

    const result = smithers(project, "migrate");

    // The gate reads any 0.x `smithers.db` for non-terminal runs. The fixture
    // has none, so the verb gets past it and reaches the migration tool, which
    // ships inside `@smthrs/migrate` rather than in a `flows/` directory the
    // project being migrated does not have. A refusal here would mean the gate
    // fired on a project with nothing to refuse.
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Run state: clean\.$/m);
    assert.ok(
      !`${result.stdout}${result.stderr}`.includes("non-terminal"),
      "the 0.x run gate refused a fixture that holds no run state",
    );
  });

  it("is a project the migration planner reads as 0.x work, not an empty directory", () => {
    const project = detached();

    const result = smithers(project, "migrate");

    assert.equal(result.status, 0, result.stderr);
    // The fixture exists to give the migration tool something real to plan
    // against. A fixture that planned zero units would pass every gate above
    // and prove nothing, so the counts are the assertion.
    const units = /^Units: (\d+) planned, /m.exec(result.stdout);
    assert.ok(units, `the planner reported no unit line:\n${result.stdout}`);
    assert.ok(Number(units[1]) >= 3, `the fixture planned only ${units[1]} units`);
    const constructs = /^Constructs: (\d+) rows across (\d+) mapping decisions\.$/m.exec(result.stdout);
    assert.ok(constructs, `the planner reported no construct line:\n${result.stdout}`);
    assert.ok(Number(constructs[1]) > 0 && Number(constructs[2]) > 0);
    // The 0.x `<UI>` element is the construct the rc contract has no
    // counterpart for, and the fixture carries one so a person sees it.
    assert.match(result.stdout, /\.smithers\/workflows\/hello\.tsx/);
  });
});
