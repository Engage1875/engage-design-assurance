// Shared helpers for the ENGAGE browser tests.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_URL = pathToFileURL(path.join(ROOT, 'dist', 'Engage.html')).href;

let browser;
export async function getBrowser() {
  if (!browser) browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  return browser;
}
export async function closeBrowser() { if (browser) await browser.close(); browser = undefined; }

/** Open the app in a fresh browser context. Collects page errors and console errors. */
export async function openApp({ storage, beforeLoad } = {}) {
  const b = await getBrowser();
  const context = await b.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss().catch(() => {}); });
  if (storage) {
    await context.addInitScript(s => { if (!sessionStorage.getItem('__seeded')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); sessionStorage.setItem('__seeded', '1'); } }, storage);
  }
  if (beforeLoad) await beforeLoad(page, context);
  await page.goto(APP_URL);
  await page.waitForFunction(() => typeof window.renderAll === 'function' && document.querySelector('.ptab[data-p]'));
  await page.waitForTimeout(300);
  return { page, context, errors, close: () => context.close() };
}

export async function pages(page) {
  return page.$$eval('.ptab[data-p]', els => [...new Set(els.map(e => e.dataset.p))]);
}

export async function goPage(page, p) {
  await page.evaluate(p => window.goPage(p), p);
  await page.waitForTimeout(250);
}
