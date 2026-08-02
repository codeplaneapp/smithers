import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const pkgDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(pkgDir, "..", "..");
const tsc = join(repoRoot, "node_modules", ".bin", "tsc");

const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

// Subpaths whose runtime module ships as JSDoc `.js`, so their symbols are NOT
// in the top-level `index.d.ts` barrel. The `./*` fallback would resolve their
// types to `index.d.ts` and leave them untyped for consumers, so each needs its
// own `types` mapping to a sibling declaration.
const jsSubpaths = [
  { subpath: "./constants", dts: "./src/constants.d.ts" },
  { subpath: "./utils/xml", dts: "./src/utils/xml.d.ts" },
  { subpath: "./classifyClaudeWorkflowNodeKind", dts: "./src/classifyClaudeWorkflowNodeKind.d.ts" },
];

describe("graph subpath exports have their own types mapping", () => {
  test("wildcard export maps to per-subpath declarations", () => {
    expect(pkg.exports["./*"].types).toBe("./src/*.d.ts");
    expect(pkg.exports["./*"].types).not.toBe("./src/index.d.ts");
  });

  for (const { subpath, dts } of jsSubpaths) {
    test(`${subpath} maps types to ${dts}, not the core index.d.ts`, () => {
      const entry = pkg.exports[subpath];
      expect(entry).toBeDefined();
      expect(entry.types).toBe(dts);
      expect(entry.types).not.toBe("./src/index.d.ts");
      expect(existsSync(join(pkgDir, dts))).toBe(true);
    });
  }
});

// Drive the real TypeScript resolver against the published `exports` map (no
// mocks): a fixture that imports each subpath must typecheck, and a fixture that
// misuses the types must NOT — proving the subpaths resolve to real types rather
// than `any` or the wrong `index.d.ts`.
describe("graph subpath types resolve through published exports", () => {
  const tmp = mkdtempSync(join(tmpdir(), "graph-subpath-types-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  // Resolve `@smthrs/graph/*` the way a real consumer would:
  // through the repo node_modules workspace symlink and the package `exports`.
  symlinkSync(join(repoRoot, "node_modules"), join(tmp, "node_modules"), "dir");
  writeFileSync(
    join(tmp, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowJs: true,
        checkJs: true,
        types: [],
      },
      include: ["*.ts"],
    }),
  );

  /** @param {string} name @param {string} source */
  function typecheck(name, source) {
    writeFileSync(join(tmp, name), source);
    const result = spawnSync(tsc, ["-p", "tsconfig.json"], { cwd: tmp, encoding: "utf8" });
    // Only report failures for the file under test so a stray fixture never
    // cross-contaminates the assertion.
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }

  test("well-typed subpath imports typecheck clean", () => {
    const { code, out } = typecheck(
      "good.ts",
      [
        `import { DEFAULT_MERGE_QUEUE_CONCURRENCY, WORKTREE_EMPTY_PATH_ERROR } from "@smthrs/graph/constants";`,
        `import { canonicalizeXml, parseXmlJson } from "@smthrs/graph/utils/xml";`,
        `import { stablePathId } from "@smthrs/graph/utils/tree-ids";`,
        `import { classifyClaudeWorkflowNodeKind } from "@smthrs/graph/classifyClaudeWorkflowNodeKind";`,
        `const a: number = DEFAULT_MERGE_QUEUE_CONCURRENCY;`,
        `const w: string = WORKTREE_EMPTY_PATH_ERROR;`,
        `const c: string = canonicalizeXml(null);`,
        `const p = parseXmlJson("null");`,
        `const id: string = stablePathId("task", [1, 2]);`,
        `const k = classifyClaudeWorkflowNodeKind;`,
        `export { a, w, c, p, id, k };`,
      ].join("\n"),
    );
    expect(out).toBe("");
    expect(code).toBe(0);
  });

  test("misusing the subpath types is a real type error (not any / index.d.ts)", () => {
    const { code, out } = typecheck(
      "bad.ts",
      [
        `import { DEFAULT_MERGE_QUEUE_CONCURRENCY } from "@smthrs/graph/constants";`,
        `import { canonicalizeXml } from "@smthrs/graph/utils/xml";`,
        `import { stablePathId } from "@smthrs/graph/utils/tree-ids";`,
        // number assigned to string must fail
        `const bad1: string = DEFAULT_MERGE_QUEUE_CONCURRENCY;`,
        // string return assigned to number must fail
        `const bad2: number = canonicalizeXml(null);`,
        // path entries must be numbers
        `const bad3 = stablePathId("task", ["x"]);`,
        `export { bad1, bad2, bad3 };`,
      ].join("\n"),
    );
    expect(code).not.toBe(0);
    expect(out).toContain("bad.ts");
  });
});

// The type-only `.ts` subpaths (`types`, `TaskDescriptor`, `XmlNode`,
// `GraphSnapshot`) and the deep `dom/extract` module resolve through the `./*`
// fallback. These are the subpaths consumers actually import (react-reconciler,
// driver, scheduler, smithers), so lock in that they resolve to their own real
// declarations rather than `any` or the core barrel.
describe("graph type-only subpaths resolve to real declarations", () => {
  const tmp = mkdtempSync(join(tmpdir(), "graph-type-subpath-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  symlinkSync(join(repoRoot, "node_modules"), join(tmp, "node_modules"), "dir");
  writeFileSync(
    join(tmp, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowJs: true,
        checkJs: true,
        types: [],
      },
      include: ["*.ts"],
    }),
  );

  /** @param {string} name @param {string} source */
  function typecheck(name, source) {
    writeFileSync(join(tmp, name), source);
    const result = spawnSync(tsc, ["-p", "tsconfig.json"], { cwd: tmp, encoding: "utf8" });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }

  test("well-typed uses of the type-only subpaths typecheck clean", () => {
    const { code, out } = typecheck(
      "good.ts",
      [
        `import type { TaskDescriptor } from "@smthrs/graph/TaskDescriptor";`,
        `import type { XmlNode, XmlText } from "@smthrs/graph/XmlNode";`,
        `import type { GraphSnapshot } from "@smthrs/graph/GraphSnapshot";`,
        `import type { WorkflowGraph } from "@smthrs/graph/types";`,
        `import { extractFromHost } from "@smthrs/graph/dom/extract";`,
        `const t: XmlText = { kind: "text", text: "hi" };`,
        `const n: XmlNode = t;`,
        `const snap: GraphSnapshot = { runId: "r", frameNo: 0, xml: n, tasks: [] };`,
        `const fn: typeof extractFromHost = extractFromHost;`,
        `export type { TaskDescriptor, WorkflowGraph };`,
        `export { t, n, snap, fn };`,
      ].join("\n"),
    );
    expect(out).toBe("");
    expect(code).toBe(0);
  });

  test("misusing the type-only subpaths is a real type error (not any)", () => {
    const { code, out } = typecheck(
      "bad.ts",
      [
        `import type { XmlText } from "@smthrs/graph/XmlNode";`,
        `import type { GraphSnapshot } from "@smthrs/graph/GraphSnapshot";`,
        // XmlText.text is string; a number must fail
        `const bad1: XmlText = { kind: "text", text: 123 };`,
        // GraphSnapshot.frameNo is number; a string must fail
        `const bad2: GraphSnapshot = { runId: "r", frameNo: "x", xml: null, tasks: [] };`,
        `export { bad1, bad2 };`,
      ].join("\n"),
    );
    expect(code).not.toBe(0);
    expect(out).toContain("bad.ts");
  });
});
