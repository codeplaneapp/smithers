import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resolveTheme, type ResolvedTheme } from "../src/internal/resolveTheme";
import { useResolvedTheme } from "../src/internal/useResolvedTheme";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  document.documentElement.removeAttribute("data-theme");
});

describe("resolveTheme", () => {
  test("uses the OS preference when data-theme is absent", () => {
    const html = { getAttribute: () => null };
    expect(resolveTheme(html, { matches: false })).toBe("light");
    expect(resolveTheme(html, { matches: true })).toBe("dark");
  });

  test("an explicit root data-theme wins over the OS preference", () => {
    expect(resolveTheme({ getAttribute: () => "light" }, { matches: true })).toBe("light");
    expect(resolveTheme({ getAttribute: () => "dark" }, { matches: false })).toBe("dark");
  });
});

describe("useResolvedTheme", () => {
  test("updates when data-theme toggles on the root", async () => {
    const seen: ResolvedTheme[] = [];
    function Probe() {
      const theme = useResolvedTheme();
      seen.push(theme);
      return <output data-theme-mode={theme}>{theme}</output>;
    }

    document.documentElement.setAttribute("data-theme", "light");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Probe />));
    expect(container.querySelector("output")?.getAttribute("data-theme-mode")).toBe("light");

    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.getAttribute("data-theme-mode")).toBe("dark");
    expect(seen).toContain("light");
    expect(seen).toContain("dark");
  });
});
