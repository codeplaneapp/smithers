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
});
