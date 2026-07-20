import { describe, expect, test } from "bun:test";
import { standaloneThemeCss } from "../src";

describe("standaloneThemeCss", () => {
  test("ships both dark-mode strategies and keeps color values in token declarations", () => {
    const css = standaloneThemeCss();
    expect(css.length).toBeLessThan(8_192);
    expect(css).toContain('@media (prefers-color-scheme: dark) { :root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
    const declarations = css.match(/--[\w-]+:[^;}]+/g) ?? [];
    const withoutTokens = css.replace(/--[\w-]+:[^;}]+/g, "TOKEN");
    expect(declarations.length).toBeGreaterThan(30);
    expect(withoutTokens).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
    const colorRules = withoutTokens.match(/(?:^|[;{])\s*(?:color|background(?:-color)?)\s*:\s*([^;}]+)/g) ?? [];
    for (const rule of colorRules) expect(rule).toContain("var(--");
    expect(css).toContain("border-bottom:1px solid var(--border)");
    expect(css).toContain("border-top:1px solid var(--border)");
  });

  test("keeps unlayered code defaults out of embedded Pierre diffs", () => {
    const css = standaloneThemeCss();
    const guard = ":not(:where(.pierre-diff *))";
    expect(css).toContain(`code${guard} {`);
    expect(css).toContain(`pre${guard} {`);
    expect(css).toContain(`pre${guard} code${guard} {`);
    expect(css).not.toMatch(/(?:^|})\s*(?:code|pre|pre code)\s*\{/);
  });
});
