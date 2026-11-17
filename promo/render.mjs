import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';
import path from 'path';
import { writeFileSync } from 'fs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = path.join(dir, 'promo.html');

const targets = [
  { id: 'poster', width: 1080, height: 1920, file: 'poster-1080x1920.png' },
  { id: 'square', width: 1080, height: 1080, file: 'square-1080x1080.png' },
  { id: 'banner', width: 1200, height: 628,  file: 'banner-1200x628.png' },
];

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--font-render-hinting=none',
    '--allow-file-access-from-files',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 2200, deviceScaleFactor: 2 });
  await page.goto('file://' + html, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const imgs = [...document.images];
    await Promise.all(imgs.map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
  });
  await new Promise(r => setTimeout(r, 400));

  for (const t of targets) {
    const el = await page.$(`#${t.id}`);
    if (!el) throw new Error('missing ' + t.id);
    const buf = await el.screenshot({ type: 'png', omitBackground: false });
    writeFileSync(path.join(dir, t.file + '.2x.png'), buf);
    console.log('captured', t.id, buf.length);
  }
} finally {
  await browser.close();
}
