import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const text = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(text(path));
const exists = (path) => existsSync(resolve(root, path));

function expectFile(path) {
  expect(exists(path), path).toBe(true);
}

function expectText(path, fragments) {
  const body = text(path);
  for (const fragment of fragments) expect(body).toContain(fragment);
}

function packageDirs(parent) {
  const abs = resolve(root, parent);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .map((entry) => join(parent, entry))
    .filter((dir) => exists(join(dir, "package.json")))
    .sort();
}

function workspaceDirs() {
  return [...packageDirs("packages"), ...packageDirs("apps"), "e2e", ".smithers"].filter((dir) =>
    exists(join(dir, "package.json")),
  );
}

function manifests() {
  return [
    { dir: ".", manifest: json("package.json") },
    ...workspaceDirs().map((dir) => ({ dir, manifest: json(join(dir, "package.json")) })),
  ];
}

function depObjects(manifest) {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ].filter(Boolean);
}

describe("PACKAGE_AND_BUILD contracts", () => {
  test("published package identity, bin wrapper, and facade exports are source-backed", () => {
    const rootPackage = json("package.json");
    const publicPackage = json("packages/smithers/package.json");

    expect(rootPackage.private).toBe(true);
    expect(rootPackage.bin.smithers).toBe("apps/cli/src/index.js");
    expect(publicPackage.name).toBe("smthrs");
    expect(publicPackage.bin.smithers).toBe("./src/bin/smithers.js");
    expect(publicPackage.files).toContain("src/");
    expect(publicPackage.files).toContain("docs/llms.txt");
    expect(publicPackage.files).toContain("docs/llms-full.txt");
    expectText("packages/smithers/src/bin/smithers.js", [
      "findNearestWorkflowLocalCli",
      "findNearestLocalSmithersCli",
      "spawn(process.execPath",
      'await import("@smthrs/cli")',
    ]);
    expectText("packages/agents/src/index.d.ts", ["PoolAgent", "PoolAgentOptions", "createPoolCapabilityRegistry"]);
    expectText("packages/smithers/src/index.d.ts", ["PoolAgent", "PoolAgentOptions"]);

    const explicit = [
      ".",
      "./tools",
      "./testing",
      "./gateway-client",
      "./gateway-react",
      "./scorers",
      "./gateway-ui",
      "./ui",
      // The React-free status vocabulary: importing it must never evaluate the
      // component barrel (issue #1381).
      "./ui/status",
      "./ui/adapters/markdown-editor",
      "./sandbox",
      "./telegram",
      "./control-plane",
      "./cloudflare",
      "./daytona",
      "./microsandbox",
      "./vercel",
      "./aws",
      "./gcp",
      "./jsx-runtime",
      "./jsx-dev-runtime",
    ];
    for (const subpath of explicit) {
      const entry = publicPackage.exports[subpath];
      expect(entry).toBeDefined();
      expect(entry.import).toBe(entry.default);
      expect(entry.import).toMatch(/^\.\/src\/.+\.js$/);
      expect(entry.types).toMatch(/^\.\/src\/.+\.d\.ts$/);
      expectFile(join("packages/smithers", entry.import));
      expectFile(join("packages/smithers", entry.types));
    }
    expect(publicPackage.exports["./*"]).toEqual({
      types: "./src/index.d.ts",
      import: "./src/*.js",
      default: "./src/*.js",
    });
    for (const wrapper of ["gateway", "mdx-plugin", "memory", "observability", "openapi", "serve", "server"]) {
      expectFile(`packages/smithers/src/${wrapper}.js`);
    }
    expect(publicPackage.exports["./pi-plugin"]).toBeUndefined();
    expect(publicPackage.exports["./pi-extension"]).toBeUndefined();
  });

  test("pnpm workspace graph includes direct workspaces and resolves workspace protocol dependencies", () => {
    expectText("pnpm-workspace.yaml", ['  - "packages/*"', '  - "apps/*"', '  - "e2e"', '  - ".smithers"']);

    const localNames = new Map();
    for (const { dir, manifest } of manifests()) {
      if (manifest.name) localNames.set(manifest.name, dir);
    }

    const unresolved = [];
    for (const { dir, manifest } of manifests()) {
      for (const deps of depObjects(manifest)) {
        for (const [name, version] of Object.entries(deps)) {
          if (typeof version === "string" && version.startsWith("workspace:") && !localNames.has(name)) {
            unresolved.push(`${dir}: ${name}@${version}`);
          }
        }
      }
    }
    expect(unresolved).toEqual([]);
    expect(localNames.get("smthrs")).toBe("packages/smithers");
    expect(localNames.get("@smthrs/observability")).toBe("apps/observability");
    expect(localNames.get("@smthrs/e2e")).toBe("e2e");
    expect(localNames.get("smithers-workflows")).toBe(".smithers");
  });

  test("TypeScript and Bun root config pin JSX, aliases, local type roots, and MDX preloads", () => {
    const rootPackage = json("package.json");
    const tsconfig = json("tsconfig.json");
    const paths = tsconfig.compilerOptions.paths;

    expect(rootPackage.devDependencies.typescript).toBe("~6.0.3");
    for (const { dir, manifest } of manifests()) {
      const version = manifest.devDependencies?.typescript ?? manifest.dependencies?.typescript;
      if (version) expect(version).toBe(dir === ".smithers" ? "6.0.3" : "~6.0.3");
    }

    expect(tsconfig.compilerOptions.jsx).toBe("react-jsx");
    expect(tsconfig.compilerOptions.jsxImportSource).toBe("smthrs");
    expect(paths["smthrs"]).toEqual(["./packages/smithers/src/index.js"]);
    expect(paths["smthrs/jsx-runtime"]).toEqual(["./packages/smithers/src/jsx-runtime.js"]);
    expect(paths["smthrs/jsx-dev-runtime"]).toEqual(["./packages/smithers/src/jsx-runtime.js"]);
    expect(paths["smthrs/tools"]).toEqual(["./packages/smithers/src/tools.js"]);
    expect(paths["smthrs/*"]).toEqual(["./packages/smithers/src/*.js", "./packages/smithers/src/*/index.js"]);
    expect(paths["@smthrs/db/runState"]).toEqual(["./packages/db/src/runState.js", "./packages/db/src/runState.d.ts"]);
    expect(paths["@smthrs/server"]).toEqual(["./packages/server/src/index.js"]);
    expect(paths["@smthrs/observability"]).toEqual(["./apps/observability/src/index.js"]);
    expect(tsconfig.compilerOptions.typeRoots).toEqual(["./packages/smithers/src/types", "./node_modules/@types"]);
    expectText("bunfig.toml", ['preload = ["./preload.js"]', "[test]", 'root = "."']);
    expectText("preload.js", ['import { mdxPlugin } from "./packages/smithers/src/mdx-plugin.js";', "mdxPlugin();"]);
  });

  test("npm scripts wire build, docs, release, coverage, observability, and app e2e commands", () => {
    const scripts = json("package.json").scripts;
    expect(scripts.typecheck).toBe("tsc --noEmit");
    expect(scripts["typecheck:examples"]).toBe("tsc -p examples/tsconfig.json --noEmit");
    // `lint` chains both tools of the Oxc toolchain so the everyday command
    // checks lint rules and formatting in one go.
    expect(scripts.lint).toBe("node scripts/lint.mjs && node scripts/format.mjs --check");
    expect(scripts.format).toBe("node scripts/format.mjs --write");
    expect(scripts["format:check"]).toBe("node scripts/format.mjs --check");
    expect(scripts.release).toBe("node scripts/publish.mjs");
    expect(scripts.coverage).toBe("node scripts/coverage.mjs");
    expect(scripts.docs).toBe("cd docs && bunx mintlify dev");
    expect(scripts["docs:llms"]).toBe("bun scripts/generate-llms.ts && bun scripts/optimize-llms-full.ts");
    expect(scripts["docs:components"]).toBe("node scripts/generate-component-source.mjs");
    expect(scripts["generate:init-pack"]).toBe("bun scripts/generate-workflow-pack.ts");
    expect(scripts["sota:gen"]).toBe("bun scripts/generate-sota.ts");
    expect(scripts["sota:research"]).toBe("bun scripts/sota-research.ts");
    expect(scripts["check:effect"]).toBe("node scripts/check-single-effect-version.mjs");
    expect(scripts["check:npm-dedupe"]).toBe("node scripts/check-npm-dedupe.mjs");
    expect(scripts["check:deps"]).toBe(
      "node scripts/check-dependency-boundaries.mjs && node scripts/check-installed-footprint.mjs",
    );
    expect(scripts["check:footprint"]).toBe("node scripts/check-installed-footprint.mjs");
    expect(scripts["check:db-access"]).toBe("node scripts/check-no-direct-db-access.mjs");
    expect(scripts["check:local-smithers"]).toBe("node scripts/check-local-smithers.mjs");
    expect(scripts["test:local-smithers"]).toBe("node --test scripts/check-local-smithers.test.mjs");
    expect(scripts["check:docs"]).toBe("node scripts/check-docs.mjs");
    expect(scripts["check:llms"]).toBe("node scripts/check-llms.mjs");
    expect(scripts["check:sota"]).toBe("node scripts/check-sota.mjs");
    expect(scripts["check:dts"]).toBe("node scripts/check-dts.mjs");
    expect(scripts["fetch:jj"]).toBe("node scripts/fetch-jj-binaries.mjs");
    expect(scripts.observability).toBeUndefined();
    expect(scripts.test).toBe(
      [
        "node scripts/check-single-effect-version.mjs",
        "node scripts/check-npm-dedupe.mjs",
        "node scripts/check-dependency-boundaries.mjs",
        "node scripts/check-installed-footprint.mjs",
        "node scripts/check-ui-architecture.mjs",
        "node --test scripts/check-ui-architecture.test.mjs",
        "node scripts/check-no-direct-db-access.mjs",
        "node scripts/check-local-smithers.mjs",
        "node --test scripts/check-local-smithers.test.mjs",
        "node scripts/check-docs.mjs",
        "node scripts/check-llms.mjs",
        "node scripts/check-sota.mjs",
        "node scripts/check-dts.mjs",
        "node scripts/check-smithers-test-script.mjs",
        "node --test scripts/qualify-nanocodex-release.test.mjs",
        "bun test scripts/publish-next.test.mjs scripts/release-next-gate.test.mjs scripts/bump.test.mjs scripts/run-workspace-tests-timeout.test.mjs",
        "pnpm -r --no-bail test",
      ].join(" && "),
    );

    for (const path of [
      "scripts/publish.mjs",
      "scripts/coverage.mjs",
      "scripts/generate-llms.ts",
      "scripts/optimize-llms-full.ts",
      "scripts/generate-component-source.mjs",
      "scripts/generate-workflow-pack.ts",
      "scripts/check-no-direct-db-access.mjs",
      "scripts/check-smithers-test-script.mjs",
      "scripts/verify-observability.sh",
    ])
      expectFile(path);

    const observability = json("apps/observability/package.json");
    expect(observability.scripts.test).toBe("bun test tests");
    expect(observability.scripts.typecheck).toBe("tsc -p tsconfig.json --noEmit");

    const app = json("apps/smithers/package.json");
    expect(app.scripts.test).toContain('--path-ignore-patterns="**/e2e/**"');
    expect(app.scripts.e2e).toBe("playwright test");
    expect(app.scripts["e2e:install"]).toBe("playwright install chromium");
    expect(app.devDependencies["@playwright/test"]).toBeDefined();
  });

  test("CI and fault workflows keep clean-runner package/build gates wired", () => {
    const ci = parseYaml(text(".github/workflows/ci.yml"));
    const linuxTestRows = ci.jobs.test.strategy.matrix.include.filter(({ os }) => os.startsWith("ubuntu-"));
    const linuxTestSetup = ci.jobs.test.steps.find(
      ({ name }) => name === "Install Linux test dependencies and probe Bubblewrap",
    );
    const coverageSetup = ci.jobs.coverage.steps.find(
      ({ name }) => name === "Install coverage dependencies and probe Bubblewrap",
    );

    expect(linuxTestRows).toHaveLength(4);
    expect(linuxTestRows.every(({ os }) => os === "ubuntu-latest")).toBe(true);
    expect(linuxTestSetup.if).toBe("runner.os == 'Linux'");
    expect(linuxTestSetup.run).toContain("sudo apt-get install -y bubblewrap ripgrep");
    expect(linuxTestSetup.run).toContain("--unshare-pid");
    expect(ci.jobs.coverage["runs-on"]).toBe("ubuntu-latest");
    expect(coverageSetup.run).toContain("sudo apt-get install -y bubblewrap ripgrep");
    expect(coverageSetup.run).toContain("--unshare-pid");
    expect(ci.jobs["nanocodex-source-build"]).toBeUndefined();
    expect(ci.jobs["nanocodex-release-qualification"]).toBeUndefined();
    expect(text(".github/workflows/ci.yml")).not.toContain("N0xMare/smithers-nanocodex");

    expectText(".github/workflows/ci.yml", [
      "  typecheck:",
      "  test:",
      "  coverage:",
      "  test-postgres:",
      "node-version: 22",
      "bun-version: 1.3.13",
      "choco install ripgrep -y",
      "node scripts/check-single-effect-version.mjs",
      "node scripts/check-dependency-boundaries.mjs",
      "node scripts/check-docs.mjs",
      "node scripts/check-llms.mjs",
      "node scripts/check-smithers-test-script.mjs",
      "node scripts/check-dts.mjs",
      "pnpm -C .smithers test:ddd",
      // Linux and Windows both run the weighted shard balancer; Linux package
      // shards skip the graph smoke so it can run in a fresh, serialized Bun
      // process, while the extras lane (shard 0) owns the serial gates.
      "node scripts/run-workspace-tests.mjs --shard",
      "--timeout-minutes 30",
      'SMITHERS_SKIP_EXAMPLE_GRAPH_SMOKE: "1"',
      "bun test --timeout=900000 --max-concurrency=1 apps/cli/tests/examples-graph-smoke.test.js",
      "matrix.shard == 0",
      "bun test examples/bun-port-smithers/components/porting-rules.test.ts examples/context-handoff/workflow.test.ts",
      "bun test --timeout=120000 apps/cli/tests/tui-zmux.e2e.test.js",
      "run: pnpm coverage",
      "docker compose -f deploy/electric/docker-compose.yml up -d postgres",
      "SMITHERS_TEST_PG_URL:",
    ]);
    expectText(".github/workflows/faults.yml", ["pnpm -r build", "pnpm --filter @smthrs/e2e test:faults"]);
    expectText(".github/workflows/faults-nightly.yml", [
      'SMITHERS_E2E_SOAK: "1"',
      "pnpm -r build",
      "pnpm --filter @smthrs/e2e test:soak",
    ]);
  });

  test("script guard sources cover docs, release, dependency, SOTA, d.ts, faults, and pack generation", () => {
    expectText("scripts/generate-llms.ts", [
      "llms-core.txt",
      "llms-memory.txt",
      "llms-openapi.txt",
      "llms-observability.txt",
      "llms-effect.txt",
      "llms-events.txt",
      "skills/smithers",
      "apps/cli/docs",
      "packages/smithers/docs",
      "GENERATED:COMPONENT-SOURCE START",
    ]);
    expectText("scripts/optimize-llms-full.ts", [
      "docs/llms-full.txt",
      "skills/smithers/llms-full.txt",
      "apps/cli/docs/llms-full.txt",
      "packages/smithers/docs/llms-full.txt",
      "JSX pragma",
    ]);
    expectText("scripts/check-llms.mjs", [
      "docs/llms-full.txt",
      "checkNpmPublication",
      "versionedGeneratorArgs",
      'run("bun", ["scripts/generate-llms.ts", ...versionedArgs])',
      'run("bun", ["scripts/optimize-llms-full.ts", ...versionedArgs])',
      "Run `pnpm docs:llms`",
    ]);
    expectText("scripts/check-docs.mjs", [
      "normalize-bunx.ts",
      "normalize-placeholders.ts",
      "generate-component-source.mjs",
      "checkPackageConfigurationDocsMatchRootConfig",
      "missing public facade wrapper files",
    ]);
    expectText("scripts/check-dependency-boundaries.mjs", [
      'const workspaceRoots = ["packages", "apps"];',
      'const directWorkspaceDirs = ["e2e", ".smithers"];',
      "ts.createSourceFile",
      "function isDevOnlyFile",
      "peerDependencies",
      "optionalDependencies",
    ]);
    expectText("scripts/check-single-effect-version.mjs", [
      "collectPnpmLockVersions",
      "collectBunLockVersions",
      "collectInstalledVersions",
      "Expected exactly one resolved effect version",
    ]);
    expectText("scripts/check-sota.mjs", [
      "docs/reference/sota-models.mdx",
      "apps/cli/src/sota-models.generated.js",
      "scripts/generate-sota.ts",
      "scripts/sota.test.ts",
    ]);
    expectText("scripts/generate-sota.ts", ["SOTA_REGISTRY_VERSION", "SOTA_ROLE_MODELS", "SOTA_DEPRECATED_MODELS"]);
    expectText("scripts/sota-research.ts", [
      "scripts/generate-sota.ts",
      'pnpm", ["docs:llms"]',
      'pnpm", ["generate:init-pack"]',
    ]);
    expectText("scripts/check-dts.mjs", [
      '"packages/agents"',
      '"packages/cloudflare"',
      '"packages/graph"',
      '"packages/integrations"',
      '"packages/smithers"',
      "restoreDeclarations(srcDir, committed)",
      'pnpm", ["-C", pkg, "run", "build"]',
    ]);
    expectText("scripts/check-fault-skips.mjs", ["allowedSkips", "skipPattern", "no untracked skips"]);
    expectText("scripts/normalize-bunx.ts", ["bunx smthrs", "normalizeCommands", "normalizeInline", "README.md"]);
    expectText("scripts/normalize-placeholders.ts", [
      "<run-id>",
      "RUN_ID",
      "NODE_ID",
      "WORKFLOW_ID",
      "isPathOrUrlContext",
    ]);
    expectText("scripts/generate-component-source.mjs", [
      "Composite",
      "GENERATED:COMPONENT-SOURCE START",
      "GENERATED:COMPONENT-SOURCE END",
      "--check",
    ]);
    expectText("scripts/generate-workflow-pack.ts", [
      "SEEDED_WORKFLOW_IDS",
      "// smithers-source: seeded",
      "GENERATED_SEEDED_FILES",
    ]);
    expectText("scripts/generate-ui-themes.ts", [
      "crepeTheme.generated.ts",
      "xyflowTheme.generated.ts",
      "@xyflow/react/dist/style.css",
    ]);
    expectText("scripts/publish.mjs", [
      "pnpm check:llms",
      "pnpm -r build",
      "pnpm test",
      "pnpm fetch:jj",
      "--skip-gh-release",
    ]);
    expectText("scripts/fetch-jj-binaries.mjs", [
      "jj-vcs/jj",
      "JJ_VERSION",
      "--force",
      "jj-darwin-arm64",
      "jj-win32-x64",
      "commit nothing",
    ]);
    expectText("scripts/coverage.mjs", [
      "thresholdProfiles",
      "packageProfiles",
      "coverageUnsupported",
      "SMITHERS_COVERAGE_PACKAGES",
    ]);
    expectText("scripts/verify-observability.sh", [
      "scripts/obs-reset.sh",
      "observability/docker-compose.otel.yml",
      "SMITHERS_OTEL_ENABLED=1",
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318",
      "OTEL_SERVICE_NAME=smithers-dev",
      "tmp/verification",
      "agent-trace-otel-demo",
      "grafana-health",
      "prometheus-up",
      "loki",
      "tempo",
      "REDACTED_SECRET",
    ]);
    expectText("scripts/readme-contract.test.mjs", ["task-fork.gif", "<Loop>", "Ralph"]);
  });

  test("gitignore excludes Smithers runtime artifacts without hiding source directories", () => {
    const lines = text(".gitignore").split(/\r?\n/);
    for (const pattern of [
      "**/.smithers/sandboxes/",
      "**/.smithers/executions/",
      "**/.smithers/bug-reports/",
      "**/.smithers-op-console-*/",
      "**/.smithers/pg/",
      "**/.smithers/migrated.json",
      ".smithers/evals/reports/",
      "/data/*.sqlite*",
      "/reports/????-??-??.md",
      "/reports/????-??-??.html",
      "/reports/????-??-??.json",
      "smithers.db",
      "smithers.db-shm",
      "smithers.db-wal",
      "**/tmp/verification/",
      "apps/observability/data/",
    ]) {
      expect(lines).toContain(pattern);
    }
    expect(lines).not.toContain("/reports/");
    expect(lines).not.toContain(".smithers/");
    expect(lines).toContain("!docs/reference/");
    expect(lines).toContain("!deploy/reference/");
    expect(lines).toContain("!deploy/reference/**");
  });
});
