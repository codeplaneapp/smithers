import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAuditInputs } from "../lib/ddd/auditInputs.ts";
import { dddRoot, dddRootOrCwd } from "../lib/ddd/dddRoot.ts";
import { validateFeatures } from "../lib/ddd/validateFeatures.ts";
import { generateSpecDocs } from "../lib/ddd/generateSpecDocs.ts";
import { docLevelOf, generateUiModules } from "../lib/ddd/generateUiModules.ts";
import { parseMax, triageCandidates } from "../lib/ddd/triageCandidates.ts";

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

function markdownPaths(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownPaths(root, full));
    else if (entry.endsWith(".md")) out.push(relative(root, full).replaceAll("\\", "/"));
  }
  return out;
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

  test("missing features.json is a starter spec only when explicitly allowed", () => {
    const root = tempRoot();
    const nested = join(root, ".smithers/lib/ddd");
    mkdirSync(nested, { recursive: true });

    expect(dddRoot(nested)).toBe(root);
    expect(() => validateFeatures(root)).toThrow("could not read/parse");
    expect(validateFeatures(root, { allowMissing: true })).toEqual([]);

    expect(generateSpecDocs(root)).toBe(0);
    expect(generateUiModules(root)).toEqual({ docs: 1, tickets: 0 });
    const featuresModule = readFileSync(join(root, ".smithers/ui/ddd-features.generated.ts"), "utf8");
    expect(featuresModule).toContain("export const featuresData = [];");
  });

  test("validateFeatures rejects nested strict schema errors and empty required nested strings", () => {
    const root = tempRoot();

    writeFeatures(root, [
      feature({
        capabilities: [{ title: "Launch", detail: "Runs workflows.", extra: true }],
      }),
    ]);
    expect(() => validateFeatures(root)).toThrow("Unrecognized key");

    writeFeatures(root, [
      feature({
        links: [{ label: "", href: "overview.md" }],
      }),
    ]);
    expect(() => validateFeatures(root)).toThrow("Too small");

    writeFeatures(root, [
      feature({
        endpoints: [{ method: "GET", path: "" }],
      }),
    ]);
    expect(() => validateFeatures(root)).toThrow("Too small");
  });

  test("dddRoot discovers the root from nested cwd and fails clearly outside a DDD repo", () => {
    const root = tempRoot();
    writeFeatures(root, [feature()]);
    const nested = join(root, "a/b/c");
    mkdirSync(nested, { recursive: true });

    expect(dddRoot(nested)).toBe(root);
    expect(() => dddRoot(join(tmpdir(), "definitely-not-ddd"))).toThrow(".smithers/spec/features.json");
  });

  test("dddRoot resolves when starting inside a .smithers pack before features exist", () => {
    const root = mkdtempSync(join(tmpdir(), "ddd-pack-root-"));
    tempDirs.push(root);
    const pack = join(root, ".smithers");
    mkdirSync(join(pack, "lib/ddd"), { recursive: true });
    writeFileSync(join(pack, "lib/ddd/build.ts"), "export {};\n");

    expect(dddRoot(pack)).toBe(root);
    expect(dddRoot(join(pack, "lib/ddd"))).toBe(root);
    expect(dddRootOrCwd(pack)).toBe(root);
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
    expect(empty).not.toContain("## Test cases");

    const rich = readFileSync(join(root, ".smithers/spec/content/features/rich-feature.md"), "utf8");
    expect(rich).toContain("**Tier:** Platform");
    expect(rich).toContain("## What you can do\n\nRun a real workflow.");
    expect(rich).toContain("### Launch (Partial)");
    expect(rich).toContain("- `GET /runs` - list runs ([docs](reference/api.md#runs))");
    expect(rich).toContain("- [Overview](overview.md)");
    expect(rich).toContain("- Add browser e2e proof");
  });

  test("generateSpecDocs escapes markdown and formats commands, paths, and tricky link destinations", () => {
    const root = tempRoot();
    writeFeatures(root, [
      feature({
        id: "escaping",
        title: "# [Escaped]_`Title`",
        owner: "docs_[owner]",
        summary: "Run smithers workflow run ddd-generate-docs, pnpm -C e2e test, pnpm -C .smithers test, and open .smithers/spec/features.json. Then use smithers agent add|list|remove, keep packages/server, packages/gateway-client aligned, and run pnpm docs:llms after editing docs.",
        userValue: "Use `literal` and [brackets]_safely.",
        capabilities: [{ title: "# Cap_[A]", detail: "Fix packages/server/src/index.ts.", status: "partial" }],
        endpoints: [{ method: "GET", path: "/runs", doc: "reference/api docs).md#runs", note: "call /v1/api/runs" }],
        links: [{ label: "Read [API]", href: "reference/api docs).md#runs" }],
        missing: ["Heading # stays text with [link]_markers"],
      }),
    ]);

    generateSpecDocs(root);

    const doc = readFileSync(join(root, ".smithers/spec/content/features/escaping.md"), "utf8");
    expect(doc).toContain("# \\[Escaped\\]\\_\\`Title\\`");
    expect(doc).toContain("**Owner:** docs\\_\\[owner\\]");
    expect(doc).toContain("`smithers workflow run ddd-generate-docs`");
    expect(doc).toContain("`pnpm -C e2e test`");
    expect(doc).toContain("`pnpm -C .smithers test`");
    expect(doc).toContain("`.smithers/spec/features.json`");
    expect(doc).toContain("`smithers agent add` | `smithers agent list` | `smithers agent remove`");
    expect(doc).toContain("keep `packages/server`, `packages/gateway-client` aligned");
    expect(doc).toContain("run `pnpm docs:llms` after editing docs");
    expect(doc).toContain("Use \\`literal\\` and \\[brackets\\]\\_safely.");
    expect(doc).toContain("### Cap\\_\\[A\\] (Partial)");
    expect(doc).toContain("- `GET /runs` - call /v1/api/runs ([docs](reference/api%20docs%29.md#runs))");
    expect(doc).toContain("- [Read \\[API\\]](reference/api%20docs%29.md#runs)");
    expect(doc).toContain("- Heading # stays text with \\[link\\]\\_markers");
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
      feature({
        id: "fixed-with-gap",
        title: "Fixed With Gap",
        status: "fixed",
        priority: "p1",
        missing: ["Bug (major): Regression still reproduces"],
      }),
      feature({ id: "done", title: "Done", status: "fixed", priority: "p2", missing: [] }),
    ]);
    generateSpecDocs(root);

    expect(generateUiModules(root)).toEqual({ docs: 7, tickets: 4 });

    const docsModule = readFileSync(join(root, ".smithers/ui/ddd-docsContent.generated.ts"), "utf8");
    expect(docsModule).toContain('"path": "overview.md"');
    expect(docsModule).toContain('"title": "API catalog"');

    const ticketsModule = readFileSync(join(root, ".smithers/ui/ddd-ticketsBacklog.generated.ts"), "utf8");
    expect(ticketsModule).toContain('"kind": "fix"');
    expect(ticketsModule).toContain('"kind": "review"');
    expect(ticketsModule).toContain('"kind": "feature"');
    expect(ticketsModule).toContain('"priority": "p0"');
    expect(ticketsModule).toContain('"featureId": "broken-p0"');
    expect(ticketsModule).toContain('"featureId": "fixed-with-gap"');
    expect(ticketsModule).toContain('"featureTitle": "Broken P0"');
    expect(ticketsModule).toContain("Bug (major): Regression still reproduces");
    expect(ticketsModule).toContain("tickets/long-gap--01-add-support-very-very-very-very-very-very-very-very-very-ver.md");
    expect(ticketsModule).not.toContain("ignored");

    const workflowModule = readFileSync(join(root, ".smithers/ui/ddd-workflowSource.generated.ts"), "utf8");
    expect(workflowModule).toContain("export default null");
  });

  test("generateUiModules classifies nested docs, defaults open missing lists, and tolerates missing workflow source", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".smithers/spec/content/product/deep"), { recursive: true });
    mkdirSync(join(root, ".smithers/spec/content/reference/deep"), { recursive: true });
    writeFileSync(join(root, ".smithers/spec/content/product/deep/guide.md"), "# Product Guide\n");
    writeFileSync(join(root, ".smithers/spec/content/reference/deep/api.md"), "# API Guide\n");
    writeFeatures(root, [
      feature({ id: "open-no-gaps", title: "Open No Gaps", status: "partial", missing: [] }),
      feature({ id: "done-no-gaps", title: "Done No Gaps", status: "fixed", missing: [] }),
    ]);

    expect(docLevelOf("overview.md")).toBe("product");
    expect(docLevelOf("product/deep/guide.md")).toBe("product");
    expect(docLevelOf("features/open-no-gaps.md")).toBe("technical");
    expect(docLevelOf("reference/deep/api.md")).toBe("technical");

    generateSpecDocs(root);
    expect(generateUiModules(root)).toEqual({ docs: 5, tickets: 1 });

    const docsModule = readFileSync(join(root, ".smithers/ui/ddd-docsContent.generated.ts"), "utf8");
    expect(docsModule).toContain('"path": "product/deep/guide.md"');
    expect(docsModule).toContain('"level": "product"');
    expect(docsModule).toContain('"path": "reference/deep/api.md"');
    expect(docsModule).toContain('"level": "technical"');

    const ticketsModule = readFileSync(join(root, ".smithers/ui/ddd-ticketsBacklog.generated.ts"), "utf8");
    expect(ticketsModule).toContain("Close the partial status of Open No Gaps with direct proof.");
    expect(ticketsModule).not.toContain("Done No Gaps");

    const workflowModule = readFileSync(join(root, ".smithers/ui/ddd-workflowSource.generated.ts"), "utf8");
    expect(workflowModule).toContain('export const workflowSource = "";');
  });

  test("generateUiModules covers ticket kind inference, h1 fallback titles, fixed-with-gap tickets, and relative workflow source paths", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".smithers/spec/content/product"), { recursive: true });
    mkdirSync(join(root, ".smithers/workflows"), { recursive: true });
    writeFileSync(join(root, ".smithers/spec/content/product/no-heading.md"), "No heading body.\n");
    writeFileSync(join(root, ".smithers/workflows/docs-driven-development.tsx"), "export const workflow = true;\n");
    writeFeatures(root, [
      feature({ id: "test-gap", title: "Test Gap", status: "partial", missing: ["Add Playwright coverage proof"] }),
      feature({ id: "broken-status", title: "Broken Status", status: "broken", missing: ["Triage the failing path"] }),
      feature({ id: "bug-keyword", title: "Bug Keyword", status: "partial", missing: ["Bug causes output loss"] }),
      feature({ id: "review-keyword", title: "Review Keyword", status: "partial", missing: ["Security audit before release"] }),
      feature({ id: "missing-status", title: "Missing Status", status: "missing", missing: [] }),
      feature({ id: "implement-keyword", title: "Implement Keyword", status: "partial", missing: ["Implement retry controls"] }),
      feature({ id: "issue-default", title: "Issue Default", status: "partial", missing: ["Clarify operator behavior"] }),
      feature({ id: "fixed-gap", title: "Fixed Gap", status: "fixed", missing: ["Regression gap remains"] }),
    ]);
    generateSpecDocs(root);

    expect(generateUiModules(root)).toEqual({ docs: 10, tickets: 8 });

    const docsModule = readFileSync(join(root, ".smithers/ui/ddd-docsContent.generated.ts"), "utf8");
    expect(docsModule).toContain('"path": "product/no-heading.md"');
    expect(docsModule).toContain('"title": "no-heading"');

    const ticketsModule = readFileSync(join(root, ".smithers/ui/ddd-ticketsBacklog.generated.ts"), "utf8");
    expect(ticketsModule).toContain('"featureId": "test-gap"');
    expect(ticketsModule).toContain('"kind": "e2e"');
    expect(ticketsModule).toContain('"featureId": "broken-status"');
    expect(ticketsModule).toContain('"featureId": "bug-keyword"');
    expect(ticketsModule.match(/"kind": "fix"/g)?.length).toBe(2);
    expect(ticketsModule).toContain('"featureId": "review-keyword"');
    expect(ticketsModule).toContain('"kind": "review"');
    expect(ticketsModule).toContain("Close the missing status of Missing Status with direct proof.");
    expect(ticketsModule).toContain('"featureId": "implement-keyword"');
    expect(ticketsModule).toContain('"kind": "feature"');
    expect(ticketsModule).toContain('"featureId": "issue-default"');
    expect(ticketsModule).toContain('"kind": "issue"');
    expect(ticketsModule).toContain('"featureId": "fixed-gap"');
    expect(ticketsModule).toContain("Regression gap remains");

    const workflowModule = readFileSync(join(root, ".smithers/ui/ddd-workflowSource.generated.ts"), "utf8");
    expect(workflowModule).toContain('export const workflowSourcePath = ".smithers/workflows/docs-driven-development.tsx";');
    expect(workflowModule).toContain("export const workflow = true");
  });

  test("generateUiModules emits all present DDD workflow sources and omits missing secondary workflows", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".smithers/workflows"), { recursive: true });
    writeFileSync(join(root, ".smithers/workflows/docs-driven-development.tsx"), "export const primary = 'docs-driven-development';\n");
    writeFileSync(join(root, ".smithers/workflows/ddd-generate-docs.tsx"), "export const generated = 'ddd-generate-docs';\n");
    writeFileSync(join(root, ".smithers/workflows/ddd-bug-scan.tsx"), "export const scanned = 'ddd-bug-scan';\n");
    writeFeatures(root, [feature({ id: "workflow-source", title: "Workflow Source", status: "fixed", missing: [] })]);
    generateSpecDocs(root);

    expect(generateUiModules(root)).toEqual({ docs: 2, tickets: 0 });
    let workflowModule = readFileSync(join(root, ".smithers/ui/ddd-workflowSource.generated.ts"), "utf8");
    expect(workflowModule).toContain('"docs-driven-development"');
    expect(workflowModule).toContain('"ddd-generate-docs"');
    expect(workflowModule).toContain('"ddd-bug-scan"');
    expect(workflowModule).toContain('"path": ".smithers/workflows/docs-driven-development.tsx"');
    expect(workflowModule).toContain('"path": ".smithers/workflows/ddd-generate-docs.tsx"');
    expect(workflowModule).toContain('"path": ".smithers/workflows/ddd-bug-scan.tsx"');
    expect(workflowModule).toContain("export const primary = 'docs-driven-development';");
    expect(workflowModule).toContain("export const generated = 'ddd-generate-docs';");
    expect(workflowModule).toContain("export const scanned = 'ddd-bug-scan';");
    expect(workflowModule).toContain('export const workflowSourcePath = ".smithers/workflows/docs-driven-development.tsx";');
    expect(workflowModule).toContain("export const workflowSource = \"export const primary");

    rmSync(join(root, ".smithers/workflows/ddd-bug-scan.tsx"));
    generateUiModules(root);
    workflowModule = readFileSync(join(root, ".smithers/ui/ddd-workflowSource.generated.ts"), "utf8");
    expect(workflowModule).toContain('"docs-driven-development"');
    expect(workflowModule).toContain('"ddd-generate-docs"');
    expect(workflowModule).not.toContain('"ddd-bug-scan"');
    expect(workflowModule).not.toContain('"source": ""');
    expect(workflowModule).toContain('export const workflowSourcePath = ".smithers/workflows/docs-driven-development.tsx";');
  });

  test("collectAuditInputs is sorted, deduped, and omits files over the 256KB cap", () => {
    const root = tempRoot();
    writeFeatures(root, [feature()]);
    mkdirSync(join(root, ".smithers/spec/content/features"), { recursive: true });
    mkdirSync(join(root, ".smithers/lib/ddd"), { recursive: true });
    mkdirSync(join(root, ".smithers/docs-driven-development/artifacts"), { recursive: true });
    mkdirSync(join(root, ".smithers/specs"), { recursive: true });
    mkdirSync(join(root, ".smithers/workflows"), { recursive: true });
    mkdirSync(join(root, ".smithers/ui"), { recursive: true });
    writeFileSync(join(root, ".smithers/specs/docs-driven-development.md"), "# DDD\n");
    writeFileSync(join(root, ".smithers/specs/ddd-app-v2.md"), "# DDD app v2\n");
    writeFileSync(join(root, ".smithers/workflows/docs-driven-development.tsx"), "workflow\n");
    writeFileSync(join(root, ".smithers/workflows/ddd-generate-docs.tsx"), "generate\n");
    writeFileSync(join(root, ".smithers/workflows/ddd-bug-scan.tsx"), "scan\n");
    writeFileSync(join(root, ".smithers/ui/docs-driven-development.tsx"), "ui shell\n");
    writeFileSync(join(root, ".smithers/ui/ddd-shared.tsx"), "shared\n");
    writeFileSync(join(root, ".smithers/ui/ddd-StartPane.tsx"), "start\n");
    writeFileSync(join(root, ".smithers/spec/content/features/a.md"), "# A\n");
    writeFileSync(join(root, ".smithers/spec/content/features/z.md"), "# Z\n");
    writeFileSync(join(root, ".smithers/lib/ddd/small.ts"), "ok\n");
    writeFileSync(join(root, ".smithers/lib/ddd/large.ts"), "x".repeat(256_001));

    const inputs = collectAuditInputs(root);

    expect(inputs).toEqual([...new Set(inputs)]);
    expect(inputs).toContain(".smithers/spec/features.json");
    expect(inputs).toContain(".smithers/specs/ddd-app-v2.md");
    expect(inputs).not.toContain(".smithers/specs/docs-driven-development.md");
    expect(inputs).toContain(".smithers/workflows/ddd-generate-docs.tsx");
    expect(inputs).toContain(".smithers/workflows/ddd-bug-scan.tsx");
    expect(inputs).toContain(".smithers/ui/docs-driven-development.tsx");
    expect(inputs).toContain(".smithers/ui/ddd-shared.tsx");
    expect(inputs).toContain(".smithers/ui/ddd-StartPane.tsx");
    expect(inputs).toContain(".smithers/spec/content/features/a.md");
    expect(inputs).toContain(".smithers/spec/content/features/z.md");
    expect(inputs.indexOf(".smithers/spec/content/features/a.md")).toBeLessThan(inputs.indexOf(".smithers/spec/content/features/z.md"));
    expect(inputs).toContain(".smithers/lib/ddd/small.ts");
    expect(inputs).not.toContain(".smithers/lib/ddd/large.ts");
  });

  test("collectAuditInputs includes reference and artifact files, skips missing or non-dir listed dirs, omits subdirs, and honors the 256000 byte boundary", () => {
    const root = tempRoot();
    writeFeatures(root, [feature()]);
    mkdirSync(join(root, ".smithers/spec/content/reference/nested"), { recursive: true });
    mkdirSync(join(root, ".smithers/spec/content/features/nested"), { recursive: true });
    mkdirSync(join(root, ".smithers/docs-driven-development/artifacts/nested"), { recursive: true });
    rmSync(join(root, ".smithers/lib"), { recursive: true, force: true });
    writeFileSync(join(root, ".smithers/lib"), "not a directory\n");
    writeFileSync(join(root, ".smithers/spec/content/reference/api.md"), "# API\n");
    writeFileSync(join(root, ".smithers/spec/content/reference/nested/omitted.md"), "# Nested\n");
    writeFileSync(join(root, ".smithers/spec/content/features/direct.md"), "# Direct\n");
    writeFileSync(join(root, ".smithers/spec/content/features/nested/omitted.md"), "# Nested\n");
    writeFileSync(join(root, ".smithers/docs-driven-development/artifacts/exact.txt"), "x".repeat(256_000));
    writeFileSync(join(root, ".smithers/docs-driven-development/artifacts/too-large.txt"), "x".repeat(256_001));
    writeFileSync(join(root, ".smithers/docs-driven-development/artifacts/nested/omitted.txt"), "ok\n");

    const inputs = collectAuditInputs(root);

    expect(inputs).toContain(".smithers/spec/content/reference/api.md");
    expect(inputs).toContain(".smithers/spec/content/features/direct.md");
    expect(inputs).toContain(".smithers/docs-driven-development/artifacts/exact.txt");
    expect(inputs).not.toContain(".smithers/docs-driven-development/artifacts/too-large.txt");
    expect(inputs).not.toContain(".smithers/spec/content/reference/nested/omitted.md");
    expect(inputs).not.toContain(".smithers/spec/content/features/nested/omitted.md");
    expect(inputs).not.toContain(".smithers/docs-driven-development/artifacts/nested/omitted.txt");
    expect(inputs.some((input) => input.startsWith(".smithers/lib/ddd/"))).toBe(false);
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

  test("triageCandidates cleans path punctuation and parseMax falls back on invalid values", () => {
    const candidates = triageCandidates([
      feature({
        id: "punctuation",
        title: "Punctuation",
        status: "broken",
        priority: "p0",
        diffHints: ['See "packages/a/src/a.ts", (.smithers/ui/x.tsx); docs/a.md. not/a/path'],
      }) as any,
    ], 1);

    expect(candidates[0]?.files).toEqual(["packages/a/src/a.ts", ".smithers/ui/x.tsx", "docs/a.md"]);
    expect(parseMax([])).toBe(8);
    expect(parseMax(["--", "--max", "3"])).toBe(3);
    expect(parseMax(["--max", "0"])).toBe(8);
    expect(parseMax(["--max", "not-a-number"])).toBe(8);
  });

  test("dddRootOrCwd falls back to the resolved start directory outside a DDD repo", () => {
    const outside = mkdtempSync(join(tmpdir(), "ddd-root-fallback-"));
    tempDirs.push(outside);
    const nested = join(outside, "nested");
    mkdirSync(nested, { recursive: true });

    expect(dddRootOrCwd(nested)).toBe(resolve(nested));
  });

  test("checked-in DDD spec data and generated UI modules stay semantically synchronized", async () => {
    const root = resolve(here, "../..");
    const features = validateFeatures(root);
    const featureIds = features.map((feature) => feature.id);
    const featureDocDir = join(root, ".smithers/spec/content/features");
    const featureDocPaths = markdownPaths(root, featureDocDir)
      .map((path) => path.replace(/^\.smithers\/spec\/content\/features\//, ""));

    expect(featureDocPaths.sort()).toEqual(featureIds.map((id) => `${id}.md`).sort());
    expect(new Set(featureDocPaths).size).toBe(featureDocPaths.length);

    const generatedFeatures = await import(`../ui/ddd-features.generated.ts?semantic=${Date.now()}`);
    const generatedDocs = await import(`../ui/ddd-docsContent.generated.ts?semantic=${Date.now()}`);
    const generatedTickets = await import(`../ui/ddd-ticketsBacklog.generated.ts?semantic=${Date.now()}`);

    expect(generatedFeatures.featuresData).toEqual(features);

    const contentRoot = join(root, ".smithers/spec/content");
    const contentPaths = markdownPaths(root, contentRoot)
      .map((path) => path.replace(/^\.smithers\/spec\/content\//, ""))
      .sort();
    const contentPathSet = new Set(contentPaths);
    const docsContent = generatedDocs.docsContent as Array<{ path: string; level: "product" | "technical"; content: string }>;
    expect(docsContent.map((doc) => doc.path).sort()).toEqual(contentPaths);
    for (const doc of docsContent) {
      expect(doc.content).toBe(readFileSync(join(contentRoot, doc.path), "utf8"));
      expect(doc.level).toBe(docLevelOf(doc.path));
    }

    const allowedStatuses = new Set(["fixed", "partial", "broken", "missing-tests", "missing"]);
    const allowedPriorities = new Set(["p0", "p1", "p2"]);
    const allowedTiers = new Set(["feature", "platform", "reference"]);
    for (const feature of features) {
      expect(allowedStatuses.has(feature.status)).toBe(true);
      expect(allowedPriorities.has(feature.priority)).toBe(true);
      expect(allowedTiers.has(feature.tier)).toBe(true);
      expect((feature.group ?? "").trim().length).toBeGreaterThan(0);
      expect((feature.userValue ?? "").trim().length).toBeGreaterThan(0);
      if (feature.status === "fixed") {
        expect(feature.tests.some((testCommand) => /\b(test|e2e)\b|check-docs|check-llms/i.test(testCommand))).toBe(true);
        expect(feature.missing).toEqual([]);
      } else {
        expect(feature.missing.length).toBeGreaterThan(0);
      }
      for (const link of feature.links ?? []) {
        const href = link.href.split("#")[0] ?? "";
        expect(href === "" || /^https?:\/\//.test(href) || contentPathSet.has(href)).toBe(true);
      }
      for (const endpoint of feature.endpoints ?? []) {
        const href = (endpoint.doc ?? "").split("#")[0] ?? "";
        expect(href === "" || /^https?:\/\//.test(href) || contentPathSet.has(href)).toBe(true);
      }
      for (const command of feature.tests ?? []) {
        const knownGate = /\b(pnpm\s+(typecheck|test|docs:llms)|pnpm\s+-C\s+\S+\s+test|check-docs|check-llms|check-dependency-boundaries|check-single-effect-version)\b/.test(command);
        const explicitTestPaths = [...command.matchAll(/(?:^|\s)(\.smithers\/tests\/[^\s]+|tests\/[^\s]+|\.smithers\/ui\/[^\s]+|ui\/[^\s]+|\.smithers\/lib\/ddd\/[^\s]+|lib\/ddd\/[^\s]+|e2e\/[^\s]+)/g)]
          .map((match) => (match[1] ?? "").replace(/[),.;]+$/, ""));
        if (explicitTestPaths.length === 0) {
          expect(knownGate).toBe(true);
        }
        for (const testPath of explicitTestPaths) {
          const normalized = testPath.startsWith(".smithers/")
            ? testPath
            : testPath.startsWith("tests/") || testPath.startsWith("ui/") || testPath.startsWith("lib/ddd/")
              ? `.smithers/${testPath}`
              : testPath;
          expect(existsSync(join(root, normalized))).toBe(true);
        }
      }
    }

    const expectedOpenGaps = features
      .filter((feature) => feature.status !== "fixed" || feature.missing.length > 0)
      .flatMap((feature) => feature.missing.map((gap) => `${feature.id}\0${gap}`))
      .sort();
    const ticketsBacklog = generatedTickets.ticketsBacklog as Array<{ featureId: string; content: string }>;
    const actualOpenGaps = ticketsBacklog
      .map((ticket) => {
        const title = ticket.content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
        return `${ticket.featureId}\0${title}`;
      })
      .sort();
    expect(actualOpenGaps).toEqual(expectedOpenGaps);
  });

  test("docs-driven-development feature evidence lists the DDD test suite in data and generated docs", () => {
    const root = resolve(here, "../..");
    const expectedTestPaths = [
      ".smithers/tests/ddd-bug-scan-run.e2e.test.ts",
      ".smithers/tests/ddd-generate-bug-scan.test.ts",
      ".smithers/tests/ddd-generate-docs-run.e2e.test.ts",
      ".smithers/tests/ddd-scripts.test.ts",
      ".smithers/tests/ddd-ui-parsers.test.ts",
      ".smithers/tests/docs-driven-development-run.e2e.test.ts",
      ".smithers/tests/docs-driven-development-ui.e2e.test.tsx",
      ".smithers/tests/docs-driven-development-workflow.test.ts",
      ".smithers/ui/ddd-tabs.test.tsx",
    ];
    const dddFeature = validateFeatures(root).find((feature) => feature.id === "docs-driven-development");
    expect(dddFeature).toBeTruthy();
    expect(dddFeature!.tests).toEqual(expect.arrayContaining(expectedTestPaths));
    for (const testPath of dddFeature!.tests) {
      expect(existsSync(join(root, testPath))).toBe(true);
    }

    const generatedDoc = readFileSync(join(root, ".smithers/spec/content/features/docs-driven-development.md"), "utf8");
    for (const testPath of expectedTestPaths) {
      expect(generatedDoc).toContain(testPath);
    }
  });

  test("build.ts propagates failures and writes generated artifacts on success from a temp filesystem", () => {
    const missingRoot = tempRoot();
    const missing = spawnSync("bun", [realBuildScript], { cwd: missingRoot, encoding: "utf8" });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain("empty starter spec");
    expect(existsSync(join(missingRoot, ".smithers/ui/ddd-features.generated.ts"))).toBe(true);

    const root = tempRoot();
    writeFeatures(root, [feature({ status: "not-real" })]);

    const failed = spawnSync("bun", [realBuildScript], { cwd: root, encoding: "utf8" });
    expect(failed.status).not.toBe(0);
    expect(existsSync(join(root, ".smithers/ui/ddd-docsContent.generated.ts"))).toBe(false);

    writeFeatures(root, [feature({ id: "built", status: "fixed" })]);
    execFileSync("bun", [realBuildScript], { cwd: root, encoding: "utf8" });

    expect(existsSync(join(root, ".smithers/spec/content/features/built.md"))).toBe(true);
    expect(existsSync(join(root, ".smithers/ui/ddd-docsContent.generated.ts"))).toBe(true);
    expect(existsSync(join(root, ".smithers/ui/ddd-ticketsBacklog.generated.ts"))).toBe(true);
  });
});
