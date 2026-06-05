// Capture animated GIF frame sequences for the launch-thread cards.
// Run from repo root:  node marketing/0.22.0/assets/_anim.mjs
// Then encode with ffmpeg (see _gif.sh). Frames go to /tmp/anim/<card>/.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../../apps/smithers-studio-2/package.json'));
const { chromium } = require('playwright');

const FPS = 20;
const dt = 1000 / FPS;

const browser = await chromium.launch();

async function capture(cardId, outName, frames, onFrame) {
  const dir = `/tmp/anim/${outName}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(here, '_anim.html')).href);
  await page.evaluate((id) => window.__activate(id), cardId);
  await page.waitForTimeout(120);
  const el = await page.$('#' + cardId);
  for (let i = 0; i < frames; i++) {
    await onFrame(page, i);
    await el.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.png`) });
    await page.waitForTimeout(dt);
  }
  await page.close();
  console.log(`captured ${frames} frames -> ${dir}`);
}

// ---- fork: sequential reveal, then hold ----
await capture('cardFork', 'fork', 110, async (page, i) => {
  if (i === 14) await page.evaluate(() => window.forkStep(1));
  if (i === 34) await page.evaluate(() => window.forkStep(2));
  if (i === 54) await page.evaluate(() => window.forkStep(3));
  // i>=74 holds final state to ~1.8s before loop
});

// ---- chat: type -> respond -> board fills ----
await capture('cardChat', 'chat', 120, async (page, i) => {
  if (i === 8) await page.evaluate(() => window.chatStep(1));
  if (i === 22) await page.evaluate(() => window.chatStep(2));
  if (i === 42) await page.evaluate(() => window.chatStep(3));
  if (i === 50) await page.evaluate(() => window.chatStep(4));
  if (i === 55) await page.evaluate(() => window.chatStep(5));
  if (i === 60) await page.evaluate(() => window.chatStep(6));
  if (i === 65) await page.evaluate(() => window.chatStep(7));
  if (i === 70) await page.evaluate(() => window.chatStep(8));
  // type the next slash command between frames 80..104
  if (i >= 80 && i <= 104) {
    const frac = (i - 80) / 24;
    await page.evaluate((f) => window.chatType(f), frac);
  }
  // i>105 holds to loop
});

await browser.close();
