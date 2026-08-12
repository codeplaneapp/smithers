import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveJsxImportSource } from "../src/node-loader/resolveJsxImportSource.js";
import { smithersRuntimeSpawn } from "../src/node-loader/smithersRuntimeSpawn.js";

const scratch = mkdtempSync(join(tmpdir(), "smithers-node-loader-"));

/** @param {string} source */
function runUnderNode(source) {
  return execFileSync("node", ["--input-type=module", "-e", source], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("resolveJsxImportSource", () => {
  test("reads the nearest tsconfig", () => {
    const dir = join(scratch, "workflow", "nested");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(scratch, "workflow", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "smthrs" } }),
    );
    expect(resolveJsxImportSource(dir)).toBe("smthrs");
  });

  test("a nearer tsconfig wins", () => {
    const dir = join(scratch, "workflow", "tui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), '{ "compilerOptions": { "jsxImportSource": "@opentui/react" } }');
    expect(resolveJsxImportSource(dir)).toBe("@opentui/react");
  });

  test("tolerates comments and trailing commas", () => {
    const dir = join(scratch, "jsonc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tsconfig.json"),
      '{\n  // a comment\n  "compilerOptions": {\n    "jsxImportSource": "preact",\n  },\n}\n',
    );
    expect(resolveJsxImportSource(dir)).toBe("preact");
  });

  test("falls back to react when no tsconfig declares one", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-no-tsconfig-"));
    expect(resolveJsxImportSource(dir)).toBe("react");
  });
});

describe("smithersRuntimeSpawn", () => {
  test("runs the entry file directly under Bun", () => {
    const spawned = smithersRuntimeSpawn(["/entry.js", "up"]);
    expect(spawned.command).toBe("bun");
    expect(spawned.args).toEqual(["/entry.js", "up"]);
  });

  test("uses the Node executable and the loader hook under Node", () => {
    const url = new URL("../src/node-loader/smithersRuntimeSpawn.js", import.meta.url).href;
    const output = runUnderNode(`
      const { smithersRuntimeSpawn } = await import(${JSON.stringify(url)});
      const spawned = smithersRuntimeSpawn(["/entry.js", "up"]);
      console.log(JSON.stringify({ isNode: spawned.command === process.execPath, args: spawned.args }));
    `);
    const spawned = JSON.parse(output);
    expect(spawned.isNode).toBe(true);
    expect(spawned.args[0]).toBe("--import");
    expect(spawned.args[1]).toContain("node-loader/register.js");
    expect(spawned.args.slice(2)).toEqual(["/entry.js", "up"]);
  });
});

describe("registerNodeWorkflowLoader", () => {
  const registerUrl = new URL("../src/node-loader/registerNodeWorkflowLoader.js", import.meta.url).href;

  test("is a no-op under Bun", async () => {
    const { registerNodeWorkflowLoader } = await import("../src/node-loader/registerNodeWorkflowLoader.js");
    expect(registerNodeWorkflowLoader()).toBe(false);
  });

  test("compiles a .tsx module under Node using the tsconfig jsx runtime", () => {
    // The JSX runtime is a local file so the test asserts the resolved import
    // source rather than whatever happens to be installed.
    const dir = mkdtempSync(join(tmpdir(), "smithers-tsx-"));
    const runtimeDir = join(dir, "node_modules", "probe-runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "package.json"),
      JSON.stringify({
        name: "probe-runtime",
        version: "1.0.0",
        type: "module",
        exports: { "./jsx-runtime": "./jsx-runtime.js" },
      }),
    );
    writeFileSync(
      join(runtimeDir, "jsx-runtime.js"),
      "export const jsx = (type, props) => ({ runtime: 'probe-runtime', type, props });\nexport const jsxs = jsx;\nexport const Fragment = 'fragment';\n",
    );
    writeFileSync(join(dir, "tsconfig.json"), '{ "compilerOptions": { "jsxImportSource": "probe-runtime" } }');
    writeFileSync(
      join(dir, "component.tsx"),
      'const label: string = "compiled";\nexport const element = <div id={label} />;\n',
    );
    const output = runUnderNode(`
      const { registerNodeWorkflowLoader } = await import(${JSON.stringify(registerUrl)});
      registerNodeWorkflowLoader();
      const mod = await import(${JSON.stringify(join(dir, "component.tsx"))});
      console.log(JSON.stringify(mod.element));
    `);
    expect(JSON.parse(output)).toEqual({ runtime: "probe-runtime", type: "div", props: { id: "compiled" } });
  });

  test("compiles a .ts module that lives under node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-nm-ts-"));
    const pkgDir = join(dir, "node_modules", "typed-pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "value.ts"), "export const value: string = 'from node_modules';\n");
    const output = runUnderNode(`
      const { registerNodeWorkflowLoader } = await import(${JSON.stringify(registerUrl)});
      registerNodeWorkflowLoader();
      const mod = await import(${JSON.stringify(join(pkgDir, "value.ts"))});
      console.log(mod.value);
    `);
    expect(output.trim()).toBe("from node_modules");
  });

  test("resolves a TypeScript-style ./x.js specifier that points at x.ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-ts-specifier-"));
    writeFileSync(join(dir, "target.ts"), "export const value: string = 'remapped';\n");
    writeFileSync(join(dir, "entry.ts"), "export { value } from './target.js';\n");
    const output = runUnderNode(`
      const { registerNodeWorkflowLoader } = await import(${JSON.stringify(registerUrl)});
      registerNodeWorkflowLoader();
      const mod = await import(${JSON.stringify(join(dir, "entry.ts"))});
      console.log(mod.value);
    `);
    expect(output.trim()).toBe("remapped");
  });
});
