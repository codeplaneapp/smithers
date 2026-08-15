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
        normal.goto(`${base}/monitor`, { waitUntil: "domcontentloaded" }),
        reduced.goto(`${base}/monitor`, { waitUntil: "domcontentloaded" }),
      ]);
      await Promise.all([
        normal.waitForSelector('[data-testid="monitor-conn"] .mon-dot-pulse'),
        reduced.waitForSelector('[data-testid="monitor-conn"] .mon-dot-pulse'),
        normal.waitForSelector("button.sui-button"),
        reduced.waitForSelector("button.sui-button"),
      ]);

      const styles = async (page) =>
        page.evaluate(() => {
          const monitorAnimation = document.querySelector('[data-testid="monitor-conn"] .mon-dot-pulse');
          const refresh = document.querySelector("button.sui-button");
          if (!(monitorAnimation instanceof HTMLElement) || !(refresh instanceof HTMLElement))
            throw new Error("Monitor controls did not mount");
          const durationMs = (value) =>
            value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1_000;
          return {
            preference: matchMedia("(prefers-reduced-motion: reduce)").matches,
            monitorAnimationMs: durationMs(getComputedStyle(monitorAnimation).animationDuration),
            controlTransitionMs: durationMs(getComputedStyle(refresh).transitionDuration),
          };
        });

      const normalStyles = await styles(normal);
      const reducedStyles = await styles(reduced);
      expect(normalStyles.preference).toBe(false);
      expect(normalStyles.monitorAnimationMs).toBe(1_200);
      // The control recipe ships pressed-state feedback as a 120ms transition;
      // reduced motion clamps the shared control sheet's transition duration in
      // the browser.
      expect(normalStyles.controlTransitionMs).toBe(120);
      expect(reducedStyles.preference).toBe(true);
      expect(reducedStyles.monitorAnimationMs).toBe(0.001);
      expect(reducedStyles.controlTransitionMs).toBe(0.001);
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
