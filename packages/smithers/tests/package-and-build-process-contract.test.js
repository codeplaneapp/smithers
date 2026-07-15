import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const created = [];
let importCounter = 0;

setDefaultTimeout(30_000);

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function repoTempRoot(prefix) {
  const base = join(root, "tmp");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, prefix));
  created.push(dir);
  return dir;
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function linkDir(target, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(target, dest, process.platform === "win32" ? "junction" : "dir");
}

function run(command, args, options) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function expectSuccess(result) {
  expect(
    result.status,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function expectFailure(result) {
  expect(
    result.status,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).not.toBe(0);
}

async function importDependencyBoundaryModule(cwd) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const scriptUrl = pathToFileURL(resolve(root, "scripts/check-dependency-boundaries.mjs")).href;
    return await import(`${scriptUrl}?unit=${importCounter++}`);
  } finally {
    process.chdir(previous);
  }
}

function scaffoldConsumer() {
  const dir = tempRoot("smithers-package-consumer-");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  linkDir(resolve(root, "packages/smithers"), join(dir, "node_modules/smithers-orchestrator"));
  if (existsSync(resolve(root, "node_modules/@types"))) {
    linkDir(resolve(root, "node_modules/@types"), join(dir, "node_modules/@types"));
  }
  return dir;
}

describe("PACKAGE_AND_BUILD process contracts", () => {
  test("published facade subpaths resolve from a real Bun consumer install", () => {
    const dir = scaffoldConsumer();
    const script = `
      const specs = [
        "smithers-orchestrator",
        "smithers-orchestrator/tools",
        "smithers-orchestrator/testing",
        "smithers-orchestrator/jsx-runtime",
        "smithers-orchestrator/jsx-dev-runtime",
        "smithers-orchestrator/gateway-client",
        "smithers-orchestrator/gateway-react",
        "smithers-orchestrator/scorers",
        "smithers-orchestrator/gateway-ui",
        "smithers-orchestrator/ui",
        "smithers-orchestrator/sandbox",
        "smithers-orchestrator/telegram",
        "smithers-orchestrator/control-plane",
        "smithers-orchestrator/cloudflare",
        "smithers-orchestrator/daytona",
        "smithers-orchestrator/microsandbox",
        "smithers-orchestrator/vercel",
        "smithers-orchestrator/aws",
        "smithers-orchestrator/gcp",
        "smithers-orchestrator/dom/renderer",
        "smithers-orchestrator/gateway",
        "smithers-orchestrator/mdx-plugin",
        "smithers-orchestrator/memory",
        "smithers-orchestrator/observability",
        "smithers-orchestrator/openapi",
        "smithers-orchestrator/serve",
        "smithers-orchestrator/server",
      ];
      const resolved = [];
      for (const spec of specs) {
        const mod = await import(spec);
        resolved.push([spec, Object.keys(mod).length]);
      }
      for (const spec of ["smithers-orchestrator/pi-plugin", "smithers-orchestrator/pi-extension"]) {
        try {
          await import(spec);
          resolved.push([spec, "unexpected-success"]);
        } catch (error) {
          resolved.push([spec, error.code || error.name]);
        }
      }
      console.log(JSON.stringify(resolved));
    `;

    const result = run("bun", ["--eval", script], { cwd: dir });
    expectSuccess(result);
    const rows = JSON.parse(result.stdout);
    const failures = rows.filter(([, count]) => count === 0 || count === "unexpected-success");
    expect(failures).toEqual([]);
    expect(Object.fromEntries(rows)["smithers-orchestrator/pi-plugin"]).toBe("ERR_MODULE_NOT_FOUND");
    expect(Object.fromEntries(rows)["smithers-orchestrator/pi-extension"]).toBe("ERR_MODULE_NOT_FOUND");
  });

  test("published type stubs and JSX runtime typecheck from a real TypeScript consumer", () => {
    const dir = scaffoldConsumer();
    write(
      join(dir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            module: "ESNext",
            target: "ESNext",
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            strict: true,
            skipLibCheck: true,
            jsx: "react-jsx",
            jsxImportSource: "smithers-orchestrator",
            noEmit: true,
            types: ["node"],
          },
          include: ["app.tsx"],
        },
        null,
        2,
      ),
    );
    write(
      join(dir, "app.tsx"),
      `
        import { Workflow, Task, createSmithers, defineTool } from "smithers-orchestrator";
        import { jsx } from "smithers-orchestrator/jsx-runtime";
        import { runTask } from "smithers-orchestrator/testing";
        import * as gatewayClient from "smithers-orchestrator/gateway-client";
        import * as gatewayReact from "smithers-orchestrator/gateway-react";
        import * as scorers from "smithers-orchestrator/scorers";
        import * as sandbox from "smithers-orchestrator/sandbox";
        import * as cloudflare from "smithers-orchestrator/cloudflare";
        import type { CreateSmithersApi, SmithersWorkflow, TaskProps } from "smithers-orchestrator";

        const workflow = <Workflow name="consumer"><Task id="task" output="task">hi</Task></Workflow>;
        const create: typeof createSmithers = createSmithers;
        const api = create({}) satisfies CreateSmithersApi<Record<string, never>>;
        const props: TaskProps = { id: "typed", output: "typed", children: "ok" };
        let flow: SmithersWorkflow<Record<string, never>> | undefined;
        void [api, defineTool, jsx, runTask, gatewayClient, gatewayReact, scorers, sandbox, cloudflare, props, flow, workflow];
      `,
    );

    const result = run(resolve(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json", "--noEmit"], {
      cwd: dir,
    });
    expectSuccess(result);
  });

  test("dependency-boundary gate fails loudly for undeclared runtime workspace imports", () => {
    const dir = tempRoot("smithers-dep-boundary-fail-");
    write(join(dir, "package.json"), JSON.stringify({ name: "fixture-root", type: "module" }));
    write(
      join(dir, "packages/consumer/package.json"),
      JSON.stringify({ name: "@fixture/consumer", type: "module", dependencies: {} }),
    );
    write(
      join(dir, "packages/provider/package.json"),
      JSON.stringify({ name: "@fixture/provider", type: "module" }),
    );
    write(join(dir, "packages/provider/src/index.js"), "export const value = 1;\n");
    write(join(dir, "packages/consumer/src/index.js"), 'import { value } from "@fixture/provider";\nexport { value };\n');

    const result = run(process.execPath, [resolve(root, "scripts/check-dependency-boundaries.mjs")], {
      cwd: dir,
    });
    expectFailure(result);
    expect(result.stderr).toContain("Dependency boundary check failed");
    expect(result.stderr).toContain("packages/consumer/src/index.js imports @fixture/provider");
    expect(result.stderr).toContain("declare @fixture/provider as a workspace dependency in dependencies");
  });

  test("dependency-boundary gate accepts direct workspaces, dev-only imports, and dangling local artifacts", () => {
    const dir = tempRoot("smithers-dep-boundary-pass-");
    write(join(dir, "package.json"), JSON.stringify({ name: "fixture-root", type: "module" }));
    write(
      join(dir, "packages/provider/package.json"),
      JSON.stringify({ name: "@fixture/provider", type: "module" }),
    );
    write(join(dir, "packages/provider/src/index.js"), "export const value = 1;\n");
    write(
      join(dir, "packages/consumer/package.json"),
      JSON.stringify({
        name: "@fixture/consumer",
        type: "module",
        dependencies: { "@fixture/provider": "workspace:*" },
        devDependencies: { yaml: "^2.0.0" },
      }),
    );
    write(join(dir, "packages/consumer/src/index.js"), 'export { value } from "@fixture/provider";\n');
    write(join(dir, "packages/consumer/tests/dev-only.test.js"), 'import YAML from "yaml";\nexport { YAML };\n');
    write(
      join(dir, "apps/worker/package.json"),
      JSON.stringify({ name: "@fixture/worker", type: "module", dependencies: { "@fixture/provider": "workspace:*" } }),
    );
    write(join(dir, "apps/worker/src/index.js"), 'export { value } from "@fixture/provider";\n');
    write(
      join(dir, "e2e/package.json"),
      JSON.stringify({ name: "@fixture/e2e", type: "module", devDependencies: { "@fixture/provider": "workspace:*" } }),
    );
    write(join(dir, "e2e/runtime.test.ts"), 'import { value } from "@fixture/provider";\nexport { value };\n');
    write(
      join(dir, ".smithers/package.json"),
      JSON.stringify({ name: "fixture-workflows", type: "module", dependencies: { "@fixture/provider": "workspace:*" } }),
    );
    write(join(dir, ".smithers/workflows/direct-workspace.tsx"), 'import { value } from "@fixture/provider";\nexport default value;\n');
    linkDir(join(dir, "missing-worktree-target"), join(dir, "packages/consumer/src/dangling-artifact"));

    const result = run(process.execPath, [resolve(root, "scripts/check-dependency-boundaries.mjs")], {
      cwd: dir,
    });
    expectSuccess(result);
    expect(result.stdout).toContain("Dependency boundary check passed for 6 package(s).");
  });

  test("dependency-boundary collector skips symlinked source directories without duplicate traversal", async () => {
    const dir = repoTempRoot("smithers-dep-boundary-symlink-");
    const srcDir = join(relative(root, dir), "packages", "consumer", "src");
    write(join(dir, "package.json"), JSON.stringify({ name: "fixture-root", type: "module" }));
    write(
      join(dir, "packages/consumer/package.json"),
      JSON.stringify({ name: "@fixture/consumer", type: "module" }),
    );
    write(join(dir, "packages/consumer/src/index.ts"), "export const value = 1;\n");
    linkDir(join(dir, "packages/consumer/src"), join(dir, "packages/consumer/src/cycle"));

    const { collectSourceFiles } = await importDependencyBoundaryModule(root);
    const files = [];
    const nestedPackageDirs = [];
    expect(() => collectSourceFiles(srcDir, files, nestedPackageDirs)).not.toThrow();
    expect(files).toEqual([join(srcDir, "index.ts")]);
    expect(nestedPackageDirs).toEqual([]);
  });

  test("dependency-boundary collector records nested packages without scanning them as parent sources", async () => {
    const dir = repoTempRoot("smithers-dep-boundary-nested-package-");
    const srcDir = join(relative(root, dir), "packages", "consumer", "src");
    write(join(dir, "package.json"), JSON.stringify({ name: "fixture-root", type: "module" }));
    write(
      join(dir, "packages/consumer/package.json"),
      JSON.stringify({ name: "@fixture/consumer", type: "module" }),
    );
    write(join(dir, "packages/consumer/src/index.ts"), "export const parent = 1;\n");
    write(
      join(dir, "packages/consumer/src/plugin/package.json"),
      JSON.stringify({ name: "@fixture/plugin", type: "module" }),
    );
    write(join(dir, "packages/consumer/src/plugin/index.ts"), "export const plugin = 1;\n");

    const { collectSourceFiles } = await importDependencyBoundaryModule(root);
    const files = [];
    const nestedPackageDirs = [];
    collectSourceFiles(srcDir, files, nestedPackageDirs);

    expect(files).toEqual([join(srcDir, "index.ts")]);
    expect(nestedPackageDirs).toEqual([join(srcDir, "plugin")]);
  });
});
