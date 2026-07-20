import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Browser coverage is deliberately opt-in outside CI: the CI image has no
 * browser binary, while local runs exercise the real Vite app and seed Gateway.
 */
const IS_CI = Boolean(
  process.env.CI && process.env.CI.toLowerCase() !== "false",
);
test.skip(
  IS_CI,
  "responsive browser coverage requires a locally installed browser",
);

const gatewayOrigin = `http://127.0.0.1:${process.env.SMITHERS_E2E_GATEWAY_PORT ?? "7331"}`;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
} as const;

type Viewport = (typeof VIEWPORTS)[keyof typeof VIEWPORTS];

async function expectNoDocumentOverflow(
  page: Page,
  label: string,
): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowingElements: Array.from(
      document.body.querySelectorAll<HTMLElement>("*"),
    ).flatMap((element) => {
      const rect = element.getBoundingClientRect();
      if (
        rect.right <= document.documentElement.clientWidth + 1 &&
        rect.left >= -1
      )
        return [];
      return [
        {
          className: element.className,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          tagName: element.tagName,
        },
      ];
    }),
  }));
  expect(
    dimensions.scrollWidth,
    `${label}: document must not horizontally overflow (${JSON.stringify(dimensions.overflowingElements)})`,
  ).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectHorizontallyUsable(
  locator: Locator,
  viewport: Viewport,
  label: string,
): Promise<void> {
  await expect(
    locator,
    `${label}: control should remain visible`,
  ).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label}: control should have a layout box`).not.toBeNull();
  if (!box) return;

  expect(
    box.x,
    `${label}: left edge should stay in the viewport`,
  ).toBeGreaterThanOrEqual(-1);
  expect(
    box.x + box.width,
    `${label}: right edge should stay in the viewport`,
  ).toBeLessThanOrEqual(viewport.width + 1);
}

async function runIdFor(page: Page, workflowKey: string): Promise<string> {
  const response = await page.request.post(`${gatewayOrigin}/v1/rpc/listRuns`, {
    data: {},
  });
  const frame = (await response.json()) as {
    ok?: boolean;
    payload?: Array<{ runId?: string; workflowKey?: string }>;
    error?: { message?: string };
  };
  expect(frame.ok, frame.error?.message ?? "listRuns failed").toBe(true);
  const runId = frame.payload?.find(
    (run) => run.workflowKey === workflowKey,
  )?.runId;
  expect(runId, `seeded ${workflowKey} run`).toBeTruthy();
  return runId as string;
}

test("normal shell keeps its composer usable at desktop, tablet, and phone widths", async ({
  page,
}) => {
  // The test is about settled layout geometry. View transitions intentionally
  // translate their contents, which would turn a measurement taken mid-motion
  // into a false horizontal-overflow failure.
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    await expect(page.locator(".app-shell")).toHaveAttribute(
      "data-mode",
      "home",
    );
    await expect(page.getByText("How can I help you?")).toBeVisible();
    await expectHorizontallyUsable(
      page.getByRole("textbox", { name: "Message Smithers" }),
      viewport,
      `${name} composer`,
    );
    await expectHorizontallyUsable(
      page.getByRole("button", { name: /sidebar layout/ }),
      viewport,
      `${name} layout toggle`,
    );
    await expectNoDocumentOverflow(page, `${name} normal shell`);
  }
});

test("sidebar monitor canvas keeps its controls usable and stacks on a phone", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.goto("/runs");

  const shell = page.locator(".app-shell");
  const rail = page.locator(".chat-rail");
  const canvas = page.locator(".main-canvas");
  const search = page.getByTestId("runs-search");
  await expect(shell).toHaveAttribute("data-mode", "sidebar");
  await expect(page.getByTestId("runs-canvas")).toBeVisible();
  await expectHorizontallyUsable(
    search,
    VIEWPORTS.desktop,
    "desktop monitor search",
  );
  await expectNoDocumentOverflow(page, "desktop sidebar monitor");

  const desktopRail = await rail.boundingBox();
  const desktopCanvas = await canvas.boundingBox();
  expect(desktopRail).not.toBeNull();
  expect(desktopCanvas).not.toBeNull();
  if (desktopRail && desktopCanvas) {
    expect(desktopRail.x + desktopRail.width).toBeLessThanOrEqual(
      desktopCanvas.x + 1,
    );
  }

  await page.setViewportSize(VIEWPORTS.tablet);
  await expectHorizontallyUsable(
    search,
    VIEWPORTS.tablet,
    "tablet monitor search",
  );
  await expectNoDocumentOverflow(page, "tablet sidebar monitor");

  await page.setViewportSize(VIEWPORTS.phone);
  await expect(page.locator(".rail-resizer")).toBeHidden();
  await expectHorizontallyUsable(
    search,
    VIEWPORTS.phone,
    "phone monitor search",
  );
  await search.fill("e2e-monitor");
  await expect(page.getByTestId("runs-row").first()).toBeVisible();
  await expectNoDocumentOverflow(page, "phone sidebar monitor");

  const phoneRail = await rail.boundingBox();
  const phoneCanvas = await canvas.boundingBox();
  expect(phoneRail).not.toBeNull();
  expect(phoneCanvas).not.toBeNull();
  if (phoneRail && phoneCanvas) {
    expect(phoneRail.x).toBeLessThanOrEqual(1);
    expect(phoneCanvas.x).toBeLessThanOrEqual(1);
    expect(phoneRail.y + phoneRail.height).toBeLessThanOrEqual(
      phoneCanvas.y + 1,
    );
  }
});

test("the real monitor custom-UI dialog fits at desktop and phone widths", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const runId = await runIdFor(page, "e2e-task");

  for (const [name, viewport] of Object.entries({
    desktop: VIEWPORTS.desktop,
    phone: VIEWPORTS.phone,
  })) {
    await page.setViewportSize(viewport);
    await page.goto(
      `${gatewayOrigin}/monitor?runId=${encodeURIComponent(runId)}`,
    );
    await expect(page.getByTestId("monitor-run-detail")).toBeVisible();

    const railBox = await page.locator(".mon-rail").boundingBox();
    const mainBox = await page.locator(".mon-main").boundingBox();
    expect(
      railBox,
      `${name} monitor rail should have a layout box`,
    ).not.toBeNull();
    expect(
      mainBox,
      `${name} monitor main pane should have a layout box`,
    ).not.toBeNull();
    if (railBox && mainBox) {
      if (name === "phone") {
        expect(railBox.y + railBox.height).toBeLessThanOrEqual(mainBox.y + 1);
      } else {
        expect(railBox.x + railBox.width).toBeLessThanOrEqual(mainBox.x + 1);
      }
    }

    const open = page.getByRole("button", { name: "Open UI" });
    await expectHorizontallyUsable(
      open,
      viewport,
      `${name} monitor dialog trigger`,
    );
    await open.click();

    const dialog = page.getByRole("dialog", { name: "e2e-task custom UI" });
    await expectHorizontallyUsable(dialog, viewport, `${name} monitor dialog`);
    const box = await dialog.boundingBox();
    expect(
      box,
      `${name} monitor dialog should have a layout box`,
    ).not.toBeNull();
    if (box) {
      expect(
        box.y,
        `${name} monitor dialog: top edge should stay in the viewport`,
      ).toBeGreaterThanOrEqual(-1);
      expect(
        box.y + box.height,
        `${name} monitor dialog: bottom edge should stay in the viewport`,
      ).toBeLessThanOrEqual(viewport.height + 1);
    }
    await expectNoDocumentOverflow(page, `${name} monitor dialog`);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});
