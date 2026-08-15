import { describe, expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { GatewayExtensions } from "@smthrs/server/GatewayExtensions";
import {
  findPackExtensionsFile,
  findPackExtensionsFiles,
  loadPackExtensions,
  registerPackExtensions,
} from "../src/pack-extensions.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "smithers-pack-extensions-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(relativePath, contents) {
      const file = join(root, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents, "utf8");
      return file;
    },
  };
}

describe("pack extension discovery", () => {
  test("uses workflow-pack precedence and one declaration per pack", () => {
    const repo = fixture();
    const globalHome = join(repo.root, "global-smithers");
    const localTs = repo.write(".smithers/gateway-extensions.ts", "export default {};\n");
    repo.write(".smithers/gateway-extensions.js", "export default {};\n");
    repo.write(".smithers/packs/local-addon/smithers.toon", "name: local-addon\n");
    const localAddon = repo.write(".smithers/packs/local-addon/gateway-extensions.mjs", "export default {};\n");
    const globalJs = repo.write("global-smithers/gateway-extensions.js", "export default {};\n");
    repo.write("global-smithers/packs/global-addon/smithers.toon", "name: global-addon\n");
    const globalAddon = repo.write("global-smithers/packs/global-addon/gateway-extensions.tsx", "export default {};\n");
    const env = { ...process.env, SMITHERS_HOME: globalHome };

    expect(findPackExtensionsFiles(repo.root, env)).toEqual([localTs, localAddon, globalJs, globalAddon]);
    expect(findPackExtensionsFile(repo.root, env)).toBe(localTs);
  });

  test("loads TypeScript default and named exports and rejects non-object declarations", async () => {
    const repo = fixture();
    const defaultFile = repo.write(
      "default.ts",
      'const declaration: Record<string, unknown> = { vault: { title: "Vault" } };\nexport default declaration;\n',
    );
    const namedFile = repo.write("named.mjs", 'export const extensions = { search: { title: "Search" } };\n');
    const invalidFile = repo.write("invalid.js", "export default [];\n");

    expect(await loadPackExtensions(defaultFile)).toEqual({ vault: { title: "Vault" } });
    expect(await loadPackExtensions(namedFile)).toEqual({ search: { title: "Search" } });
    await expect(loadPackExtensions(invalidFile)).rejects.toThrow("must default-export an object");
  });
});

describe("pack extension registration", () => {
  test("isolates broken packs, getters, invalid namespaces, and lower-precedence collisions", async () => {
    const repo = fixture();
    const globalHome = join(repo.root, "global-smithers");
    repo.write(
      ".smithers/gateway-extensions.js",
      [
        "const extensions = {",
        '  get poison() { throw new Error("poison getter"); },',
        '  "invalid namespace": { resources: {} },',
        '  vault: { resources: { file: { handler: async () => ({ source: "local" }) } } },',
        "};",
        "export default extensions;",
        "",
      ].join("\n"),
    );
    repo.write(".smithers/packs/broken/smithers.toon", "name: broken\n");
    repo.write(".smithers/packs/broken/gateway-extensions.js", 'throw new Error("broken pack");\n');
    repo.write(
      "global-smithers/gateway-extensions.js",
      [
        "export default {",
        '  vault: { resources: { file: { handler: async () => ({ source: "global" }) } } },',
        '  globalOnly: { resources: { ping: { handler: async () => "pong" } } },',
        "};",
        "",
      ].join("\n"),
    );
    const registry = new GatewayExtensions();
    const warnings = [];
    const info = [];

    const registered = await registerPackExtensions(
      { extend: (namespace, definition) => registry.register(namespace, definition) },
      repo.root,
      { warn: (message) => warnings.push(message), info: (message) => info.push(message) },
      { ...process.env, SMITHERS_HOME: globalHome },
    );

    expect(registered).toEqual(["vault", "globalOnly"]);
    expect([...registry.namespaces.keys()]).toEqual(["vault", "globalOnly"]);
    expect(warnings.join("\n")).toContain("poison getter");
    expect(warnings.join("\n")).toContain("invalid namespace");
    expect(warnings.join("\n")).toContain("broken pack");
    expect(warnings.join("\n")).toContain("namespace already registered: vault");
    expect(info).toEqual(["[gateway] pack extensions: vault, globalOnly"]);
  });
});
