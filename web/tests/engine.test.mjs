// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, ConvertError, detectKind, normalizeOptions } from '../public/engine/build.js';
import { writeZip, readZip, crc32 } from '../public/engine/zip.js';
import { validatePackage } from '../public/engine/validate.js';
import { fitsServer, MB } from '../public/engine/limits.js';
import { POST } from '../api/convert.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const enc = new TextEncoder();
const f = (name, data) => ({ name, data: typeof data === 'string' ? enc.encode(data) : data });

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
});

test('zip round trip, stored and deflated', async () => {
  const big = 'x'.repeat(5000);
  const z = await writeZip([{ name: 'a/b.txt', data: big }, { name: 'v.mp4', data: new Uint8Array([1, 2, 3]) }]);
  const out = await readZip(z);
  assert.deepEqual(out.map(e => e.name), ['a/b.txt', 'v.mp4']);
  assert.equal(new TextDecoder().decode(out[0].data), big);
  assert.ok(z.length < 1000, 'text is deflated');
});

test('readZip refuses zip bombs and too many entries', async () => {
  const z = await writeZip([{ name: 'big.txt', data: 'a'.repeat(200000) }]);
  await assert.rejects(readZip(z, { maxTotal: 1000 }), /expands/);
  const many = await writeZip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, data: 'x' })));
  await assert.rejects(readZip(many, { maxEntries: 10 }), /entries/);
});

for (const [kind, file] of [
  ['video', f('Intro Clip.mp4', new Uint8Array(2000))],
  ['audio', f('talk.mp3', new Uint8Array(300))],
  ['pdf', f('Policy.pdf', '%PDF-1.4')],
  ['html', f('page.html', '<html><head><title>Fire &amp; Safety</title></head><body>Hi</body></html>')],
]) {
  test(`${kind}: both versions pass, manifest at root, schema only in 2004`, async () => {
    const r = await convert({ kind, file, options: { courseName: 'educateU Safety' } });
    assert.equal(r.packages.length, 2);
    for (const p of r.packages) {
      assert.equal(p.validation.fail, 0, JSON.stringify(p.validation.items));
      const entries = await readZip(p.bytes);
      assert.equal(entries[0].name, 'imsmanifest.xml');
      assert.ok(entries.some(e => e.name === 'res/index.html'));
      assert.equal(entries.some(e => e.name === 'adlcp_v1p3.xsd'), p.version === '2004');
      assert.match(p.filename, /^educateU-Safety-/);
      const html = new TextDecoder().decode(entries.find(e => e.name === 'res/index.html').data);
      assert.ok(!html.includes('\u2014'));
    }
    if (kind === 'html') assert.equal(r.title, 'Fire & Safety');
    const bundle = await readZip(r.bundle.bytes);
    assert.deepEqual(bundle.map(e => e.name).sort(), ['README.txt', 'SCORM-1.2/' + r.packages[1].filename, 'SCORM-2004/' + r.packages[0].filename, 'SCORM-Validation-Report.md'].sort());
  });
}

test('html zip site: strips wrapper folder, keeps assets, refuses ambiguous entry', async () => {
  const site = await writeZip([{ name: 'site/index.html', data: '<html><head><title>S</title></head><body><img src="img/a.png"></body></html>' },
    { name: 'site/img/a.png', data: new Uint8Array(10) }, { name: '__MACOSX/site/._x', data: 'x' }, { name: 'site/imsmanifest.xml', data: '<old/>' }]);
  const r = await convert({ kind: 'html', file: f('site.zip', site), options: { versions: ['1.2'] } });
  const names = (await readZip(r.packages[0].bytes)).map(e => e.name);
  assert.ok(names.includes('res/img/a.png'));
  assert.ok(!names.some(n => n.includes('MACOSX') || n === 'res/imsmanifest.xml'));
  const two = await writeZip([{ name: 'a.html', data: 'a' }, { name: 'b.html', data: 'b' }]);
  await assert.rejects(convert({ kind: 'html', file: f('two.zip', two) }), /index\.html/);
});

test('html wrapper injection is idempotent and auto-complete only when unwired', async () => {
  const r1 = await convert({ kind: 'html', file: f('p.html', '<html><head><title>P</title></head><body></body></html>'), options: { versions: ['2004'] } });
  const html1 = new TextDecoder().decode((await readZip(r1.packages[0].bytes)).find(e => e.name === 'res/index.html').data);
  assert.match(html1, /addEventListener\("load"/);
  const r2 = await convert({ kind: 'html', file: f('p.html', html1), options: { versions: ['2004'] } });
  const html2 = new TextDecoder().decode((await readZip(r2.packages[0].bytes)).find(e => e.name === 'res/index.html').data);
  assert.equal(html2.split('id="scorm-wrapper"').length - 1, 1);
});

test('external Google Font is rejected by validation', async () => {
  const r = await convert({ kind: 'html', file: f('g.html', '<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head><body></body></html>') });
  assert.ok(r.packages.every(p => p.validation.fail > 0));
});

test('input checks: wrong extension, empty file, bad captions', async () => {
  await assert.rejects(convert({ kind: 'video', file: f('x.pdf', 'x') }), ConvertError);
  await assert.rejects(convert({ kind: 'pdf', file: f('x.pdf', new Uint8Array(0)) }), /empty/);
  await assert.rejects(convert({ kind: 'video', file: f('v.mp4', 'x'), captions: f('c.srt', 'x') }), /WebVTT/);
  assert.equal(detectKind('A.MP4'), 'video');
  assert.equal(detectKind('x.docx'), null);
});

test('options are sanitised', () => {
  const o = normalizeOptions({ versions: ['9', '1.2', '1.2'], threshold: 7, lang: '"><script>', pdfComplete: 'x' });
  assert.deepEqual(o.versions, ['1.2']);
  assert.equal(o.threshold, 0.95);
  assert.equal(o.lang, 'en-GB');
  assert.equal(o.pdfComplete, 'button');
});

test('titles are escaped in pages and manifests', async () => {
  const r = await convert({ kind: 'pdf', file: f('a.pdf', '%PDF'), options: { title: '<img src=x onerror=alert(1)> & "q"' } });
  const e = await readZip(r.packages[0].bytes);
  const html = new TextDecoder().decode(e.find(x => x.name === 'res/index.html').data);
  const man = new TextDecoder().decode(e[0].data);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(man.includes('&lt;img src=x onerror=alert(1)&gt; &amp;'));
});

test('validator: 1.2 calls do not satisfy 2004, default org honoured', () => {
  const man = '<?xml version="1.0"?><manifest identifier="x"><metadata><schemaversion>2004 4th Edition</schemaversion></metadata><organizations default="O2"><organization identifier="O1"><item identifier="i" identifierref="R1"/></organization><organization identifier="O2"><item identifier="j" identifierref="R2"/></organization></organizations><resources><resource identifier="R1" adlcp:scormType="sco" href="res/index.html"/><resource identifier="R2" adlcp:scormType="asset" href="res/missing.html"/></resources></manifest>';
  const v = validatePackage([{ name: 'imsmanifest.xml', data: enc.encode(man) }, { name: 'res/index.html', data: enc.encode('LMSInitialize("");LMSCommit("")') }]);
  const fails = v.items.filter(i => i.status === 'FAIL').map(i => i.msg).join(' | ');
  assert.match(fails, /Initialize/);
  assert.match(fails, /Commit/);
  assert.match(fails, /missing|not 'sco'/);
});

test('JS packages also pass the Python validator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scorm-x-'));
  try {
    for (const [kind, file] of [['video', f('v.mp4', new Uint8Array(100))], ['html', f('p.html', '<html><head><title>T</title></head><body></body></html>')]]) {
      const r = await convert({ kind, file });
      for (const p of r.packages) {
        const z = join(dir, p.filename);
        writeFileSync(z, p.bytes);
        const out = execFileSync('python3', ['-I', join(repo, 'scorm_convert.py'), 'validate', z]).toString();
        assert.match(out, /VERDICT: PASSED/, out);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generated assets are in sync with the Python package', () => {
  const assets = readFileSync(join(here, '..', 'public', 'engine', 'assets.js'), 'utf8');
  const wrapper = readFileSync(join(repo, 'scormkit', 'wrapper.js'), 'utf8');
  assert.ok(assets.includes(JSON.stringify(wrapper)), 'run: npm run assets');
});

test('server limit leaves room for the response', () => {
  assert.ok(fitsServer(1.5 * MB, 2));
  assert.ok(!fitsServer(2 * MB, 2));
  assert.ok(fitsServer(3 * MB, 1));
});

// ---------- API ----------
const req = (fields, headers = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request('http://x/api/convert', { method: 'POST', body: fd, headers });
};

test('API converts a PDF and returns a zip with a summary header', async () => {
  const res = await POST(req({ kind: 'pdf', options: '{"courseName":"Demo"}', file: new File(['%PDF-1.4'], 'doc.pdf') }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const summary = JSON.parse(Buffer.from(res.headers.get('x-scorm-result'), 'base64').toString());
  assert.equal(summary.packages.length, 2);
  assert.ok(summary.packages.every(p => p.fail === 0));
  const bundle = await readZip(new Uint8Array(await res.arrayBuffer()));
  assert.ok(bundle.some(e => e.name.startsWith('SCORM-2004/')));
});

test('API rejects bad input with clear JSON errors', async () => {
  const bad = [
    [req({ kind: 'nope', file: new File(['x'], 'a.pdf') }), 400],
    [req({ kind: 'pdf' }), 400],
    [req({ kind: 'video', file: new File(['x'], 'a.pdf') }), 400],
    [req({ kind: 'pdf', options: '{bad', file: new File(['x'], 'a.pdf') }), 400],
    [req({ kind: 'video', file: new File([new Uint8Array(3 * MB)], 'big.mp4') }), 413],
    [new Request('http://x/api/convert', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), 415],
  ];
  for (const [r, status] of bad) {
    const res = await POST(r);
    assert.equal(res.status, status);
    assert.ok((await res.json()).error);
  }
});
