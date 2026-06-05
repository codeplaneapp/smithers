// Render the launch-thread cards from _cards.html using the Studio 2 design tokens.
// Run from the repo root:  node marketing/0.22.0/assets/_shoot.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
// playwright is a dev dep of the studio-2 app; resolve it from there.
const require = createRequire(join(here, '../../../apps/smithers-studio-2/package.json'));
const { chromium } = require('playwright');

const cards = ['hero', 'chat', 'state', 'fork', 'agent'];
const out = { hero: 'hero', chat: 'chat-first', state: 'color-state', fork: 'task-fork', agent: 'any-agent' };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(join(here, '_cards.html')).href);
await page.waitForTimeout(300);
for (const id of cards) {
  const el = await page.$('#' + id);
  await el.screenshot({ path: join(here, out[id] + '.png') });
  console.log('shot', out[id] + '.png');
}
await browser.close();
