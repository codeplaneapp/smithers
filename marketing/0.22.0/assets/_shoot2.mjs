// Render the second (CLI/agents) launch-thread cards from _cards2.html.
// Run from repo root:  node marketing/0.22.0/assets/_shoot2.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../../apps/smithers-studio-2/package.json'));
const { chromium } = require('playwright');

const cards = ['hero2', 'starters', 'optimize', 'hardening'];
const out = { hero2: 'cli-hero', starters: 'starters', optimize: 'optimize', hardening: 'hardening' };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(join(here, '_cards2.html')).href);
await page.waitForTimeout(300);
for (const id of cards) {
  const el = await page.$('#' + id);
  await el.screenshot({ path: join(here, out[id] + '.png') });
  console.log('shot', out[id] + '.png');
}
await browser.close();
