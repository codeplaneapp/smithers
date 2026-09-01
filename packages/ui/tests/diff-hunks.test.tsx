// Diff domain + <DiffHunks> render/interaction tests.
//
// The pure domain (parse / paginate / group / binary / status) is asserted with
// plain expectations; markup is asserted with renderToStaticMarkup (the
// components.test convention); the "Expand remaining" reveal is driven under
// happy-dom with real createRoot + act (the radix-interaction convention), the
// DOM coming from tests/happy-dom-preload.ts (bunfig `[test] preload`).
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  detectBinary,
  DiffHunks,
  fileLineCount,
  groupHunks,
  paginateHunks,
  parseUnifiedFile,
  PAGINATE_THRESHOLD,
  PAGINATE_VISIBLE,
  SMITHERS_UI_STYLE_ATTR,
  type DiffFile,
  type DiffLine,
} from "../src/index";

const SAMPLE_PATCH = `diff --git a/src/auth/session.ts b/src/auth/session.ts
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -41,5 +41,6 @@ export function createSession(user: User) {
   const id = randomId();
-  const token = signLegacy(id);
+  const token = sign(id);
+  audit("session.created", id);
   store.set(id, token);
   return id;
@@ -88,4 +89,5 @@ export function revokeSession(id: string) {
   store.delete(id);
+  audit("session.revoked", id);
   return true;
 }
`;

const WHITESPACE_STRIPPED_PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -7,3 +7,3 @@",
  " before",
  " ",
  " after",
]
  .join("\n")
  .replace(/[ \t]+$/gm, "");

const SQL_COMMENT_PATCH = `diff --git a/migrations/001.sql b/migrations/001.sql
--- a/migrations/001.sql
+++ b/migrations/001.sql
@@ -10,2 +10,1 @@
--- migrate down
 SELECT 1;
`;

const YAML_SEPARATOR_PATCH = `diff --git a/config/workflow.yaml b/config/workflow.yaml
--- a/config/workflow.yaml
+++ b/config/workflow.yaml
@@ -3,2 +3,1 @@
----
 steps:
`;

const AT_PREFIX_CONTEXT_PATCH = `diff --git a/docs/version.md b/docs/version.md
--- a/docs/version.md
+++ b/docs/version.md
@@ -4,3 +4,3 @@
 before
 @@ VERSION
 after
`;

describe("parseUnifiedFile", () => {
  test("parses a multi-hunk patch into DiffFile totals and hunks", () => {
    const file = parseUnifiedFile(SAMPLE_PATCH);
    expect(file.path).toBe("src/auth/session.ts");
    expect(file.status).toBe("modified");
    // Three '+' additions, one '-' deletion across the two hunks.
    expect(file.add).toBe(3);
    expect(file.del).toBe(1);

    const hunks = groupHunks(file);
    expect(hunks.length).toBe(2);
    expect(hunks[0]!.header.startsWith("@@ -41,5 +41,6 @@")).toBe(true);
    expect(hunks[1]!.header.startsWith("@@ -88,4 +89,5 @@")).toBe(true);
    // Header lines are never counted among the hunk's rendered lines.
    for (const hunk of hunks) {
      for (const line of hunk.lines) expect(line.text.startsWith("@@")).toBe(false);
    }
  });

  test("numbers additions on the new side and deletions on the old side", () => {
    const file = parseUnifiedFile(SAMPLE_PATCH);
    for (const line of file.lines) {
      if (line.text.startsWith("@@")) continue;
      if (line.kind === "add") {
        expect(typeof line.ln).toBe("number");
        expect(line.lnOld).toBeUndefined();
      }
      if (line.kind === "del") {
        expect(typeof line.lnOld).toBe("number");
        expect(line.ln).toBeUndefined();
      }
    }
  });

  test("treats whitespace-stripped empty hunk lines as context", () => {
    const file = parseUnifiedFile(WHITESPACE_STRIPPED_PATCH);
    expect(groupHunks(file)[0]!.lines).toEqual([
      { kind: "context", lnOld: 7, ln: 7, text: "before" },
      { kind: "context", lnOld: 8, ln: 8, text: "" },
      { kind: "context", lnOld: 9, ln: 9, text: "after" },
    ]);
  });

  test("preserves deleted SQL comments and YAML separators with correct numbering", () => {
    const sql = parseUnifiedFile(SQL_COMMENT_PATCH);
    expect(sql.del).toBe(1);
    expect(groupHunks(sql)[0]!.lines.slice(0, 2)).toEqual([
      { kind: "del", lnOld: 10, text: "-- migrate down" },
      { kind: "context", lnOld: 11, ln: 10, text: "SELECT 1;" },
    ]);

    const yaml = parseUnifiedFile(YAML_SEPARATOR_PATCH);
    expect(yaml.del).toBe(1);
    expect(groupHunks(yaml)[0]!.lines.slice(0, 2)).toEqual([
      { kind: "del", lnOld: 3, text: "---" },
      { kind: "context", lnOld: 4, ln: 3, text: "steps:" },
    ]);
  });

  test("does not mistake a context line beginning with @@ for a hunk header", () => {
    const file = parseUnifiedFile(AT_PREFIX_CONTEXT_PATCH);
    const hunks = groupHunks(file);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.header).toBe("@@ -4,3 +4,3 @@");
    expect(hunks[0]!.lines.slice(0, 3)).toEqual([
      { kind: "context", lnOld: 4, ln: 4, text: "before" },
      { kind: "context", lnOld: 5, ln: 5, text: "@@ VERSION" },
      { kind: "context", lnOld: 6, ln: 6, text: "after" },
    ]);
  });

  test("detects an added file from /dev/null and new file mode", () => {
    const added = parseUnifiedFile(
      `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
`,
    );
    expect(added.path).toBe("src/new.ts");
    expect(added.status).toBe("added");
    expect(added.add).toBe(2);
    expect(added.del).toBe(0);
    expect(added.modeChanges).toContain("new file mode 100644");
  });

  test("detects a deleted file from /dev/null", () => {
    const deleted = parseUnifiedFile(
      `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const x = 1;
-export const y = 2;
`,
    );
    expect(deleted.status).toBe("deleted");
    expect(deleted.del).toBe(2);
    expect(deleted.add).toBe(0);
  });

  test("captures rename oldPath and mode changes", () => {
    const renamed = parseUnifiedFile(
      `diff --git a/src/auth/auth-mw.ts b/src/auth/middleware.ts
old mode 100644
new mode 100755
similarity index 96%
rename from src/auth/auth-mw.ts
rename to src/auth/middleware.ts
--- a/src/auth/auth-mw.ts
+++ b/src/auth/middleware.ts
@@ -12,4 +12,5 @@ export function sign(id: string) {
   return id;
+  // renamed
 }
`,
    );
    expect(renamed.status).toBe("renamed");
    expect(renamed.path).toBe("src/auth/middleware.ts");
    expect(renamed.oldPath).toBe("src/auth/auth-mw.ts");
    expect(renamed.modeChanges).toContain("old mode 100644");
    expect(renamed.modeChanges).toContain("new mode 100755");
  });

  test("marks binary patches without parsing hunks", () => {
    const binary = parseUnifiedFile(
      `diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`,
    );
    expect(binary.isBinary).toBe(true);
    expect(binary.lines.length).toBe(0);
    expect(binary.add).toBe(0);
    expect(detectBinary(binary)).toBe(true);
  });

  test("an explicit isBinary override wins and carries a size", () => {
    const file = parseUnifiedFile("diff --git a/blob b/blob\n", { isBinary: true, sizeBytes: 2048 });
    expect(file.isBinary).toBe(true);
    expect(file.sizeBytes).toBe(2048);
    expect(detectBinary(file)).toBe(true);
  });
});

describe("detectBinary", () => {
  test("a GIT binary patch marker line is detected", () => {
    const file: DiffFile = {
      path: "a.bin",
      add: 0,
      del: 0,
      lines: [{ kind: "context", text: "GIT binary patch" }],
    };
    expect(detectBinary(file)).toBe(true);
  });

  test("a plain text file is not binary", () => {
    expect(detectBinary(parseUnifiedFile(SAMPLE_PATCH))).toBe(false);
  });
});

describe("paginateHunks", () => {
  const file: DiffFile = {
    path: "big.ts",
    add: 3,
    del: 0,
    lines: [
      { kind: "context", header: true, text: "@@ -1,3 +1,3 @@" },
      { kind: "context", ln: 1, lnOld: 1, text: "a" },
      { kind: "context", ln: 2, lnOld: 2, text: "b" },
      { kind: "add", ln: 3, text: "c" },
      { kind: "context", header: true, text: "@@ -10,3 +10,3 @@" },
      { kind: "context", ln: 10, lnOld: 10, text: "d" },
      { kind: "add", ln: 11, text: "e" },
      { kind: "add", ln: 12, text: "f" },
    ],
  };

  test("returns every hunk and zero hidden when the budget covers all lines", () => {
    const { hunks, hidden } = paginateHunks(file, 100);
    expect(hidden).toBe(0);
    expect(hunks.length).toBe(2);
  });

  test("drops whole trailing hunks past the budget", () => {
    const { hunks, hidden } = paginateHunks(file, 3);
    expect(hunks.length).toBe(1);
    expect(hunks[0]!.lines.length).toBe(3);
    expect(hidden).toBe(3);
  });

  test("partially trims the boundary hunk", () => {
    const { hunks, hidden } = paginateHunks(file, 4);
    expect(hunks.length).toBe(2);
    expect(hunks[1]!.lines.length).toBe(1);
    expect(hidden).toBe(2);
  });

  test("kept-plus-hidden always equals the full file line count", () => {
    const total = fileLineCount(file);
    for (const budget of [0, 1, 3, 4, 5, 6]) {
      const { hunks, hidden } = paginateHunks(file, budget);
      const kept = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
      expect(kept + hidden).toBe(total);
    }
  });

  test("the render budget constants are preserved", () => {
    expect(PAGINATE_THRESHOLD).toBe(2000);
    expect(PAGINATE_VISIBLE).toBe(1000);
  });
});

/** A file just over the pagination threshold, all in a single hunk. */
function oversizedFile(): DiffFile {
  const lines: DiffLine[] = [{ kind: "context", header: true, text: "@@ -1,2500 +1,2500 @@" }];
  for (let i = 1; i <= PAGINATE_THRESHOLD + 1; i += 1) {
    lines.push({ kind: "add", ln: i, text: `line ${i}` });
  }
  return { path: "big.ts", add: PAGINATE_THRESHOLD + 1, del: 0, lines };
}

describe("DiffHunks markup", () => {
  test("renders hunk headers, dual gutters, sign glyphs, and text", () => {
    const html = renderToStaticMarkup(<DiffHunks file={parseUnifiedFile(SAMPLE_PATCH)} />);
    expect(html).toContain("sui-diff");
    expect(html).toContain('data-slot="diff-hunks"');
    expect(html).toContain("sui-diff-hunk-head");
    expect(html).toContain("sui-diff-hunk-header");
    expect(html).toContain("sui-diff-ln-old");
    expect(html).toContain("sui-diff-ln-new");
    expect(html).toContain("sui-diff-sign");
    expect(html).toContain("sui-diff-line sui-diff-add");
    expect(html).toContain("sui-diff-line sui-diff-del");
    expect(html).toContain("@@ -41,5 +41,6 @@");
  });

  test("renders whitespace-stripped empty hunk lines as context", () => {
    const html = renderToStaticMarkup(<DiffHunks file={parseUnifiedFile(WHITESPACE_STRIPPED_PATCH)} />);
    expect(html).toContain(
      '<span class="sui-diff-ln sui-diff-ln-old">8</span><span class="sui-diff-ln sui-diff-ln-new">8</span><span class="sui-diff-sign"> </span><span class="sui-diff-text"></span>',
    );
  });

  test("revealed by default renders every line and no expand button", () => {
    const html = renderToStaticMarkup(<DiffHunks file={oversizedFile()} />);
    expect(html).not.toContain("sui-diff-paginate");
    expect(html).not.toContain("Expand remaining");
  });

  test("collapses the tail and labels the hidden remainder when not revealed", () => {
    const html = renderToStaticMarkup(<DiffHunks file={oversizedFile()} revealed={false} />);
    expect(html).toContain("sui-diff-paginate-btn");
    // 2001 lines total, first 1000 shown, 1001 hidden.
    expect(html).toContain("Expand remaining 1001 lines");
    expect(html).toContain(">line 1000<");
    expect(html).not.toContain(">line 1001<");
  });
});

describe("DiffHunks reveal interaction", () => {
  let container: HTMLElement | undefined;
  let root: Root | undefined;

  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(async () => {
    if (root) {
      const r = root;
      await act(async () => r.unmount());
      root = undefined;
    }
    container?.remove();
    container = undefined;
    document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
  });

  async function render(element: ReactElement): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const r = root;
    await act(async () => r.render(element));
  }

  test("clicking Expand fires onReveal", async () => {
    let revealed = 0;
    await render(<DiffHunks file={oversizedFile()} revealed={false} onReveal={() => (revealed += 1)} />);
    const button = container!.querySelector(".sui-diff-paginate-btn") as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Expand remaining 1001 lines");
    await act(async () => button!.click());
    expect(revealed).toBe(1);
  });

  test("mounting DiffHunks injects the ui stylesheet with the diff rules", async () => {
    await render(<DiffHunks file={parseUnifiedFile(SAMPLE_PATCH)} />);
    const styles = document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`);
    expect(styles.length).toBe(1);
    expect(styles[0]!.textContent).toContain(".sui-diff");
    expect(styles[0]!.textContent).toContain(".sui-diff-paginate-btn");
  });

  test("a binary file renders the sized placeholder its type documents, never hunks", () => {
    const html = renderToStaticMarkup(
      <DiffHunks file={parseUnifiedFile("diff --git a/logo.png b/logo.png\nGIT binary patch\n", { sizeBytes: 2048 })} />,
    );
    expect(html).toContain('data-binary="true"');
    expect(html).toContain("Binary file (2.0 KB)");
    expect(html).not.toContain("sui-diff-line");
  });

  test("a text file that merely mentions a binary marker still renders its hunks", () => {
    const html = renderToStaticMarkup(
      <DiffHunks
        file={parseUnifiedFile("diff --git a/notes.md b/notes.md\n@@ -0,0 +1,1 @@\n+GIT binary patch\n")}
      />,
    );
    expect(html).not.toContain('data-binary="true"');
    expect(html).toContain("sui-diff-line");
  });
});
