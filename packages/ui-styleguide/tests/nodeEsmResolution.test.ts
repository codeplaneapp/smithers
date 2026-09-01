/**
 * The package's own entry point, loaded the way `apps/review` loads it.
 *
 * `apps/review` imports this package under Node ESM, where a relative specifier
 * without an extension does not resolve. `tests/generatedThemes.test.ts` guards
 * that discipline for `src/themes/*` only, and the barrel's own specifiers were
 * checked nowhere in this package -- an extension dropped from `src/index.ts`
 * surfaced two packages away, in `apps/review/tests/nodeRuntimeResolution.test.ts`.
 *
 * The suite itself runs under Bun, which resolves extensionless specifiers, so
 * this has to be a real Node process.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("node ESM resolution", () => {
  test("imports the barrel and every export it names", () => {
    const program = [
      `const m = await import(${JSON.stringify(`${packageRoot}/src/index.ts`)});`,
      "const names = Object.keys(m).sort().join(',');",
      "if (typeof m.workflowUiThemeCss !== 'string') throw new Error('workflowUiThemeCss is not a string');",
      "if (typeof m.standaloneThemeCss() !== 'string') throw new Error('standaloneThemeCss() is not a string');",
      "if (Object.keys(m.themeRegistry).length !== 8) throw new Error('registry is not the eight palettes');",
      "process.stdout.write(names);",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.split(",")).toEqual([
      "DEFAULT_THEME_KEY",
      "SOFT_TINT_AMOUNT",
      "STRONG_TINT_AMOUNT",
      "contrastRatio",
      "contrastRatioOf",
      "findTheme",
      "mixChannels",
      "mixColors",
      "reducedMotionCss",
      "serializeThemeVariant",
      "standaloneThemeCss",
      "themeCss",
      "themeRegistry",
      "workflowUiLayoutCss",
      "workflowUiStyles",
      "workflowUiThemeCss",
    ]);
  }, 60_000);
});
