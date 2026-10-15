// Draws the link-preview image (src/assets/og.png, 1200×630) from card.html, in
// the installed Google Chrome: vp run threads-site#og. Needs playwright-core (a
// dev dependency of the repository's root).
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({channel: 'chrome'});
const page = await browser.newPage({viewport: {width: 1200, height: 630}});
await page.goto(pathToFileURL(path.join(here, 'card.html')).href);
await page.screenshot({path: path.join(here, '../src/assets/og.png')});
await browser.close();
