import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  return [...packageDirs("packages"), ...packageDirs("apps"), "e2e", ".smithers"]
    .filter((dir) => exists(join(dir, "package.json")));
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
    expect(publicPackage.name).toBe("smithers-orchestrator");
    expect(publicPackage.bin.smithers).toBe("./src/bin/smithers.js");
    expect(publicPackage.files).toContain("src/");
    expect(publicPackage.files).toContain("docs/llms.txt");
    expect(publicPackage.files).toContain("docs/llms-full.txt");
    expectText("packages/smithers/src/bin/smithers.js", [
      "findNearestWorkflowLocalCli",
      "findNearestLocalSmithersCli",
      "spawn(process.execPath",
      'await import("@smithers-orchestrator/cli")',
    ]);

    const explicit = [
      ".",
      "./tools",
      "./testing",
      "./gateway-client",
      "./gateway-react",
      "./scorers",
      "./gateway-ui",
      "./ui",
      "./sandbox",
      "./telegram",
      "./control-plane",
      "./cloudflare",
      "./daytona",
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
    expectText("pnpm-workspace.yaml", [
      '  - "packages/*"',
      '  - "apps/*"',
      '  - "e2e"',
      '  - ".smithers"',
    ]);

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
    expect(localNames.get("smithers-orchestrator")).toBe("packages/smithers");
    expect(localNames.get("@smithers-orchestrator/observability")).toBe("apps/observability");
    expect(localNames.get("@smithers-orchestrator/e2e")).toBe("e2e");
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
    expect(tsconfig.compilerOptions.jsxImportSource).toBe("smithers-orchestrator");
    expect(paths["smithers-orchestrator"]).toEqual(["./packages/smithers/src/index.js"]);
    expect(paths["smithers-orchestrator/jsx-runtime"]).toEqual(["./packages/smithers/src/jsx-runtime.js"]);
    expect(paths["smithers-orchestrator/jsx-dev-runtime"]).toEqual(["./packages/smithers/src/jsx-runtime.js"]);
    expect(paths["smithers-orchestrator/tools"]).toEqual(["./packages/smithers/src/tools.js"]);
    expect(paths["smithers-orchestrator/*"]).toEqual([
      "./packages/smithers/src/*.js",
      "./packages/smithers/src/*/index.js",
    ]);
    expect(paths["@smithers-orchestrator/db/runState"]).toEqual([
      "./packages/db/src/runState.js",
      "./packages/db/src/runState.d.ts",
    ]);
    expect(paths["@smithers-orchestrator/server"]).toEqual(["./packages/server/src/index.js"]);
    expect(paths["@smithers-orchestrator/observability"]).toEqual(["./apps/observability/src/index.js"]);
    expect(tsconfig.compilerOptions.typeRoots).toEqual([
      "./packages/smithers/src/types",
      "./node_modules/@types",
    ]);
    expectText("bunfig.toml", ['preload = ["./preload.js"]', "[test]", 'root = "."']);
    expectText("preload.js", [
      'import { mdxPlugin } from "./packages/smithers/src/mdx-plugin.js";',
      "mdxPlugin();",
    ]);
  });

  test("npm scripts wire build, docs, release, coverage, observability, and app e2e commands", () => {
    const scripts = json("package.json").scripts;
    expect(scripts.typecheck).toBe("tsc --noEmit");
    expect(scripts["typecheck:examples"]).toBe("tsc -p examples/tsconfig.json --noEmit");
    expect(scripts.lint).toBe("node scripts/lint.mjs");
    expect(scripts.release).toBe("node scripts/publish.mjs");
    expect(scripts.coverage).toBe("node scripts/coverage.mjs");
    expect(scripts.docs).toBe("cd docs && bunx mintlify dev");
    expect(scripts["docs:llms"]).toBe("bun scripts/generate-llms.ts && bun scripts/optimize-llms-full.ts");
    expect(scripts["docs:components"]).toBe("node scripts/generate-component-source.mjs");
    expect(scripts["generate:init-pack"]).toBe("bun scripts/generate-workflow-pack.ts");
    expect(scripts["sota:gen"]).toBe("bun scripts/generate-sota.ts");
    expect(scripts["sota:research"]).toBe("bun scripts/sota-research.ts");
    expect(scripts["check:effect"]).toBe("node scripts/check-single-effect-version.mjs");
    expect(scripts["check:deps"]).toBe("node scripts/check-dependency-boundaries.mjs");
    expect(scripts["check:db-access"]).toBe("node scripts/check-no-direct-db-access.mjs");
    expect(scripts["check:docs"]).toBe("node scripts/check-docs.mjs");
    expect(scripts["check:llms"]).toBe("node scripts/check-llms.mjs");
    expect(scripts["check:sota"]).toBe("node scripts/check-sota.mjs");
    expect(scripts["check:dts"]).toBe("node scripts/check-dts.mjs");
    expect(scripts["fetch:jj"]).toBe("node scripts/fetch-jj-binaries.mjs");
    expect(scripts.observability).toBeUndefined();
    expect(scripts.test).toBe(
      "node scripts/run-test-gates.mjs && node scripts/check-dts.mjs && pnpm -r --no-bail test",
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
      "scripts/run-test-gates.mjs",
      "scripts/run-test-gates.test.mjs",
      "scripts/verify-observability.sh",
    ]) expectFile(path);

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
    expectText(".github/workflows/ci.yml", [
      "  typecheck:",
      "  test:",
      "  coverage:",
      "  test-postgres:",
      "node-version: 22",
      "bun-version: 1.3.13",
      "sudo apt-get update && sudo apt-get install -y ripgrep",
      "choco install ripgrep -y",
      "node scripts/run-test-gates.mjs",
      "node scripts/check-dts.mjs",
      "pnpm -r --no-bail test",
      "pnpm -C .smithers test:ddd",
      "node scripts/run-workspace-tests.mjs --shard",
      "bun test examples/bun-port-smithers/components/porting-rules.test.ts examples/context-handoff/workflow.test.ts",
      "bun test --timeout=120000 apps/cli/tests/tui-zmux.e2e.test.js",
      "run: pnpm coverage",
      "docker compose -f deploy/electric/docker-compose.yml up -d postgres",
      "SMITHERS_TEST_PG_URL:",
    ]);
    expectText(".github/workflows/faults.yml", [
      "pnpm -r build",
      "pnpm --filter @smithers-orchestrator/e2e test:faults",
    ]);
    expectText(".github/workflows/faults-nightly.yml", [
      'SMITHERS_E2E_SOAK: "1"',
      "pnpm -r build",
      "pnpm --filter @smithers-orchestrator/e2e test:soak",
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
      'bun", ["scripts/generate-llms.ts"]',
      'bun", ["scripts/optimize-llms-full.ts"]',
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
    expectText("scripts/run-test-gates.mjs", [
      "scripts/run-test-gates.test.mjs",
      "scripts/check-single-effect-version.mjs",
      "scripts/check-dependency-boundaries.mjs",
      "scripts/check-no-direct-db-access.mjs",
      "scripts/check-docs.mjs",
      "scripts/check-llms.mjs",
      "scripts/check-sota.mjs",
      "scripts/check-smithers-test-script.mjs",
      "spawnSync",
      "terminated by",
    ]);
    expectText("scripts/run-test-gates.test.mjs", [
      "pins the canonical gate roster",
      "stops immediately and preserves the first nonzero status",
      "treats launch errors and signal termination as failures",
    ]);
    expectText("scripts/check-sota.mjs", [
      "docs/reference/sota-models.mdx",
      "apps/cli/src/sota-models.generated.js",
      "scripts/generate-sota.ts",
      "scripts/sota.test.ts",
    ]);
    expectText("scripts/generate-sota.ts", ["SOTA_REGISTRY_VERSION", "SOTA_ROLE_MODELS", "SOTA_DEPRECATED_MODELS"]);
    expectText("scripts/sota-research.ts", ["scripts/generate-sota.ts", 'pnpm", ["docs:llms"]', 'pnpm", ["generate:init-pack"]']);
    expectText("scripts/check-dts.mjs", [
      '  "packages/agents",',
      '  "packages/graph",',
      '  "packages/http-client",',
      '  "packages/integrations",',
      '  "packages/openapi",',
      "restoreDeclarations(srcDir, committed)",
      'pnpm", ["-C", pkg, "run", "build"]',
    ]);
    expectText("scripts/check-fault-skips.mjs", ["allowedSkips", "skipPattern", "no untracked skips"]);
    expectText("scripts/normalize-bunx.ts", ["bunx smithers-orchestrator", "normalizeCommands", "normalizeInline", "README.md"]);
    expectText("scripts/normalize-placeholders.ts", ["<run-id>", "RUN_ID", "NODE_ID", "WORKFLOW_ID", "isPathOrUrlContext"]);
    expectText("scripts/generate-component-source.mjs", ["Composite", "GENERATED:COMPONENT-SOURCE START", "GENERATED:COMPONENT-SOURCE END", "--check"]);
    expectText("scripts/generate-workflow-pack.ts", ["SEEDED_WORKFLOW_IDS", "// smithers-source: seeded", "GENERATED_SEEDED_FILES"]);
    expectText("scripts/generate-ui-themes.ts", ["crepeTheme.generated.ts", "xyflowTheme.generated.ts", "@xyflow/react/dist/style.css"]);
    expectText("scripts/publish.mjs", ["pnpm check:llms", "pnpm -r build", "pnpm test", "pnpm fetch:jj", "--skip-gh-release"]);
    expectText("scripts/fetch-jj-binaries.mjs", ["jj-vcs/jj", "JJ_VERSION", "--force", "jj-darwin-arm64", "jj-win32-x64", "commit nothing"]);
    expectText("scripts/coverage.mjs", ["thresholdProfiles", "packageProfiles", "coverageUnsupported", "SMITHERS_COVERAGE_PACKAGES"]);
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
    expectText("scripts/readme-contract.test.mjs", ["Live workflow runs:", "<Loop>", "Ralph"]);
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
      "smithers.db",
      "smithers.db-shm",
      "smithers.db-wal",
      "**/tmp/verification/",
      "apps/observability/data/",
    ]) {
      expect(lines).toContain(pattern);
    }
    expect(lines).not.toContain(".smithers/");
    expect(lines).toContain("!docs/reference/");
    expect(lines).toContain("!deploy/reference/");
    expect(lines).toContain("!deploy/reference/**");
  });
});
