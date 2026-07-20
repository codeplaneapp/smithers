/** @jsxImportSource react */
// PierreDiffView is the heavy `@pierre/diffs` adapter, exported through the
// `@smithers-orchestrator/ui/adapters/pierre-diff-view` subpath (never the base
// barrel). CodeView tokenizes lines asynchronously through Shiki and lays them
// out with ResizeObserver/rAF, none of which paint deterministically under
// happy-dom, so per-line highlighting is asserted against the parsed CodeView
// model (`patchToCodeViewItems`) while the live mount proves the widget renders
// and the diff-stat header wiring is live in both layouts.
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  diffStyleForLayout,
  diffsThemeForMode,
  normalizeDiffPath,
  patchToCodeViewItems,
  PierreDiffView,
} from "../src/adapters/pierre-diff-view";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";

const PATCH = `diff --git a/greet.ts b/greet.ts
index 1111111..2222222 100644
--- a/greet.ts
+++ b/greet.ts
@@ -1,3 +1,3 @@
 const name = "world";
-const value = 1;
+const value = 2;
 export const unchanged = 0;
`;

const TWO_FILE_PATCH = `diff --git a/first.ts b/first.ts
index 1111111..2222222 100644
--- a/first.ts
+++ b/first.ts
@@ -1,1 +1,1 @@
-const first = 1;
+const first = 2;
diff --git a/second.ts b/second.ts
index 3333333..4444444 100644
--- a/second.ts
+++ b/second.ts
@@ -1,1 +1,1 @@
-const second = 1;
+const second = 2;
`;

describe("theme + layout mapping", () => {
  test("mode maps onto the DiffsThemeNames GitHub themes", () => {
    expect(diffsThemeForMode("light")).toBe("github-light");
    expect(diffsThemeForMode("dark")).toBe("github-dark");
  });

  test("layout maps onto CodeView diffStyle (split=side-by-side, inline=unified)", () => {
    expect(diffStyleForLayout("split")).toBe("split");
    expect(diffStyleForLayout("inline")).toBe("unified");
  });

  test("normalizeDiffPath strips quotes and a/ b/ prefixes", () => {
    expect(normalizeDiffPath("a/src/x.ts")).toBe("src/x.ts");
    expect(normalizeDiffPath("b/src/x.ts")).toBe("src/x.ts");
    expect(normalizeDiffPath('"a/with space.ts"')).toBe("with space.ts");
    expect(normalizeDiffPath(undefined)).toBe("");
  });
});

describe("patchToCodeViewItems", () => {
  test("parses a patch into one diff item per file with per-line changes", () => {
    const items = patchToCodeViewItems(PATCH);
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe("greet.ts");
    expect(items[0]!.type).toBe("diff");

    // Both changed lines survive into the CodeView model that Shiki highlights
    // per line, and the hunk carries the +1/-1 line accounting.
    const item = items[0]!;
    const hunk = item.type === "diff" ? item.fileDiff.hunks[0]! : undefined;
    expect(hunk?.additionLines).toBe(1);
    expect(hunk?.deletionLines).toBe(1);
    const model = JSON.stringify(items);
    expect(model).toContain("const value = 1;");
    expect(model).toContain("const value = 2;");
  });

  test("selectedPath narrows a multi-file patch to the matching file", () => {
    expect(patchToCodeViewItems(TWO_FILE_PATCH).length).toBe(2);
    const only = patchToCodeViewItems(TWO_FILE_PATCH, "second.ts");
    expect(only.length).toBe(1);
    expect(only[0]!.id).toBe("second.ts");
  });

  test("an unmatched selectedPath falls back to every file", () => {
    expect(patchToCodeViewItems(TWO_FILE_PATCH, "missing.ts").length).toBe(2);
  });

  test("empty, whitespace, and malformed patches degrade to no items", () => {
    expect(patchToCodeViewItems("")).toEqual([]);
    expect(patchToCodeViewItems("   \n  ")).toEqual([]);
    expect(patchToCodeViewItems("this is not a diff at all")).toEqual([]);
  });
});

describe("PierreDiffView markup", () => {
  test("empty patch renders the honest empty-state, not a broken CodeView", () => {
    const html = renderToStaticMarkup(<PierreDiffView patch="" />);
    expect(html).toContain("sui-pierre-diff-empty");
    expect(html).toContain("No diff is available for this change.");
  });

  test("empty-state honors a custom label and passthrough className", () => {
    const html = renderToStaticMarkup(
      <PierreDiffView patch="" className="my-frame" emptyLabel="Nothing changed" />,
    );
    expect(html).toContain("Nothing changed");
    expect(html).toContain("my-frame");
  });

  test("a non-empty patch mounts the CodeView frame in both layouts", () => {
    for (const layout of ["split", "inline"] as const) {
      const html = renderToStaticMarkup(<PierreDiffView patch={PATCH} layout={layout} mode="dark" />);
      expect(html).toContain("sui-pierre-diff");
    }
  });
});

describe("PierreDiffView live render (happy-dom)", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let container: HTMLElement | undefined;
  let root: Root | undefined;

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

  async function mount(element: ReactElement): Promise<HTMLElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const r = root;
    await act(async () => r.render(element));
    // Let CodeView's mount effect publish the header-metadata slot content.
    for (let i = 0; i < 20 && !container.querySelector(".sui-pierre-diff-stat"); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    return container;
  }

  for (const layout of ["split", "inline"] as const) {
    test(`renders the CodeView frame and per-file diff stat in ${layout} layout`, async () => {
      const el = await mount(<PierreDiffView patch={PATCH} layout={layout} mode="light" />);
      expect(el.querySelector(".sui-pierre-diff")).not.toBeNull();
      const stat = el.querySelector(".sui-pierre-diff-stat");
      expect(stat).not.toBeNull();
      expect(stat!.textContent).toBe("+1 -1");
    });
  }
});
