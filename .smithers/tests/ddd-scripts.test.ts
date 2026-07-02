import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAuditInputs } from "../lib/ddd/auditInputs.ts";
import { dddRoot } from "../lib/ddd/dddRoot.ts";
import { validateFeatures } from "../lib/ddd/validateFeatures.ts";
import { generateSpecDocs } from "../lib/ddd/generateSpecDocs.ts";
import { generateUiModules } from "../lib/ddd/generateUiModules.ts";
import { triageCandidates } from "../lib/ddd/triageCandidates.ts";

const here = dirname(fileURLToPath(import.meta.url));
const realBuildScript = resolve(here, "../lib/ddd/build.ts");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "ddd-scripts-"));
  tempDirs.push(root);
  mkdirSync(join(root, ".smithers/spec/content"), { recursive: true });
  writeFileSync(join(root, ".smithers/spec/content/overview.md"), "# Overview\n\nReal docs.\n");
  return root;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function feature(overrides: Record<string, unknown> = {}) {
  return {
    id: "alpha-feature",
    title: "Alpha feature",
    summary: "Alpha summary",
    status: "partial",
    priority: "p1",
    owner: "product",
    ...overrides,
  };
}

function writeFeatures(root: string, features: unknown) {
  writeJson(join(root, ".smithers/spec/features.json"), features);
}

describe("DDD scripts and build gate", () => {
  test("validateFeatures rejects invalid shapes, extra keys, bad enums/ids, duplicates, and unreadable JSON", () => {
    const root = tempRoot();

    writeFeatures(root, { id: "not-an-array" });
    expect(() => validateFeatures(root)).toThrow("features.json does not match the schema");

    writeFeatures(root, [feature({ surprise: true })]);
    expect(() => validateFeatures(root)).toThrow("Unrecognized key");

    writeFeatures(root, [feature({ id: "Not Kebab", status: "unknown" })]);
    expect(() => validateFeatures(root)).toThrow(/id must be kebab-case|Invalid option/);

    writeFeatures(root, [feature({ id: "dup" }), feature({ id: "dup", title: "Duplicate" })]);
    expect(() => validateFeatures(root)).toThrow("duplicate feature ids: dup");

    writeFileSync(join(root, ".smithers/spec/features.json"), "{");
    expect(() => validateFeatures(root)).toThrow("could not read/parse");
  });

  test("validateFeatures defaults optional arrays and tier without weakening strict records", () => {
    const root = tempRoot();
    writeFeatures(root, [feature({ id: "defaulted" })]);

    const [parsed] = validateFeatures(root);

    expect(parsed?.tier).toBe("feature");
    expect(parsed?.capabilities).toEqual([]);
    expect(parsed?.endpoints).toEqual([]);
    expect(parsed?.links).toEqual([]);
    expect(parsed?.tests).toEqual([]);
    expect(parsed?.missing).toEqual([]);
  });

  test("dddRoot discovers the root from nested cwd and fails clearly outside a DDD repo", () => {
    const root = tempRoot();
    writeFeatures(root, [feature()]);
    const nested = join(root, "a/b/c");
    mkdirSync(nested, { recursive: true });

    expect(dddRoot(nested)).toBe(root);
    expect(() => dddRoot(join(tmpdir(), "definitely-not-ddd"))).toThrow(".smithers/spec/features.json");
  });

  test("generateSpecDocs deletes stale derived docs and renders empty plus populated markdown sections", () => {
    const root = tempRoot();
    writeFeatures(root, [
      feature({ id: "empty-feature", title: "Empty feature", status: "fixed", priority: "p0" }),
      feature({
        id: "rich-feature",
        title: "Rich feature",
        status: "missing-tests",
        priority: "p2",
        group: "Run & observe",
        tier: "platform",
        userValue: "Run a real workflow.",
        capabilities: [{ title: "Launch", detail: "Launches runs.", status: "partial" }],
        endpoints: [{ method: "GET", path: "/runs", doc: "reference/api.md#runs", note: "list runs" }],
        links: [{ label: "Overview", href: "overview.md" }],
        tests: ["bun test tests/ddd-scripts.test.ts"],
        observability: ["run events"],
        debug: ["smithers inspect"],
        architecture: ["gateway"],
        changes: ["changed feature matrix"],
        diffHints: ["packages/server/src/index.ts"],
        missing: ["Add browser e2e proof"],
      }),
    ]);
    const stale = join(root, ".smithers/spec/content/features/stale.md");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "# stale\n");

    expect(generateSpecDocs(root)).toBe(2);

    expect(existsSync(stale)).toBe(false);
    const empty = readFileSync(join(root, ".smithers/spec/content/features/empty-feature.md"), "utf8");
    expect(empty).toContain("# Empty feature");
    expect(empty).toContain("## Test cases\n\n_None recorded yet._");

    const rich = readFileSync(join(root, ".smithers/spec/content/features/rich-feature.md"), "utf8");
    expect(rich).toContain("**Tier:** Platform");
    expect(rich).toContain("**What you can do:** Run a real workflow.");
    expect(rich).toContain("### Launch _(Partial)_");
    expect(rich).toContain("- `GET /runs` (list runs) ([docs](reference/api.md#runs))");
    expect(rich).toContain("- [Overview](overview.md)");
    expect(rich).toContain("- Add browser e2e proof");
  });

  test("generateUiModules bundles docs, workflow source, and inferred backlog tickets with truncated slugs", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".smithers/spec/content/reference"), { recursive: true });
    mkdirSync(join(root, ".smithers/workflows"), { recursive: true });
    writeFileSync(join(root, ".smithers/spec/content/reference/api.md"), "# API catalog\n");
    writeFileSync(join(root, ".smithers/workflows/docs-driven-development.tsx"), "export default null;\n");
    writeFeatures(root, [
      feature({
        id: "broken-p0",
        title: "Broken P0",
        status: "broken",
        priority: "p0",
        missing: ["Fix crash in packages/server/src/index.ts"],
      }),
      feature({
        id: "review-gap",
        title: "Review gap",
        status: "partial",
        priority: "p1",
        missing: ["Security review needed before release"],
      }),
      feature({
        id: "long-gap",
        title: "Long gap",
        status: "missing",
        priority: "p2",
        missing: ["Add support " + "very ".repeat(30) + "carefully"],
      }),
      feature({ id: "done", title: "Done", status: "fixed", priority: "p2", missing: ["ignored"] }),
    ]);
    generateSpecDocs(root);

    expect(generateUiModules(root)).toEqual({ docs: 6, tickets: 3 });

    const docsModule = readFileSync(join(root, ".smithers/ui/ddd-docsContent.generated.ts"), "utf8");
    expect(docsModule).toContain('"path": "overview.md"');
    expect(docsModule).toContain('"title": "API catalog"');

    const ticketsModule = readFileSync(join(root, ".smithers/ui/ddd-ticketsBacklog.generated.ts"), "utf8");
    expect(ticketsModule).toContain('"kind": "fix"');
    expect(ticketsModule).toContain('"kind": "review"');
    expect(ticketsModule).toContain('"kind": "feature"');
    expect(ticketsModule).toContain("tickets/long-gap--01-add-support-very-very-very-very-very-very-very-very-very-ver.md");
    expect(ticketsModule).not.toContain("ignored");

    const workflowModule = readFileSync(join(root, ".smithers/ui/ddd-workflowSource.generated.ts"), "utf8");
    expect(workflowModule).toContain("export default null");
  });

  test("collectAuditInputs is sorted, deduped, and omits files over the 256KB cap", () => {
    const root = tempRoot();
    writeFeatures(root, [feature()]);
    mkdirSync(join(root, ".smithers/spec/content/features"), { recursive: true });
    mkdirSync(join(root, ".smithers/lib/ddd"), { recursive: true });
    mkdirSync(join(root, ".smithers/docs-driven-development/artifacts"), { recursive: true });
    mkdirSync(join(root, ".smithers/specs"), { recursive: true });
    mkdirSync(join(root, ".smithers/workflows"), { recursive: true });
    writeFileSync(join(root, ".smithers/specs/docs-driven-development.md"), "# DDD\n");
    writeFileSync(join(root, ".smithers/workflows/docs-driven-development.tsx"), "workflow\n");
    writeFileSync(join(root, ".smithers/spec/content/features/a.md"), "# A\n");
    writeFileSync(join(root, ".smithers/spec/content/features/z.md"), "# Z\n");
    writeFileSync(join(root, ".smithers/lib/ddd/small.ts"), "ok\n");
    writeFileSync(join(root, ".smithers/lib/ddd/large.ts"), "x".repeat(256_001));

    const inputs = collectAuditInputs(root);

    expect(inputs).toEqual([...new Set(inputs)]);
    expect(inputs).toContain(".smithers/spec/features.json");
    expect(inputs).toContain(".smithers/spec/content/features/a.md");
    expect(inputs).toContain(".smithers/spec/content/features/z.md");
    expect(inputs.indexOf(".smithers/spec/content/features/a.md")).toBeLessThan(inputs.indexOf(".smithers/spec/content/features/z.md"));
    expect(inputs).toContain(".smithers/lib/ddd/small.ts");
    expect(inputs).not.toContain(".smithers/lib/ddd/large.ts");
  });

  test("triageCandidates ranks by status, priority, tie-breaker, file hints, acceptance, and max", () => {
    const candidates = triageCandidates([
      feature({ id: "partial-a", title: "Partial A", status: "partial", priority: "p0", diffHints: ["touch packages/a/src/a.ts, docs/a.md"] }) as any,
      feature({ id: "broken-b", title: "Broken B", status: "broken", priority: "p0", missing: ["Fix B"] }) as any,
      feature({ id: "alpha", title: "Alpha", status: "missing-tests", priority: "p1" }) as any,
      feature({ id: "beta", title: "Beta", status: "missing-tests", priority: "p1" }) as any,
      feature({ id: "fixed", title: "Fixed", status: "fixed", priority: "p0" }) as any,
    ], 4);

    expect(candidates.map((item) => item.featureId)).toEqual(["broken-b", "partial-a", "alpha", "beta"]);
    expect(candidates[0]?.taskType).toBe("fix");
    expect(candidates[1]?.taskType).toBe("e2e");
    expect(candidates[1]?.files).toEqual(["packages/a/src/a.ts", "docs/a.md"]);
    expect(candidates[2]?.acceptance).toEqual(["Move alpha from missing-tests only after direct proof is attached."]);
  });

  test("build.ts propagates failures and writes generated artifacts on success from a temp filesystem", () => {
    const root = tempRoot();
    writeFeatures(root, [feature({ status: "not-real" })]);

    const failureText = execFileSync(
      "sh",
      ["-c", "set +e; bun \"$1\" 2>&1; code=$?; printf '\\n__status:%s\\n' \"$code\"; exit 0", "sh", realBuildScript],
      { cwd: root, encoding: "utf8" },
    );
    expect(failureText).toContain("ddd build failed");
    expect(failureText).toContain("__status:1");

    writeFeatures(root, [feature({ id: "built", status: "fixed" })]);
    const output = execFileSync("bun", [realBuildScript], { cwd: root, encoding: "utf8" });

    expect(output).toContain("ddd build: validated 1 features");
    expect(existsSync(join(root, ".smithers/spec/content/features/built.md"))).toBe(true);
    expect(existsSync(join(root, ".smithers/ui/ddd-docsContent.generated.ts"))).toBe(true);
    expect(existsSync(join(root, ".smithers/ui/ddd-ticketsBacklog.generated.ts"))).toBe(true);
  });
});
