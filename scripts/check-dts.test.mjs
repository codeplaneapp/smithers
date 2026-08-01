import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkDeclarations, DEFAULT_DECLARATION_PACKAGES } from "./check-dts.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The Effect 4 migration seams this suite guards regressed via TS2694
// ("<namespace> has no exported member") living *inside* a shipped `.d.ts`
// (e.g. `Context.Tag`/`Context.TagClass` no longer exist in Effect 4). The
// declaration freshness gate only rebuilds packages listed in
// DEFAULT_DECLARATION_PACKAGES, and every consumer fixture in the repo compiles
// with `skipLibCheck: true`, which suppresses errors in imported declarations —
// so nothing prevents that exact regression from reaching CI. This test locks
// in both halves: the affected packages are gated, and a `skipLibCheck: false`
// consumer surfaces a TS2694 that `skipLibCheck: true` would hide.
test("skipLibCheck:false surfaces a TS2694 in an imported declaration that the affected packages are gated for", (context) => {
  for (const pkg of [
    "apps/observability",
    "packages/engine",
    "packages/memory",
    "packages/sandbox",
    "packages/scheduler",
  ]) {
    assert.ok(DEFAULT_DECLARATION_PACKAGES.includes(pkg), `${pkg} must be gated by the declaration freshness check`);
  }

  const fixtureRoot = mkdtempSync(join(tmpdir(), "smithers-dts-consumer-"));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  // A dependency namespace that mirrors Effect's `Context`: it exports `Tag`
  // but not `TagClass`, exactly the shape the migration collided with.
  writeFileSync(
    join(fixtureRoot, "context.d.ts"),
    `export declare namespace Context {\n  export interface Tag<A> {\n    readonly value: A;\n  }\n}\n`,
  );
  // A shipped declaration that references the missing namespace member — the
  // TS2694 regression. It lives in a `.d.ts`, so `skipLibCheck: true` hides it.
  writeFileSync(
    join(fixtureRoot, "affected.d.ts"),
    `import type { Context } from "./context.js";\nexport type AffectedService = Context.TagClass<string>;\n`,
  );
  writeFileSync(
    join(fixtureRoot, "consumer.ts"),
    `import type { AffectedService } from "./affected.js";\nexport type Consumed = AffectedService;\n`,
  );

  const runTsc = (skipLibCheck) => {
    const tsconfigPath = join(fixtureRoot, `tsconfig.${skipLibCheck ? "skip" : "strict"}.json`);
    writeFileSync(
      tsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck,
            strict: true,
            target: "ES2022",
            types: [],
          },
          files: [join(fixtureRoot, "consumer.ts")],
        },
        null,
        2,
      )}\n`,
    );
    return spawnSync("pnpm", ["exec", "tsc", "--project", tsconfigPath], { cwd: repoRoot, encoding: "utf8" });
  };

  const suppressed = runTsc(true);
  assert.equal(suppressed.status, 0, `skipLibCheck:true should hide the declaration error\n${suppressed.stdout}${suppressed.stderr}`);

  const surfaced = runTsc(false);
  assert.notEqual(surfaced.status, 0, "skipLibCheck:false must reject the TS2694 regression");
  assert.match(`${surfaced.stdout}${surfaced.stderr}`, /error TS2694/);
});

test("the declaration gate covers gateway bundle drift and restores the tree", (context) => {
  assert.ok(DEFAULT_DECLARATION_PACKAGES.includes("packages/gateway"));
  assert.ok(DEFAULT_DECLARATION_PACKAGES.includes("packages/gateway-react"));

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
