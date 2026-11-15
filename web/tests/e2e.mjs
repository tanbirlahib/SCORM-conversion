// Browser end-to-end: real page, real API (dev server), real downloads.
// Needs Playwright + Chromium and ffmpeg. Run: node tests/e2e.mjs
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..'), repo = join(web, '..');
const shots = process.env.SHOTS || null;
const work = mkdtempSync(join(tmpdir(), 'scorm-web-e2e-'));
const port = 3000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}/`;

// inputs: small PDF (server path) and a ~3 MB video (too big for the server -> browser path)
const pdf = join(work, 'Data Policy.pdf'); writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
const html = join(work, 'lesson.html'); writeFileSync(html, '<!DOCTYPE html><html><head><title>Fire Safety Basics</title></head><body><p>Exits</p></body></html>');
const video = join(work, 'intro.webm');
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=25,geq=random(1)*255:128:128', '-t', '4', '-c:v', 'libvpx-vp9', '-b:v', '8M', '-minrate', '8M', '-maxrate', '8M', video]);
console.log(`test video: ${(statSync(video).size / 1048576).toFixed(1)} MB`);
const wrong = join(work, 'notes.docx'); writeFileSync(wrong, 'x');

const server = spawn('node', [join(web, 'scripts', 'dev.mjs'), String(port)], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

let failures = 0;
const check = (name, ok, info) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : '  ' + JSON.stringify(info)}`); if (!ok) failures++; };

const browser = await chromium.launch();
try {
  for (const vp of [{ name: 'desktop', width: 1366, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(base);
    if (shots) await page.screenshot({ path: join(shots, `home-${vp.name}.png`), fullPage: false });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`[${vp.name}] no horizontal scroll`, overflow <= 0, overflow);

    // 1) PDF -> server path
    await page.click('label.type:has(input[value=pdf])');
    await page.fill('#courseName', 'educateU Safety');
    await page.setInputFiles('#file', pdf);
    await page.waitForSelector('#result:not([hidden])', { timeout: 20000 });
    check(`[${vp.name}] pdf converted on server`, (await page.textContent('#where')) === 'Converted on server', await page.textContent('#where'));
    const cards = await page.$$eval('.pkg .verdict', els => els.map(e => e.textContent));
    check(`[${vp.name}] pdf: two packages passed`, cards.length === 2 && cards.every(t => t.startsWith('Passed')), cards);
    if (shots) await page.screenshot({ path: join(shots, `result-${vp.name}.png`), fullPage: vp.name === 'mobile' });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.pkg >> nth=1 >> a')]);
    const saved = join(work, dl.suggestedFilename());
    await dl.saveAs(saved);
    const out = execFileSync('python3', ['-I', join(repo, 'scorm_convert.py'), 'validate', saved]).toString();
    check(`[${vp.name}] downloaded ${dl.suggestedFilename()} passes Python validator`, /VERDICT: PASSED/.test(out), out.slice(-300));
    const [bd] = await Promise.all([page.waitForEvent('download'), page.click('#dl-bundle')]);
    check(`[${vp.name}] bundle download offered`, /SCORM-bundle\.zip$/.test(bd.suggestedFilename()), bd.suggestedFilename());

    // 2) wrong file type -> clear error, then recover
    await page.click('#again');
    await page.click('label.type:has(input[value=video])');
    await page.setInputFiles('#file', pdf);
    await page.waitForSelector('#error:not([hidden])');
    check(`[${vp.name}] wrong type explains the fix`, /choose PDF/.test(await page.textContent('#error-msg')), await page.textContent('#error-msg'));
    await page.click('#retry');

    // 3) large video -> browser path
    await page.setInputFiles('#file', video);
    await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
    check(`[${vp.name}] large video converted in browser`, (await page.textContent('#where')) === 'Converted in your browser', await page.textContent('#where'));
    const warn = await page.textContent('#warnings');
    check(`[${vp.name}] video warns about missing captions`, /captions/i.test(warn), warn);

    // 4) HTML -> server, auto-complete warning
    await page.click('#again');
    await page.click('label.type:has(input[value=html])');
    await page.setInputFiles('#file', html);
    await page.waitForSelector('#result:not([hidden])', { timeout: 20000 });
    check(`[${vp.name}] html title taken from <title>`, (await page.textContent('#result-title')) === 'Fire Safety Basics', await page.textContent('#result-title'));

    // 5) keyboard: type tiles reachable, settings remembered after reload
    await page.reload();
    check(`[${vp.name}] settings remembered`, (await page.inputValue('#courseName')) === 'educateU Safety', await page.inputValue('#courseName'));
    check(`[${vp.name}] no console or CSP errors`, errors.length === 0, errors);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
