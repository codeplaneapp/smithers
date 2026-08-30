// The plugin CLI resolver, and the byte-identity of its two copies.
//
// Run: node --test "claude-plugin/**/*.test.mjs"

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLI_RUNTIME,
  findInstalledOrchestratorBin,
  findOrchestratorOnPath,
  findSmithersSourceRoot,
  isSmithersSourceRoot,
  orchestratorBinIn,
  PUBLISHED_BIN_NAME,
  PUBLISHED_PACKAGE_NAME,
  PUBLISHED_RUNNER,
  resolveSmithersCli,
  resolveSmithersShellCommand,
  SOURCE_CLI_ENTRY,
  SOURCE_ROOT_PACKAGE_NAME,
} from "./resolve-smithers-cli.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(pluginRoot);

/** The two copies that must stay byte-identical; see scripts/check-local-smithers.mjs. */
const MIRRORED = ["claude-plugin/lib/resolve-smithers-cli.mjs", "codex-plugin/lib/resolve-smithers-cli.mjs"];

const created = [];
const scratch = (name) => {
  const directory = mkdtempSync(join(tmpdir(), `resolve-smithers-${name}-`));
  created.push(directory);
  return directory;
};
after(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

/** Writes a directory that looks exactly like a Smithers source checkout. */
function makeSourceCheckout(name = SOURCE_ROOT_PACKAGE_NAME) {
  const root = scratch("checkout");
  mkdirSync(join(root, dirname(SOURCE_CLI_ENTRY)), { recursive: true });
  writeFileSync(join(root, SOURCE_CLI_ENTRY), "#!/usr/bin/env node\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name }));
  return root;
}

describe("the retargeted constants", () => {
  it("names the 1.0 CLI entry, package, and bin", () => {
    assert.equal(SOURCE_CLI_ENTRY, "packages/cli/bin/smithers.mjs");
    assert.equal(SOURCE_ROOT_PACKAGE_NAME, "smithers");
    assert.equal(PUBLISHED_PACKAGE_NAME, "@smthrs/cli");
    assert.equal(PUBLISHED_BIN_NAME, "smithers");
  });

  it("runs the CLI on node, because the durable engine is unsupported on bun", () => {
    assert.equal(CLI_RUNTIME, "node");
  });

  it("agrees with the repository it ships from", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, SOURCE_ROOT_PACKAGE_NAME);
    const cli = JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8"));
    assert.equal(cli.name, PUBLISHED_PACKAGE_NAME);
    assert.equal(Object.keys(cli.bin)[0], PUBLISHED_BIN_NAME);
    assert.ok(isSmithersSourceRoot(repoRoot), "this checkout must resolve as a source root");
  });
});

describe("tier 1: a source checkout", () => {
  it("recognizes a root that has both the entry and the manifest name", () => {
    assert.equal(isSmithersSourceRoot(makeSourceCheckout()), true);
  });

  it("refuses a tree that only has the entry path", () => {
    assert.equal(isSmithersSourceRoot(makeSourceCheckout("some-other-project")), false);
  });

  it("walks upward from a subdirectory", () => {
    const root = makeSourceCheckout();
    const nested = join(root, "packages", "cli", "test");
    mkdirSync(nested, { recursive: true });
    assert.equal(findSmithersSourceRoot(nested), resolve(root));
  });

  it("spawns node on the working tree's entry", () => {
    const root = makeSourceCheckout();
    const resolved = resolveSmithersCli(root, {});
    assert.deepEqual(resolved, {
      command: "node",
      args: [join(resolve(root), SOURCE_CLI_ENTRY)],
      source: "workspace",
      root: resolve(root),
    });
  });
});

describe("tier 2: an installed @smthrs/cli", () => {
  /** Writes node_modules/@smthrs/cli with the manifest and bin an install has. */
  function makeInstall(name = PUBLISHED_PACKAGE_NAME, bin = { smithers: "./bin/smithers.mjs" }) {
    const root = scratch("install");
    const packageDirectory = join(root, "node_modules", "@smthrs", "cli");
    mkdirSync(join(packageDirectory, "bin"), { recursive: true });
    writeFileSync(join(packageDirectory, "bin", "smithers.mjs"), "#!/usr/bin/env node\n");
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name, bin }));
    return { root, packageDirectory };
  }

  it("reads the bin path the manifest declares", () => {
    const { packageDirectory } = makeInstall();
    assert.equal(orchestratorBinIn(packageDirectory), join(packageDirectory, "bin", "smithers.mjs"));
  });

  it("refuses a directory whose manifest is a different package", () => {
    const { packageDirectory } = makeInstall("smthrs");
    assert.equal(orchestratorBinIn(packageDirectory), null);
  });

  it("accepts the single-bin string form", () => {
    const { packageDirectory } = makeInstall(PUBLISHED_PACKAGE_NAME, "./bin/smithers.mjs");
    assert.equal(orchestratorBinIn(packageDirectory), join(packageDirectory, "bin", "smithers.mjs"));
  });

  it("walks upward and spawns node on it", () => {
    const { packageDirectory, root } = makeInstall();
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });
    assert.equal(findInstalledOrchestratorBin(nested), join(packageDirectory, "bin", "smithers.mjs"));
    const resolved = resolveSmithersCli(nested, {});
    assert.equal(resolved.source, "installed");
    assert.equal(resolved.command, "node");
    assert.deepEqual(resolved.args, [join(packageDirectory, "bin", "smithers.mjs")]);
  });
});

describe("tier 3: an executable on PATH", () => {
  it("finds `smithers`, not `smthrs`", () => {
    const directory = scratch("path");
    for (const name of ["smithers", "smthrs"]) {
      const file = join(directory, name);
      writeFileSync(file, "#!/bin/sh\n");
      chmodSync(file, 0o755);
    }
    assert.equal(
      findOrchestratorOnPath({ PATH: directory }, "linux"),
      join(directory, "smithers"),
    );
  });

  it("ignores a non-executable file of the right name", () => {
    const directory = scratch("path-noexec");
    const file = join(directory, "smithers");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o644);
    assert.equal(findOrchestratorOnPath({ PATH: directory }, "linux"), null);
  });

  it("searches every PATH entry in order", () => {
    const first = scratch("path-first");
    const second = scratch("path-second");
    const file = join(second, "smithers");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    assert.equal(
      findOrchestratorOnPath({ PATH: [first, second].join(delimiter) }, "linux"),
      file,
    );
  });
});

describe("tier 4: no install at all", () => {
  it("names the package and the bin separately, never a bare bin-name lookup", () => {
    const resolved = resolveSmithersCli(scratch("bare"), { PATH: "" });
    assert.deepEqual(resolved, {
      command: PUBLISHED_RUNNER,
      args: ["--package", PUBLISHED_PACKAGE_NAME, PUBLISHED_BIN_NAME],
      source: "published",
      root: null,
    });
  });

  it("renders as a shell command with the scope intact", () => {
    assert.equal(
      resolveSmithersShellCommand(scratch("bare-shell"), { PATH: "" }),
      "npx --package @smthrs/cli smithers",
    );
  });
});

describe("shell rendering", () => {
  it("quotes a path with a space", () => {
    const root = scratch("quote me");
    mkdirSync(join(root, dirname(SOURCE_CLI_ENTRY)), { recursive: true });
    writeFileSync(join(root, SOURCE_CLI_ENTRY), "");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: SOURCE_ROOT_PACKAGE_NAME }));
    const rendered = resolveSmithersShellCommand(root, {});
    assert.match(rendered, /^node '.*quote me.*'$/);
  });
});

describe("the two plugin copies", () => {
  it("are byte-identical, because each plugin ships standalone", () => {
    const [first, ...rest] = MIRRORED.map((path) => readFileSync(join(repoRoot, path)));
    for (let index = 0; index < rest.length; index++) {
      assert.ok(
        first.equals(rest[index]),
        `${MIRRORED[index + 1]} has drifted from ${MIRRORED[0]}; run ` +
          `cp ${MIRRORED[0]} ${MIRRORED[index + 1]}`,
      );
    }
  });

  it("both exist, so the identity check above is not vacuous", () => {
    for (const path of MIRRORED) {
      assert.ok(readFileSync(join(repoRoot, path)).length > 0, `${path} must exist`);
    }
  });
});
