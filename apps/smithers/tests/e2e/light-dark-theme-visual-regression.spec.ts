import { expect, test, chromium, type Page } from "@playwright/test";
import { existsSync } from "node:fs";

const gatewayPort = Number(process.env.SMITHERS_E2E_GATEWAY_PORT ?? "7331");
const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;

type Theme = "light" | "dark";

type RenderedThemeSignature = {
  root: {
    theme: string | undefined;
    colorScheme: string;
    background: string;
    surface: string;
    text: string;
    brand: string;
  };
  shell: {
    backgroundColor: string;
    color: string;
  };
  surface: {
    backgroundColor: string;
    color: string;
  };
};

type Palette = {
  root: Omit<RenderedThemeSignature["root"], "theme">;
  shell: RenderedThemeSignature["shell"];
  surface: RenderedThemeSignature["surface"];
};

const PALETTE: Record<Theme, Palette> = {
  light: {
    root: {
      colorScheme: "light",
      background: "#fafafa",
      surface: "#ffffff",
      text: "#18181b",
      brand: "#6d56d8",
    },
    shell: {
      backgroundColor: "rgb(250, 250, 250)",
      color: "rgb(24, 24, 27)",
    },
    surface: {
      backgroundColor: "rgb(255, 255, 255)",
      color: "rgb(24, 24, 27)",
    },
  },
  dark: {
    root: {
      colorScheme: "dark",
      background: "#09090b",
      surface: "#141417",
      text: "#f4f4f5",
      brand: "#8b78e6",
    },
    shell: {
      backgroundColor: "rgb(9, 9, 11)",
      color: "rgb(244, 244, 245)",
    },
    surface: {
      backgroundColor: "rgb(20, 20, 23)",
      color: "rgb(244, 244, 245)",
    },
  },
};

function hasChromium(): boolean {
  if (process.env.CI) return false;
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/**
 * Screenshot-equivalent rendering contract: computed colors on mounted DOM
 * nodes prove that token values reach the actual browser-rendered shell and
 * surface without committing platform/font-sensitive image baselines.
 */
async function renderedThemeSignature(
  page: Page,
  shellSelector: string,
  surfaceSelector: string,
): Promise<RenderedThemeSignature> {
  return page.evaluate(
    ({ shellSelector, surfaceSelector }) => {
      const shell = document.querySelector<HTMLElement>(shellSelector);
      const surface = document.querySelector<HTMLElement>(surfaceSelector);
      if (!shell || !surface) {
        throw new Error(
          `Missing visual surface: ${shellSelector} / ${surfaceSelector}`,
        );
      }
      const rootStyle = getComputedStyle(document.documentElement);
      const shellStyle = getComputedStyle(shell);
      const surfaceStyle = getComputedStyle(surface);
      return {
        root: {
          theme: document.documentElement.dataset.theme,
          colorScheme: rootStyle.colorScheme,
          background: rootStyle.getPropertyValue("--bg").trim(),
          surface: rootStyle.getPropertyValue("--surface").trim(),
          text: rootStyle.getPropertyValue("--text").trim(),
          brand: rootStyle.getPropertyValue("--brand").trim(),
        },
        shell: {
          backgroundColor: shellStyle.backgroundColor,
          color: shellStyle.color,
        },
        surface: {
          backgroundColor: surfaceStyle.backgroundColor,
          color: surfaceStyle.color,
        },
      };
    },
    { shellSelector, surfaceSelector },
  );
}

function expectedSignature(theme: Theme): RenderedThemeSignature {
  const palette = PALETTE[theme];
  return {
    root: { theme, ...palette.root },
    shell: palette.shell,
    surface: palette.surface,
  };
}

async function persistedTheme(page: Page): Promise<Theme | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("smithers.prefs");
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as { state?: { theme?: unknown } };
      return value.state?.theme === "light" || value.state?.theme === "dark"
        ? value.state.theme
        : null;
    } catch {
      return null;
    }
  });
}

type RunSummary = {
  runId: string;
  workflowKey?: string;
  workflowName?: string;
};

async function seededMonitorRun(page: Page): Promise<RunSummary> {
  const response = await page.request.post(`${gatewayOrigin}/v1/rpc/listRuns`, {
    data: {},
  });
  expect(response.ok()).toBe(true);
  const frame = (await response.json()) as {
    ok?: boolean;
    payload?: RunSummary[];
  };
  expect(frame.ok).toBe(true);
  const run = frame.payload?.find(
    (candidate) =>
      (candidate.workflowKey ?? candidate.workflowName) === "e2e-monitor",
  );
  expect(run).toBeDefined();
  return run as RunSummary;
}

test.describe("light and dark theme visual regression", () => {
  // CI intentionally has no browser binaries. Keep this real-browser suite
  // discoverable but harmless there (and on local machines before install).
  test.skip(
    !hasChromium(),
    "Chromium is unavailable; run after `playwright install chromium`.",
  );

  test("the home shell renders both palettes and persists the selected theme", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/");

    // Start from the system-light default instead of a state inherited from a
    // prior local browser session, then exercise the actual visible control.
    await page.evaluate(() => window.localStorage.removeItem("smithers.prefs"));
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /Turn ideas into momentum/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message Smithers" }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect
      .poll(() =>
        renderedThemeSignature(page, ".app-shell", ".landing-features article"),
      )
      .toEqual(expectedSignature("light"));

    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => persistedTheme(page)).toBe("dark");
    await expect
      .poll(() =>
        renderedThemeSignature(page, ".app-shell", ".landing-features article"),
      )
      .toEqual(expectedSignature("dark"));

    // The persisted preference is reapplied after a full app reload, including
    // its control label and the same rendered palette, not merely an attribute.
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Switch to light mode" }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect
      .poll(() =>
        renderedThemeSignature(page, ".app-shell", ".landing-features article"),
      )
      .toEqual(expectedSignature("dark"));

    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(() => persistedTheme(page)).toBe("light");
  });

  test("the seeded monitor overview and run detail render explicit light and dark palettes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const run = await seededMonitorRun(page);

    for (const { theme, oppositeSystemTheme } of [
      { theme: "light" as const, oppositeSystemTheme: "dark" as const },
      { theme: "dark" as const, oppositeSystemTheme: "light" as const },
    ]) {
      // An opposing OS preference proves the gateway's explicit theme control
      // wins before the monitor bundle mounts.
      await page.emulateMedia({
        colorScheme: oppositeSystemTheme,
        reducedMotion: "reduce",
      });
      await page.goto(`${gatewayOrigin}/monitor?theme=${theme}`);
      await expect(page.getByTestId("monitor-root")).toBeVisible();
      await expect(page.getByTestId("monitor-runs-table")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect
        .poll(() =>
          renderedThemeSignature(page, "body", ".mon-runs-table-panel"),
        )
        .toEqual(expectedSignature(theme));

      await page.goto(
        `${gatewayOrigin}/monitor?theme=${theme}&runId=${encodeURIComponent(run.runId)}`,
      );
      await expect(page.getByTestId("monitor-run-detail")).toBeVisible();
      await expect(page.getByTestId("monitor-tree")).toBeVisible();
      await expect(page.getByTestId("monitor-events")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect
        .poll(() => renderedThemeSignature(page, "body", ".mon-tree-panel"))
        .toEqual(expectedSignature(theme));
    }
  });
});
