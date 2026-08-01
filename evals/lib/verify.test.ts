// Regression tests for the deterministic eval verifier's pass/fail gate.
//
// Bug (H20/M34): the `query`/`sql` verifiers decided pass with a raw
// `got.includes(want)` against the JSON-stringified rows. A scalar expectation
// then substring-matched a larger result — expect "4" passed for a count of
// 14/40/41, and expect "implement" passed for "implementation" — so wrong SQL
// was scored as correct, silently corrupting the scorecard. These exercise the
// fix end-to-end against a real bun:sqlite fixture (no mocks).
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { computeVerdict, type VerifySpec } from "./verify.ts";
import { repoRoot } from "./paths.ts";
import type { CandidateReport } from "./report-schema.ts";

function spec(over: Partial<VerifySpec>): VerifySpec {
  return {
    kind: "query",
    must: [],
    mustNot: [],
    answer: null,
    rubric: null,
    sql: null,
    expect: null,
    db: null,
    required: [],
    requireIdempotencyKey: false,
    requireRevert: false,
    repoRoot: null,
    ...over,
  };
}

function report(sql: string): CandidateReport {
  return { artifact: sql } as unknown as CandidateReport;
}

describe("query verifier whole-cell matching", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function seedDb(create: string, insert: string): string {
    const dir = mkdtempSync(join(tmpdir(), "verify-"));
    dirs.push(dir);
    const path = join(dir, "fixture.db");
    const db = new Database(path);
    db.run(create);
    db.run(insert);
    db.close();
    return path;
  }

  test("a scalar number expect does NOT substring-match a larger number", async () => {
    const db = seedDb(
      "CREATE TABLE runs (id INTEGER)",
      "INSERT INTO runs (id) VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14)",
    );
    const v = spec({ kind: "query", db, expect: "4" });
    // Wrong SQL returns 14 — which CONTAINS "4". Must NOT pass.
    const wrong = await computeVerdict(v, report("SELECT count(*) AS c FROM runs"));
    expect(wrong.passed).toBe(false);
    // Correct SQL returns 4 — must pass (via the single-cell normalizer).
    const right = await computeVerdict(v, report("SELECT count(*) AS c FROM runs WHERE id <= 4"));
    expect(right.passed).toBe(true);
  });

  test("a scalar token expect does NOT substring-match a longer value", async () => {
    const db = seedDb("CREATE TABLE w (name TEXT)", "INSERT INTO w (name) VALUES ('implementation')");
    const v = spec({ kind: "query", db, expect: "implement" });
    const verdict = await computeVerdict(v, report("SELECT name FROM w LIMIT 1"));
    expect(verdict.passed).toBe(false);
  });

  test("column aliasing still matches via the single-cell normalizer", async () => {
    const db = seedDb(
      "CREATE TABLE runs (id INTEGER)",
      "INSERT INTO runs (id) VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14)",
    );
    const v = spec({ kind: "query", db, expect: "14" });
    const verdict = await computeVerdict(v, report("SELECT count(*) AS total FROM runs"));
    expect(verdict.passed).toBe(true);
  });
});

describe("must/mustNot JSX-tag tokens tolerate the createSmithers factory namespace", () => {
  function containsSpec(over: Partial<VerifySpec>): VerifySpec {
    return {
      kind: "contains",
      must: [],
      mustNot: [],
      answer: null,
      rubric: null,
      sql: null,
      expect: null,
      db: null,
      required: [],
      requireIdempotencyKey: false,
      requireRevert: false,
      repoRoot: null,
      ...over,
    };
  }

  // Bug: `must: ["<Task"]` false-failed the documented createSmithers factory
  // form `<parent.Task>` because it was checked with a raw `artifact.includes`.
  // Both `<Task>` (bare import) and `<parent.Task>` (factory member access) are
  // valid, idiomatic ways to reference a component (docs/components/subflow.mdx).
  test("a bare component `must` token matches `<parent.Component>` factory JSX", async () => {
    const v = containsSpec({ must: ["<Workflow", "<Sequence", "<Subflow", "<Task"] });
    const artifact = `
      const parent = createSmithers();
      export default (
        <parent.Workflow>
          <parent.Sequence>
            <parent.Subflow child={child} />
            <parent.Task name="a" run={() => {}} />
          </parent.Sequence>
        </parent.Workflow>
      );
    `;
    const verdict = await computeVerdict(v, report(artifact));
    expect(verdict.passed).toBe(true);
  });

  test("a bare component `must` token still matches a plain bare-imported tag", async () => {
    const v = containsSpec({ must: ["<Task"] });
    const verdict = await computeVerdict(v, report('<Task name="a" run={() => {}} />'));
    expect(verdict.passed).toBe(true);
  });

  test("a bare component `must` token does not false-match a substring of another name", async () => {
    const v = containsSpec({ must: ["<Task"] });
    const verdict = await computeVerdict(v, report('<TaskGroup name="a" />'));
    expect(verdict.passed).toBe(false);
  });
});

describe("workflow-files verifier", () => {
  const workflow = `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
const result = z.object({ message: z.string() });
const { Workflow, Task, Sequence, smithers, outputs } = createSmithers({ result });
export default smithers(() => (
  <Workflow name="hello">
    <Sequence>
      <Task id="draft" output={outputs.result}>{() => ({ message: "draft" })}</Task>
      <Task id="publish" output={outputs.result}>{() => ({ message: "done" })}</Task>
    </Sequence>
  </Workflow>
));`;
  const testSource = `import { expect, test } from "bun:test";
import { renderWorkflow } from "smithers-orchestrator/testing";
import workflow from "../workflows/hello.tsx";
test("graph", async () => {
  const frame = await renderWorkflow(workflow);
  expect(frame.tasks.map(({ nodeId }) => nodeId)).toEqual(["draft", "publish"]);
  expect(frame.tasks[0].outputSchema?.safeParse({ message: "ok" }).success).toBe(true);
  expect(frame.tasks[0].outputSchema?.safeParse({ message: 1 }).success).toBe(false);
});`;
  const packageJson = JSON.stringify({
    scripts: { test: "bun test --preload ./preload.ts ./tests/hello.test.tsx" },
  });
  const workflowFilesSpec = spec({ kind: "workflow-files" });
  const bundle = (over: Record<string, string> = {}) =>
    JSON.stringify({
      ".smithers/workflows/hello.tsx": workflow,
      ".smithers/tests/hello.test.tsx": testSource,
      ".smithers/package.json": packageJson,
      ...over,
    });

  test("passes only a real workflow, substantive renderWorkflow test, and explicit registration", async () => {
    const verdict = await computeVerdict(workflowFilesSpec, report(bundle()));
    expect(verdict.passed, JSON.stringify(verdict, null, 2)).toBe(true);
    expect(verdict.method).toBe("workflow-files");
  }, 30_000);

  test("fails when the testing-library import or registration is missing", async () => {
    const withoutLibrary = testSource.replace(
      'import { renderWorkflow } from "smithers-orchestrator/testing";',
      "const renderWorkflow = async () => ({ tasks: [] });",
    );
    const verdict = await computeVerdict(
      workflowFilesSpec,
      report(
        bundle({
          ".smithers/tests/hello.test.tsx": withoutLibrary,
          ".smithers/package.json": JSON.stringify({ scripts: { test: "bun test" } }),
        }),
      ),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((check) => check.name === "testing-library-import")?.passed).toBe(false);
    expect(verdict.checks.find((check) => check.name === "test-registered")?.passed).toBe(false);
  }, 30_000);

  test("rejects a hollow truthiness smoke test", async () => {
    const hollow = `import { expect, test } from "bun:test";
import { renderWorkflow } from "smithers-orchestrator/testing";
import workflow from "../workflows/hello.tsx";
// Fake source text must not satisfy the machine check:
// expect(frame.tasks.map(({ nodeId }) => nodeId)).toEqual(["draft", "publish"]);
// expect(frame.tasks[0].outputSchema.safeParse({ message: "ok" }).success).toBe(true);
// expect(frame.tasks[0].outputSchema.safeParse({ message: 1 }).success).toBe(false);
test("graph", async () => expect(await renderWorkflow(workflow)).toBeTruthy());`;
    const verdict = await computeVerdict(
      workflowFilesSpec,
      report(bundle({ ".smithers/tests/hello.test.tsx": hollow })),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((check) => check.name === "graph-behavior-assertions")?.passed).toBe(false);
    expect(verdict.checks.find((check) => check.name === "schema-assertions")?.passed).toBe(false);
  }, 30_000);

  test("cannot read files outside the isolated candidate and runtime trees", async () => {
    const readingWorkflow = workflow.replace(
      'import { z } from "zod/v4";',
      `import { readFileSync } from "node:fs";
readFileSync(${JSON.stringify(join(repoRoot(), ".git", "config"))});
import { z } from "zod/v4";`,
    );
    const verdict = await computeVerdict(
      workflowFilesSpec,
      report(bundle({ ".smithers/workflows/hello.tsx": readingWorkflow })),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((check) => check.name === "graph-renders")?.passed).toBe(false);
  }, 30_000);

  test("cannot mutate the read-only candidate bundle", async () => {
    const writingWorkflow = workflow.replace(
      'import { z } from "zod/v4";',
      `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./owned", import.meta.url), "owned");
import { z } from "zod/v4";`,
    );
    const verdict = await computeVerdict(
      workflowFilesSpec,
      report(bundle({ ".smithers/workflows/hello.tsx": writingWorkflow })),
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.find((check) => check.name === "graph-renders")?.passed).toBe(false);
  }, 30_000);

  test("does not inherit credentials from the verifier process", async () => {
    const credential = "SMITHERS_EVAL_TEST_CREDENTIAL";
    process.env[credential] = "must-not-reach-candidate";
    const credentialReadingWorkflow = workflow.replace(
      'import { z } from "zod/v4";',
      `if (process.env.${credential}) throw new Error("inherited verifier credential");
import { z } from "zod/v4";`,
    );
    try {
      const verdict = await computeVerdict(
        workflowFilesSpec,
        report(bundle({ ".smithers/workflows/hello.tsx": credentialReadingWorkflow })),
      );
      expect(verdict.passed, JSON.stringify(verdict, null, 2)).toBe(true);
    } finally {
      delete process.env[credential];
    }
  }, 30_000);

  test("cannot write outside its private runtime directory", async () => {
    const externalDir = mkdtempSync(join(tmpdir(), "verify-external-"));
    const target = join(externalDir, "owned");
    const writingWorkflow = workflow.replace(
      'import { z } from "zod/v4";',
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(target)}, "owned");
import { z } from "zod/v4";`,
    );
    try {
      const verdict = await computeVerdict(
        workflowFilesSpec,
        report(bundle({ ".smithers/workflows/hello.tsx": writingWorkflow })),
      );
      expect(verdict.passed).toBe(false);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("cannot reach a listening network service", async () => {
    const server = spawn(
      process.execPath,
      [
        "-e",
        'const server = Bun.serve({ port: 0, fetch: () => new Response("reachable") }); console.log(server.port); await new Promise(() => {});',
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("test server did not start")), 5_000);
        server.once("error", reject);
        server.stdout.once("data", (chunk) => {
          clearTimeout(timer);
          resolve(Number(String(chunk).trim()));
        });
      });
      const networkingWorkflow = workflow.replace(
        'import { z } from "zod/v4";',
        `try {
  await fetch("http://127.0.0.1:${port}");
  throw new Error("candidate reached the network");
} catch (error) {
  if (error instanceof Error && error.message === "candidate reached the network") throw error;
}
import { z } from "zod/v4";`,
      );
      const verdict = await computeVerdict(
        workflowFilesSpec,
        report(bundle({ ".smithers/workflows/hello.tsx": networkingWorkflow })),
      );
      expect(verdict.passed, JSON.stringify(verdict, null, 2)).toBe(true);
    } finally {
      server.kill();
    }
  }, 30_000);

  test("graph verification applies the same isolation to model-authored modules", async () => {
    const externalDir = mkdtempSync(join(tmpdir(), "verify-graph-external-"));
    const target = join(externalDir, "owned");
    const writingWorkflow = workflow.replace(
      'import { z } from "zod/v4";',
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(target)}, "owned");
import { z } from "zod/v4";`,
    );
    try {
      const verdict = await computeVerdict(spec({ kind: "graph" }), report(writingWorkflow));
      expect(verdict.passed).toBe(false);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("side-effect-marking verifier", () => {
  const sideEffectSpec = (over: Partial<VerifySpec> = {}): VerifySpec => ({
    kind: "side-effect-marking",
    must: [],
    mustNot: [],
    answer: null,
    rubric: null,
    sql: null,
    expect: null,
    db: null,
    required: [],
    requireIdempotencyKey: false,
    requireRevert: false,
    repoRoot: "/repo",
    ...over,
  });

  test("delegates to the deterministic scorer without a judge", async () => {
    const good = `defineTool({
      name: "announce",
      sideEffect: true,
      execute: (args, ctx) => slack.chat.postMessage({ ...args, key: ctx.idempotencyKey }),
    })`;
    const bad = good.replace("sideEffect: true,", "");
    expect((await computeVerdict(sideEffectSpec({ requireIdempotencyKey: true }), report(good))).passed).toBe(true);
    const verdict = await computeVerdict(sideEffectSpec(), report(bad));
    expect(verdict.passed).toBe(false);
    expect(verdict.method).toBe("side-effect-marking");
    expect(verdict.checks.some((check) => check.name.startsWith("unmarked-effect:"))).toBe(true);
  });

  test("requires verify-then-undo when the case requests clean time travel", async () => {
    const blind = `defineTool({
      name: "announce",
      sideEffect: true,
      execute: (args) => slack.chat.postMessage(args),
      revert: (args, ctx) => slack.chat.delete({ channel: args.channel, ts: ctx.output.ts }),
    })`;
    const verdict = await computeVerdict(sideEffectSpec({ requireRevert: true }), report(blind));
    expect(verdict.passed).toBe(false);
    expect(verdict.checks.some((check) => check.name.startsWith("missing-revert:"))).toBe(true);

    const unknownOnly = `defineTool({
      name: "announce",
      sideEffect: true,
      execute: (args) => slack.chat.postMessage(args),
      revert: async (args, ctx) => {
        if (ctx.effectStatus === "unknown") {
          const message = await findMessageByKey(ctx.idempotencyKey);
          if (message) await slack.chat.delete({ channel: args.channel, ts: message.ts });
        }
      },
    })`;
    const polarityVerdict = await computeVerdict(sideEffectSpec({ requireRevert: true }), report(unknownOnly));
    expect(polarityVerdict.passed).toBe(false);
    expect(polarityVerdict.checks.some((check) => check.name.startsWith("missing-revert:"))).toBe(true);
  });
});

describe("build verifier resolves and structurally uses UI requirements", () => {
  function buildSpec(over: Partial<VerifySpec>): VerifySpec {
    return {
      kind: "build",
      must: [],
      mustNot: [],
      answer: null,
      rubric: null,
      sql: null,
      expect: null,
      db: null,
      required: [],
      requireIdempotencyKey: false,
      requireRevert: false,
      repoRoot: null,
      ...over,
    };
  }

  const reportUi = (artifact: string): CandidateReport => ({ artifact }) as unknown as CandidateReport;

  test("rejects marker strings, comments, unresolved imports, unused imports, and forbidden JSX", async () => {
    const cases = [
      [`const marker = "RunTree"; export default () => <div />;`, ["RunTree"], []],
      [`import { RunTree } from "smithers-orchestrator/not-real"; export default () => <RunTree />;`, ["RunTree"], []],
      [`import { RunTree } from "smithers-orchestrator/gateway-ui"; export default () => <div />;`, ["RunTree"], []],
      [
        `import { RunTree } from "smithers-orchestrator/gateway-ui"; export default () => <textarea />;`,
        ["RunTree"],
        ["<textarea"],
      ],
      [
        `import { InventedExport } from "smithers-orchestrator/gateway-ui"; export default () => <InventedExport />;`,
        ["InventedExport"],
        [],
      ],
    ] as const;
    for (const [artifact, must, mustNot] of cases) {
      expect(
        (await computeVerdict(buildSpec({ must: [...must], mustNot: [...mustNot] }), reportUi(artifact))).passed,
      ).toBe(false);
    }
    // Real esbuild + TS module resolution: the first case in this block pays a
    // cold start that overruns bun's 5s default.
  }, 60_000);

  test("accepts real named, aliased, namespace imports, calls, JSX, modules, and member access", async () => {
    const artifact = `
      import { createGatewayReactRoot as mount, useGatewayRun as useRun } from "smithers-orchestrator/gateway-react";
      import * as UI from "smithers-orchestrator/gateway-ui";
      export default function App() { useRun("run"); return <UI.RunTree runId="run" className={styles.row} />; }
      const styles = { row: "row" }; mount(<App />);
    `;
    const verdict = await computeVerdict(
      buildSpec({
        must: ["smithers-orchestrator/gateway-react", "createGatewayReactRoot", "useGatewayRun", "RunTree", ".row"],
      }),
      reportUi(artifact),
    );
    expect(verdict.passed).toBe(true);
  }, 60_000);

  test("requires module-path requirements to be imports and validates real exports", async () => {
    const artifact = `import { MarkdownEditor } from "@smithers-orchestrator/ui/adapters/markdown-editor"; export default () => <MarkdownEditor value="" />;`;
    expect((await computeVerdict(buildSpec({ must: ["adapters/markdown-editor"] }), reportUi(artifact))).passed).toBe(
      true,
    );
    expect((await computeVerdict(buildSpec({ must: ["adapters/not-real"] }), reportUi(artifact))).passed).toBe(false);
  }, 60_000);

  test("rejects type-only imports and nonexistent namespace exports", async () => {
    const typeOnly = `import type { RunTree } from "smithers-orchestrator/gateway-ui"; export default () => <RunTree />;`;
    const unresolvedTypeOnly = `import type { RunTree } from "definitely-not-a-real-module"; export default () => <div />;`;
    const nonexistentNamespace = `import * as UI from "smithers-orchestrator/gateway-ui"; export default () => <UI.NotARealComponent />;`;
    expect((await computeVerdict(buildSpec({ must: ["RunTree"] }), reportUi(typeOnly))).passed).toBe(false);
    expect((await computeVerdict(buildSpec({ must: ["RunTree"] }), reportUi(unresolvedTypeOnly))).passed).toBe(false);
    expect(
      (await computeVerdict(buildSpec({ must: ["NotARealComponent"] }), reportUi(nonexistentNamespace))).passed,
    ).toBe(false);
  }, 60_000);

  test("structurally recognizes the real location.search requirement", async () => {
    const artifact = `
      import { createGatewayReactRoot as mount, useGatewayRun } from "smithers-orchestrator/gateway-react";
      const styles = { row: "row" };
      function App() { const runId = new URLSearchParams(location.search).get("runId") ?? undefined; useGatewayRun(runId); const row = styles.row; return null; }
      mount(<App />);
    `;
    const verdict = await computeVerdict(
      buildSpec({ must: ["createGatewayReactRoot", "useGatewayRun", "location.search", ".row"] }),
      reportUi(artifact),
    );
    expect(verdict.passed).toBe(true);
  }, 60_000);
});
