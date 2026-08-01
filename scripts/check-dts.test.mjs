import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkDeclarations, DEFAULT_DECLARATION_PACKAGES } from "./check-dts.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const affectedDeclarationPackages = [
  "apps/observability",
  "packages/engine",
  "packages/memory",
  "packages/sandbox",
  "packages/scheduler",
];

test("the committed package declarations compile for a skipLibCheck:false consumer", (context) => {
  for (const pkg of affectedDeclarationPackages) {
    assert.ok(DEFAULT_DECLARATION_PACKAGES.includes(pkg), `${pkg} must be gated by the declaration freshness check`);
    assert.doesNotMatch(
      readFileSync(join(repoRoot, pkg, "src/index.d.ts"), "utf8"),
      /Context\.Tag(?:Class(?:Shape)?)?\b/,
      `${pkg} must not ship removed Effect 3 Context types`,
    );
  }

  // Inside the repo so the consumer resolves the real workspace packages and the
  // real `effect` types, not a hand-written stand-in for them.
  const fixtureRoot = mkdtempSync(join(repoRoot, ".smithers-dts-consumer-"));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  writeFileSync(
    join(fixtureRoot, "consumer.ts"),
    `import { Effect, Layer } from "effect";
import { MemoryService, createMemoryLayer } from "@smithers-orchestrator/memory";
import type { MemoryServiceApi, MemoryNamespace } from "@smithers-orchestrator/memory";

// \`yield*\` must surface the service API, so a declaration that lost its
// Context.ServiceClass base (\`declare class MemoryService {}\`) fails here.
export const readFact = Effect.gen(function* () {
  const memory = yield* MemoryService;
  return yield* memory.getFact({ kind: "global", id: "test" } satisfies MemoryNamespace, "k");
});

// The class must still work as a Layer service key.
declare const api: MemoryServiceApi;
export const layer: Layer.Layer<MemoryService> = Layer.succeed(MemoryService, api);

// The shipped layer factory must produce the same service key.
export const provided: Effect.Effect<Awaited<unknown> | undefined, unknown, never> = readFact.pipe(
  Effect.provide(createMemoryLayer({} as Parameters<typeof createMemoryLayer>[0])),
) as never;
`,
  );

  const tsconfigPath = join(fixtureRoot, "tsconfig.json");
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext", "DOM"],
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
          types: ["node", "bun"],
          typeRoots: [join(repoRoot, "node_modules/@types")],
        },
        files: [join(fixtureRoot, "consumer.ts")],
      },
      null,
      2,
    )}\n`,
  );

  const tsc = spawnSync(
    process.execPath,
    [join(repoRoot, "node_modules/typescript/bin/tsc"), "--project", tsconfigPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  // `skipLibCheck: false` type-checks everything the entrypoints reach, so the
  // raw output also carries third-party diagnostics (drizzle-orm, effect) and
  // one pre-existing packages/db defect: its declaration writes
  // `BunSQLiteDatabase<typeof schema>` but drizzle-orm 0.45's type is not
  // generic. Neither is this gate's business, so both are excluded by name
  // rather than silently — narrow the exclusion as those get fixed.
  const knownUnrelatedDeclarations = ["node_modules/", "packages/db/src/index.d.ts"];
  const errors = `${tsc.stdout}${tsc.stderr}`
    .split("\n")
    .filter((line) => /error TS\d+/.test(line))
    .filter((line) => !knownUnrelatedDeclarations.some((known) => line.includes(known)));

  assert.deepEqual(errors, [], `committed declarations failed a strict consumer:\n${errors.join("\n")}`);
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
