import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createTempRepo, writeTestWorkflow } from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * The monitor is served from a real gateway and inspected in Chromium so this
 * covers the browser's prefers-reduced-motion implementation, rather than just
 * checking the source CSS string. Chromium is deliberately optional: CI does
 * not install browsers, while local developer runs exercise both preferences.
 */
const require = createRequire(import.meta.url);
const CLI_ENTRY = resolve(import.meta.dir, "..", "src", "index.js");

function resolveChromium() {
  try {
    const chromium = require("playwright").chromium;
    const executablePath = chromium?.executablePath?.();
    if (typeof executablePath === "string" && existsSync(executablePath)) return chromium;
  } catch {}
  return null;
}

const CHROMIUM = resolveChromium();
const browserTest = CHROMIUM ? test : test.skip;

async function findOpenPort() {
  const server = createServer();
  await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePort);
  });
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!address || typeof address === "string") throw new Error("Could not allocate an open port");
  return address.port;
}

async function waitForHealth(base, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Gateway did not become healthy at ${base}`);
}

browserTest(
  "monitor honors reduced motion while retaining normal motion",
  async () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo, ".smithers/workflows/basic.tsx");
    const port = await findOpenPort();
    const base = `http://127.0.0.1:${port}`;
    const gateway = spawn(
      process.execPath,
      ["run", CLI_ENTRY, "gateway", "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: repo.dir,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        stdio: "ignore",
      },
    );

    let browser;
    try {
      await waitForHealth(base);
      browser = await CHROMIUM.launch({ headless: true });
      const normal = await browser.newPage({ reducedMotion: "no-preference" });
      const reduced = await browser.newPage({ reducedMotion: "reduce" });

      await Promise.all([
        normal.goto(`${base}/monitor?theme=light`, { waitUntil: "domcontentloaded" }),
        reduced.goto(`${base}/monitor?theme=dark`, { waitUntil: "domcontentloaded" }),
      ]);
      await Promise.all([
        normal.waitForSelector('[data-testid="monitor-conn"] .mon-dot-pulse'),
        reduced.waitForSelector('[data-testid="monitor-conn"] .mon-dot-pulse'),
        normal.waitForSelector("button.sui-button"),
        reduced.waitForSelector("button.sui-button"),
      ]);

      // Shell landmarks, names, and the rail-before-content escape hatch are
      // present even before a run exists.
      expect(await normal.getByRole("banner").count()).toBe(1);
      expect(await normal.getByRole("main").count()).toBe(1);
      expect(await normal.locator("main#monitor-main").count()).toBe(1);
      expect(await normal.locator("h1").textContent()).toBe("Smithers Monitor");
      expect(await normal.locator('[data-testid="monitor-filter"]').getAttribute("aria-label")).toBe("Search runs");
      await normal.keyboard.press("Tab");
      expect(await normal.evaluate(() => document.activeElement?.classList.contains("mon-skip-link"))).toBe(true);
      const skipBox = await normal.locator(".mon-skip-link").boundingBox();
      expect(skipBox?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect(await normal.locator(".mon-skip-link").evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
      await normal.keyboard.press("Enter");
      expect(await normal.evaluate(() => document.activeElement?.id)).toBe("monitor-main");

      const styles = async (page) =>
        page.evaluate(() => {
          const monitorAnimation = document.querySelector('[data-testid="monitor-conn"] .mon-dot-pulse');
          const refresh = document.querySelector("button.sui-button");
          if (!(monitorAnimation instanceof HTMLElement) || !(refresh instanceof HTMLElement))
            throw new Error("Monitor controls did not mount");
          const inspector = document.createElement("aside");
          inspector.className = "mon-inspector";
          document.body.appendChild(inspector);
          const durationMs = (value) =>
            value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1_000;
          const color = (variable, background) => {
            const sample = document.createElement("span");
            sample.style.color = `var(${variable})`;
            sample.style.backgroundColor = `var(${background})`;
            document.body.appendChild(sample);
            const computed = getComputedStyle(sample);
            const result = [computed.color, computed.backgroundColor];
            sample.remove();
            return result;
          };
          const rgb = (value) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          const luminance = (value) => {
            const channels = rgb(value).map((channel) => {
              const normalized = channel / 255;
              return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
            });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
          };
          const ratio = ([foreground, background]) => {
            const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
            return (lighter + 0.05) / (darker + 0.05);
          };
          const inspectorStyle = getComputedStyle(inspector);
          const inspectorAnimationMs = durationMs(inspectorStyle.animationDuration);
          inspector.remove();
          return {
            preference: matchMedia("(prefers-reduced-motion: reduce)").matches,
            monitorAnimationMs: durationMs(getComputedStyle(monitorAnimation).animationDuration),
            monitorAnimationIterations: getComputedStyle(monitorAnimation).animationIterationCount,
            inspectorAnimationMs,
            controlTransitionMs: durationMs(getComputedStyle(refresh).transitionDuration),
            minimumTextContrast: Math.min(
              ratio(color("--text", "--bg")),
              ratio(color("--muted", "--bg")),
              ratio(color("--text", "--surface")),
              ratio(color("--muted", "--surface")),
            ),
          };
        });

      const normalStyles = await styles(normal);
      const reducedStyles = await styles(reduced);
      expect(normalStyles.preference).toBe(false);
      expect(normalStyles.monitorAnimationMs).toBe(1_200);
      expect(normalStyles.monitorAnimationIterations).toBe("infinite");
      expect(normalStyles.inspectorAnimationMs).toBe(140);
      // The control recipe ships pressed-state feedback as a 120ms transition;
      // reduced motion clamps the shared control sheet's transition duration in
      // the browser.
      expect(normalStyles.controlTransitionMs).toBe(120);
      expect(reducedStyles.preference).toBe(true);
      expect(reducedStyles.monitorAnimationMs).toBe(0.001);
      expect(reducedStyles.monitorAnimationIterations).toBe("1");
      expect(reducedStyles.inspectorAnimationMs).toBe(0.001);
      expect(reducedStyles.controlTransitionMs).toBe(0.001);
      expect(normalStyles.minimumTextContrast).toBeGreaterThanOrEqual(4.5);
      expect(reducedStyles.minimumTextContrast).toBeGreaterThanOrEqual(4.5);
    } finally {
      try {
        await browser?.close();
      } catch {}
      try {
        gateway.kill("SIGTERM");
      } catch {}
    }
  },
  120_000,
);
