import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const shots = process.env.SHOT_DIR ?? '/tmp/ui';

let base = process.env.BASE_URL ?? 'http://127.0.0.1:4310';

export function setBase(url) {
  base = url;
}

export async function withPage(fn) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Resource errors are expected (the UI deliberately exercises HTTP 409/503
  // responses); only uncaught page errors should fail a test.
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !text.startsWith('Failed to load resource')) errors.push(`console: ${text}`);
  });
  try {
    await fn(page, errors);
  } finally {
    await browser.close();
  }
}

export async function boot(page) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#field-rows tr');
  await page.waitForFunction(() => document.querySelectorAll('.source-card').length === 3);
}

export { shot };

async function shot(page, name) {
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}
