import { describe, it, expect } from "bun:test";
import { toNodeDiffView } from "../src/modes/diffUtils.ts";

describe("toNodeDiffView", () => {
  it("renders a DiffBundle's patches as concatenated unified diff", () => {
    const view = toNodeDiffView({
      seq: 3,
      baseRef: "abc",
      patches: [
        { path: "src/a.ts", operation: "modify", diff: "@@ -1 +1 @@\n-old\n+new\n" },
        { path: "src/b.ts", operation: "add", diff: "@@ -0,0 +1 @@\n+hi\n" },
      ],
    });
    expect(view.kind).toBe("patch");
    if (view.kind !== "patch") throw new Error("expected patch");
    expect(view.summary).toBe("2 files changed");
    expect(view.unified).toContain("# modify src/a.ts");
    expect(view.unified).toContain("+new");
    expect(view.unified).toContain("# add src/b.ts");
    expect(view.unified).toContain("+hi");
  });

  it("singularizes the file count", () => {
    const view = toNodeDiffView({
      patches: [{ path: "x", operation: "modify", diff: "@@ @@\n+a\n" }],
    });
    if (view.kind !== "patch") throw new Error("expected patch");
    expect(view.summary).toBe("1 file changed");
  });

  it("treats a bundle with only empty patches as empty", () => {
    const view = toNodeDiffView({ patches: [{ path: "x", operation: "modify", diff: "" }] });
    expect(view.kind).toBe("empty");
    if (view.kind !== "empty") throw new Error("expected empty");
    expect(view.message).toContain("No file changes");
  });

  it("renders a stat-only payload with per-file counts", () => {
    const view = toNodeDiffView({
      summary: {
        filesChanged: 2,
        added: 10,
        removed: 3,
        files: [
          { path: "a.ts", added: 7, removed: 1 },
          { path: "b.ts", added: 3, removed: 2 },
        ],
      },
    });
    expect(view.kind).toBe("stat");
    if (view.kind !== "stat") throw new Error("expected stat");
    expect(view.summary).toContain("2 files changed");
    expect(view.summary).toContain("+10 -3");
    expect(view.summary).toContain("too large");
    expect(view.files).toContain("a.ts  +7 -1");
    expect(view.files).toContain("b.ts  +3 -2");
  });

  it("returns empty for missing/garbage payloads", () => {
    expect(toNodeDiffView(undefined).kind).toBe("empty");
    expect(toNodeDiffView(null).kind).toBe("empty");
    expect(toNodeDiffView("nope").kind).toBe("empty");
    expect(toNodeDiffView({}).kind).toBe("empty");
  });

  it("surfaces an RPC error as a distinct error view, never as 'no diff'", () => {
    // The gateway rejects oversized bundles (DiffTooLarge), dirty trees, etc. —
    // useGatewayRpc catches the throw into `error` with `data` undefined, which
    // used to render the factually wrong "No diff available for this node."
    const view = toNodeDiffView(undefined, new Error("DiffTooLarge: bundle exceeds 50MB"));
    expect(view.kind).toBe("error");
    if (view.kind !== "error") throw new Error("expected error");
    expect(view.message).toContain("DiffTooLarge");
  });

  it("the error takes precedence over any stale payload and blank messages get a fallback", () => {
    const view = toNodeDiffView(
      { patches: [{ path: "x", operation: "modify", diff: "@@ @@\n+a\n" }] },
      new Error("gateway unreachable"),
    );
    expect(view.kind).toBe("error");
    const blank = toNodeDiffView(undefined, new Error(""));
    if (blank.kind !== "error") throw new Error("expected error");
    expect(blank.message).toBe("diff request failed");
    // No error → normal paths unaffected.
    expect(toNodeDiffView(undefined, null).kind).toBe("empty");
  });

  it("collapses `git diff --binary` patches to a one-line marker (never raw base85)", () => {
    const binaryDiff =
      "diff --git a/logo.png b/logo.png\n" +
      "index 0000000..1111111 100644\n" +
      "GIT binary patch\n" +
      "literal 5678\n" +
      "zcmZ?wbhEHbRA^)@xW>>@|Ns9$#h)(1PA(|VU|?im^)N5&u<`$@%TFvXQ~lr$\n";
    const view = toNodeDiffView({
      patches: [
        { path: "logo.png", operation: "add", diff: binaryDiff },
        { path: "src/a.ts", operation: "modify", diff: "@@ -1 +1 @@\n-old\n+new\n" },
      ],
    });
    if (view.kind !== "patch") throw new Error("expected patch");
    expect(view.unified).toContain("# add logo.png\n(binary file changed)");
    expect(view.unified).not.toContain("literal 5678");
    expect(view.unified).not.toContain("zcmZ?");
    // Text patches still render and binary files still count in the summary.
    expect(view.unified).toContain("+new");
    expect(view.summary).toBe("2 files changed");
  });

  it("detects the 'Binary files … differ' form and a binaryContent flag too", () => {
    const differ = toNodeDiffView({
      patches: [
        {
          path: "img.gif",
          operation: "modify",
          diff: "diff --git a/img.gif b/img.gif\nBinary files a/img.gif and b/img.gif differ\n",
        },
      ],
    });
    if (differ.kind !== "patch") throw new Error("expected patch");
    expect(differ.unified).toContain("(binary file changed)");

    const flagged = toNodeDiffView({
      patches: [{ path: "img.gif", operation: "modify", diff: "anything", binaryContent: "aGk=" }],
    });
    if (flagged.kind !== "patch") throw new Error("expected patch");
    expect(flagged.unified).toContain("(binary file changed)");
    expect(flagged.unified).not.toContain("anything");
  });

  it("trims a trailing CRLF as well as a bare newline", () => {
    const view = toNodeDiffView({
      patches: [{ path: "x", operation: "modify", diff: "@@ @@\n+a\r\n" }],
    });
    if (view.kind !== "patch") throw new Error("expected patch");
    expect(view.unified.endsWith("+a")).toBe(true);
  });
});
