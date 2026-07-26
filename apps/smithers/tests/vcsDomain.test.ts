import { describe, expect, test } from "bun:test";
import {
  buildSnapshot,
  parseGitBranches,
  parseGitStatusPorcelain,
  parseJjBookmarks,
  parseJjStatus,
  type LocalRepoDetection,
} from "../src/vcs/vcsDomain";

describe("vcs domain parsers", () => {
  test("parses dirty git porcelain with branch metadata", () => {
    const parsed = parseGitStatusPorcelain(
      [
        "## main...origin/main [ahead 1]",
        " M apps/smithers/src/app/router.ts",
        "A  apps/smithers/src/vcs/VcsCanvas.tsx",
        "R  old-name.ts -> new-name.ts",
        "?? apps/smithers/tests/vcsDomain.test.ts",
      ].join("\n"),
    );

    expect(parsed.current).toBe("main");
    expect(parsed.clean).toBe(false);
    expect(parsed.changes).toEqual([
      { status: " M", category: "modified", path: "apps/smithers/src/app/router.ts" },
      { status: "A ", category: "added", path: "apps/smithers/src/vcs/VcsCanvas.tsx" },
      { status: "R ", category: "renamed", oldPath: "old-name.ts", path: "new-name.ts" },
      { status: "??", category: "untracked", path: "apps/smithers/tests/vcsDomain.test.ts" },
    ]);
  });

  test("parses clean git state and branches", () => {
    expect(parseGitStatusPorcelain("## No commits yet on trunk\n")).toEqual({
      current: "trunk",
      changes: [],
      clean: true,
    });
    expect(parseGitBranches("main\nfeature/vcs\nmain\n")).toEqual(["feature/vcs", "main"]);
  });

  test("parses jj status and bookmarks", () => {
    const parsed = parseJjStatus(
      [
        "Working copy  : mzvwqpvn 12345678 local change",
        "Parent commit: abcdef01 main | previous",
        "Added regular file apps/smithers/src/vcs/VcsCanvas.tsx",
        "Modified regular file apps/smithers/src/app/router.ts",
        'Deleted regular file "old file.ts"',
      ].join("\n"),
    );

    expect(parsed.current).toBe("mzvwqpvn");
    expect(parsed.clean).toBe(false);
    expect(parsed.changes).toEqual([
      { status: "Added", category: "added", path: "apps/smithers/src/vcs/VcsCanvas.tsx" },
      { status: "Modified", category: "modified", path: "apps/smithers/src/app/router.ts" },
      { status: "Deleted", category: "deleted", path: "old file.ts" },
    ]);
    expect(parseJjBookmarks("main: abcdef01 message\nfeature/vcs*: 12345678 work\n")).toEqual(["feature/vcs", "main"]);
  });

  test("parses compact jj status output from real local workspaces", () => {
    const parsed = parseJjStatus(
      [
        "Working copy changes:",
        "M apps/cli/src/localUiServer.js",
        "A apps/smithers/src/vcs/VcsCanvas.tsx",
        "D old-file.ts",
        'R "old name.ts" => "new name.ts"',
        "Working copy  (@) : snsrmwrv c2e9f233 local-ui/local-ui-1782841600/vcs | (no description set)",
        "Parent commit (@-): ymlvqkwz e6a2de51 main | previous",
      ].join("\n"),
    );

    expect(parsed.current).toBe("@");
    expect(parsed.clean).toBe(false);
    expect(parsed.changes).toEqual([
      { status: "M", category: "modified", path: "apps/cli/src/localUiServer.js" },
      { status: "A", category: "added", path: "apps/smithers/src/vcs/VcsCanvas.tsx" },
      { status: "D", category: "deleted", path: "old-file.ts" },
      { status: "R", category: "renamed", oldPath: "old name.ts", path: "new name.ts" },
    ]);
  });

  test("parses jj bookmark list without conflict detail rows", () => {
    expect(
      parseJjBookmarks(
        [
          "main (conflicted):",
          "  - wrktuzsl bf1397b4 old target",
          "  + ymlvqkwz e6a2de51 new target",
          "  @git (behind by 42 commits): ymlvqkwz e6a2de51 remote target",
          "feature/vcs*: 12345678 work",
          "feat/rerender-trigger-observability (deleted)",
          "Hint: Some bookmarks have conflicts. Use `jj bookmark set <name> -r <rev>` to resolve.",
        ].join("\n"),
      ),
    ).toEqual(["feat/rerender-trigger-observability", "feature/vcs", "main"]);
  });

  test("builds mixed repository snapshots with jj primary", () => {
    const detection: LocalRepoDetection = {
      workspacePath: "/repo",
      repoRoot: "/repo",
      primary: "jj",
      hasGit: true,
      hasJj: true,
    };
    const snapshot = buildSnapshot({
      detection,
      git: null,
      jj: null,
      generatedAtMs: 42,
    });

    expect(snapshot).toMatchObject({
      workspacePath: "/repo",
      repoRoot: "/repo",
      primary: "jj",
      detected: { git: true, jj: true },
      generatedAtMs: 42,
    });
  });
});
