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

test("the affected public declarations compile for a skipLibCheck:false consumer", (context) => {
  for (const pkg of affectedDeclarationPackages) {
    assert.ok(DEFAULT_DECLARATION_PACKAGES.includes(pkg), `${pkg} must be gated by the declaration freshness check`);
    assert.doesNotMatch(
      readFileSync(join(repoRoot, pkg, "src/index.d.ts"), "utf8"),
      /Context\.Tag(?:Class(?:Shape)?)?\b/,
      `${pkg} must not ship removed Effect 3 Context types`,
    );
  }

  const fixtureRoot = mkdtempSync(join(repoRoot, ".smithers-dts-consumer-"));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  writeFileSync(
    join(fixtureRoot, "context.d.ts"),
    `export interface Service<Identifier, Shape> {
  readonly Identifier: Identifier;
  readonly Service: Shape;
}

export interface ServiceClass<Self, Identifier extends string, Shape> extends Service<Self, Shape> {
  new (_: never): ServiceClass.Shape<Identifier, Shape>;
}

export declare namespace ServiceClass {
  interface Shape<Identifier extends string, Shape> {
    readonly key: Identifier;
    readonly Service: Shape;
  }
}
`,
  );
  writeFileSync(
    join(fixtureRoot, "affected.d.ts"),
    `import * as Context from "./context.js";

interface EmptyService {}

export interface CorrelationContextService
  extends Context.ServiceClass.Shape<"CorrelationContextService", EmptyService> {}
export declare const CorrelationContextService: Context.ServiceClass<
  CorrelationContextService,
  "CorrelationContextService",
  EmptyService
>;

export interface MetricsService extends Context.ServiceClass.Shape<"MetricsService", EmptyService> {}
export declare const MetricsService: Context.ServiceClass<MetricsService, "MetricsService", EmptyService>;

export interface SmithersObservability
  extends Context.ServiceClass.Shape<"SmithersObservability", EmptyService> {}
export declare const SmithersObservability: Context.ServiceClass<
  SmithersObservability,
  "SmithersObservability",
  EmptyService
>;

export interface TracingService extends Context.ServiceClass.Shape<"TracingService", EmptyService> {}
export declare const TracingService: Context.ServiceClass<TracingService, "TracingService", EmptyService>;

export declare const SmithersSqlite: Context.Service<unknown, unknown>;

export interface MemoryService extends Context.ServiceClass.Shape<"MemoryService", EmptyService> {}
export declare const MemoryService: Context.ServiceClass<MemoryService, "MemoryService", EmptyService>;

export interface SandboxTransport extends Context.ServiceClass.Shape<"SandboxTransport", EmptyService> {}
export declare const SandboxTransport: Context.ServiceClass<SandboxTransport, "SandboxTransport", EmptyService>;

export interface Scheduler extends Context.ServiceClass.Shape<"Scheduler", EmptyService> {}
export declare const Scheduler: Context.ServiceClass<Scheduler, "Scheduler", EmptyService>;

export interface WorkflowSession extends Context.ServiceClass.Shape<"WorkflowSession", EmptyService> {}
export declare const WorkflowSession: Context.ServiceClass<WorkflowSession, "WorkflowSession", EmptyService>;
`,
  );
  writeFileSync(
    join(fixtureRoot, "consumer.ts"),
    `import type {
  CorrelationContextService,
  MetricsService,
  SmithersObservability,
  TracingService,
  SmithersSqlite,
  MemoryService,
  SandboxTransport,
  Scheduler,
  WorkflowSession,
} from "./affected.js";

export type AffectedServices = [
  typeof CorrelationContextService,
  typeof MetricsService,
  typeof SmithersObservability,
  typeof TracingService,
  typeof SmithersSqlite,
  typeof MemoryService,
  typeof SandboxTransport,
  typeof Scheduler,
  typeof WorkflowSession,
];
`,
  );

  const tsconfigPath = join(fixtureRoot, "tsconfig.json");
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
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
  assert.equal(tsc.status, 0, `strict declaration consumer failed\n${tsc.stdout}${tsc.stderr}`);
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
