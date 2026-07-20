import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerChangelogInSidebar } from "../lib/release-content/files";

let root: string;

const docsJson = `{
  "name": "Smithers",
  "navigation": {
    "tabs": [
      {
        "tab": "Changelog",
        "groups": [
          {
            "group": "Changelog",
            "pages": [
              "changelogs/0.26.1",
              "changelogs/0.26.0",
              "changelogs/0.25.4"
            ]
          }
        ]
      }
    ]
  }
}
`;

function sidebarPages(): string[] {
  const parsed = JSON.parse(readFileSync(join(root, "docs/docs.json"), "utf8"));
  return parsed.navigation.tabs[0].groups[0].pages;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release-content-sidebar-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs/docs.json"), docsJson);
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best-effort temp cleanup */ }
});

describe("registerChangelogInSidebar", () => {
  test("inserts a new highest version at the top of the changelog group", () => {
    expect(registerChangelogInSidebar(root, "0.27.0")).toBe("docs/docs.json");
    expect(sidebarPages()).toEqual([
      "changelogs/0.27.0",
      "changelogs/0.26.1",
      "changelogs/0.26.0",
      "changelogs/0.25.4",
    ]);
  });

  test("keeps semver order for a backfilled middle version", () => {
    expect(registerChangelogInSidebar(root, "0.26.2")).toBe("docs/docs.json");
    expect(sidebarPages()).toEqual([
      "changelogs/0.26.2",
      "changelogs/0.26.1",
      "changelogs/0.26.0",
      "changelogs/0.25.4",
    ]);
  });

  test("appends an oldest version at the end, preserving valid JSON commas", () => {
    expect(registerChangelogInSidebar(root, "0.25.3")).toBe("docs/docs.json");
    expect(sidebarPages()).toEqual([
      "changelogs/0.26.1",
      "changelogs/0.26.0",
      "changelogs/0.25.4",
      "changelogs/0.25.3",
    ]);
  });

  test("is idempotent when the entry already exists", () => {
    const before = readFileSync(join(root, "docs/docs.json"), "utf8");
    expect(registerChangelogInSidebar(root, "0.26.0")).toBeNull();
    expect(readFileSync(join(root, "docs/docs.json"), "utf8")).toBe(before);
  });

  test("no-ops when docs/docs.json does not exist", () => {
    rmSync(join(root, "docs/docs.json"));
    expect(registerChangelogInSidebar(root, "0.27.0")).toBeNull();
  });

  test("edit is minimal: only one line added, rest of the file byte-identical", () => {
    const before = readFileSync(join(root, "docs/docs.json"), "utf8").split("\n");
    registerChangelogInSidebar(root, "0.27.0");
    const after = readFileSync(join(root, "docs/docs.json"), "utf8").split("\n");
    expect(after.length).toBe(before.length + 1);
    expect(after.filter((line) => !line.includes("changelogs/0.27.0"))).toEqual(before);
  });
});
