import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkDeclarations, DEFAULT_DECLARATION_PACKAGES } from "./check-dts.mjs";

test("the declaration gate covers gateway bundle drift and restores the tree", (context) => {
  assert.ok(DEFAULT_DECLARATION_PACKAGES.includes("packages/gateway"));

  const repoRoot = mkdtempSync(join(tmpdir(), "smithers-check-dts-"));
  context.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  const gatewayRoot = join(repoRoot, "packages/gateway");
  const declaration = join(gatewayRoot, "src/index.d.ts");
  mkdirSync(join(gatewayRoot, "src"), { recursive: true });
  writeFileSync(join(gatewayRoot, "tsup.config.ts"), "export default {};\n");
  writeFileSync(declaration, "export declare const stale: true;\n");

  const errors = [];
  const passed = checkDeclarations({
    repoRoot,
    packages: ["packages/gateway"],
    runBuild: () => writeFileSync(declaration, "export declare const fresh: true;\n"),
    write: () => {},
    log: () => {},
    error: (message) => errors.push(message),
  });

  assert.equal(passed, false);
  assert.match(errors.join("\n"), /index\.d\.ts \(stale/);
  assert.equal(readFileSync(declaration, "utf8"), "export declare const stale: true;\n");
});

test("the default declaration gate covers the xstate package", () => {
  assert.ok(DEFAULT_DECLARATION_PACKAGES.includes("packages/xstate"));
});

test("the declaration gate fails when an expected package has no tsup config", (context) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "smithers-check-dts-"));
  context.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  mkdirSync(join(repoRoot, "packages/gateway/src"), { recursive: true });

  const errors = [];
  let buildCalled = false;
  const passed = checkDeclarations({
    repoRoot,
    packages: ["packages/gateway"],
    runBuild: () => {
      buildCalled = true;
    },
    write: () => {},
    log: () => {},
    error: (message) => errors.push(message),
  });

  assert.equal(passed, false);
  assert.equal(buildCalled, false);
  assert.match(errors.join("\n"), /packages\/gateway has no tsup\.config\.ts/);
});
