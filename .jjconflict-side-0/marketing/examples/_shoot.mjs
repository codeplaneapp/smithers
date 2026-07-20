// Render the examples-folder card from _card.html using the Smithers design tokens.
// Run from the repo root:  node marketing/examples/_shoot.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
// playwright is a dev dep of the studio-2 app; resolve it from there.
const require = createRequire(join(here, '../../apps/smithers-studio-2/package.json'));
const { chromium } = require('playwright');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(join(here, '_card.html')).href);
await page.waitForTimeout(300);
const el = await page.$('#examples');
await el.screenshot({ path: join(here, 'examples-folder.png') });
console.log('shot examples-folder.png');
await browser.close();
