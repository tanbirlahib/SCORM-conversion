// Page logic: choose type -> settings -> upload triggers conversion -> download.
// Small files go to the server API; larger ones are converted in the browser with the same engine.
import { convert, KINDS, detectKind, extOf } from './engine/build.js';
import { readZip } from './engine/zip.js';
import { validatePackage } from './engine/validate.js';
import { fitsServer, BROWSER_MAX, ZIP_LIMITS_BROWSER, MB } from './engine/limits.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const form = $('#form'), fileInput = $('#file'), drop = $('#drop');
const PREFS_KEY = 'scorm-converter:prefs';
let urls = [];
let busy = false;

const fmtSize = b => b < 1024 ? `${b} B` : b < MB ? `${(b / 1024).toFixed(0)} KB` : `${(b / MB).toFixed(1)} MB`;
const kind = () => form.elements.kind.value;

// ---------- preferences (per-browser convenience only) ----------
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    for (const [k, v] of Object.entries(p)) {
      const el = form.elements[k];
      if (!el) continue;
      if (el instanceof RadioNodeList) { const r = [...el].find(x => x.value === v); if (r) r.checked = true; }
      else if (el.type === 'checkbox') el.checked = !!v;
      else if (el.type !== 'file') el.value = v;
    }
  } catch { /* storage unavailable: defaults are fine */ }
}
function savePrefs() {
  try {
    const p = {};
    for (const k of ['kind', 'courseName', 'versions', 'build', 'threshold', 'noSkip', 'pdfComplete', 'htmlComplete']) {
      const el = form.elements[k];
      p[k] = el.type === 'checkbox' ? el.checked : el.value;
    }
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch { /* ignore */ }
}

function options() {
  const f = form.elements;
  return {
    courseName: f.courseName.value.trim() || 'Course',
    title: f.title.value.trim(),
    versions: f.versions.value === 'both' ? ['2004', '1.2'] : [f.versions.value],
    testBuild: f.build.value === 'test',
    threshold: Number(f.threshold.value),
    noSkip: f.noSkip.checked,
    pdfComplete: f.pdfComplete.value,
    htmlComplete: f.htmlComplete.value,
    lang: document.documentElement.lang || 'en-GB',
  };
}

function syncKind() {
  const k = kind();
  $$('.kind-opts, .kind-opts [data-for]').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(k); });
  fileInput.accept = KINDS[k].ext.join(',');
  $('#drop-kind').textContent = KINDS[k].label;
  $('#build-hint').textContent = form.elements.build.value === 'test'
    ? 'For reviewers: shows a TEST BUILD banner and never blocks skipping.'
    : 'For learners. No banner.';
}

// ---------- panel states ----------
function show(id) { for (const s of ['idle', 'work', 'result', 'error']) $('#' + s).hidden = s !== id; }
function say(msg) { $('#live').textContent = msg; }
function setStep(step, state) {
  const order = ['upload', 'stage', 'package', 'validate', 'done'];
  const i = order.indexOf(step);
  $$('#progress li').forEach((li, j) => {
    li.classList.toggle('ok', j < i || (j === i && state === 'ok'));
    li.classList.toggle('active', j === i && state !== 'ok');
  });
}
function setBar(pct) {
  const bar = $('#bar');
  bar.firstElementChild.style.width = `${pct}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
}
function addTree(name, size, cls = 'f') {
  const li = document.createElement('li');
  li.className = `${cls} new`;
  li.append(name);
  if (size != null) { const s = document.createElement('span'); s.className = 'size'; s.textContent = fmtSize(size); li.append(s); }
  $('#tree').append(li);
}
function drawTree(file, captions, opts) {
  $('#tree').replaceChildren();
  addTree('imsmanifest.xml');
  addTree('res/', null, 'd');
  addTree('index.html', null, 'f in');
  if (kind() === 'html' && extOf(file.name) === '.zip') addTree(`files from ${file.name}`, file.size, 'f in');
  else if (kind() !== 'html') addTree(file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-'), file.size, 'f in');
  if (captions) addTree(captions.name, captions.size, 'f in');
  if (opts.versions.includes('2004')) addTree('SCORM 2004 schema files (28)');
}
function reset() {
  urls.forEach(u => URL.revokeObjectURL(u));
  urls = [];
  busy = false;
  drop.classList.remove('busy');
  fileInput.value = '';
  $('#where').hidden = true;
  show('idle');
}
function fail(msg) {
  busy = false;
  drop.classList.remove('busy');
  $('#error-msg').textContent = msg;
  show('error');
  say(`Conversion stopped. ${msg}`);
}
const blobUrl = (bytes, type = 'application/zip') => { const u = URL.createObjectURL(new Blob([bytes], { type })); urls.push(u); return u; };

// ---------- conversion paths ----------
function viaServer(file, captions, opts) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('kind', kind());
    fd.append('options', JSON.stringify(opts));
    fd.append('file', file);
    if (captions) fd.append('captions', captions);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/convert');
    xhr.responseType = 'arraybuffer';
    xhr.upload.onprogress = e => { if (e.lengthComputable) setBar((e.loaded / e.total) * 40); };
    xhr.upload.onload = () => { setStep('stage'); setBar(55); };
    xhr.onerror = () => reject(Object.assign(new Error('Could not reach the server.'), { fallback: true }));
    xhr.onload = async () => {
      if (xhr.status !== 200) {
        let body = {};
        try { body = JSON.parse(new TextDecoder().decode(xhr.response)); } catch { /* not JSON */ }
        return reject(Object.assign(new Error(body.error || `Server error ${xhr.status}.`), { fallback: body.fallback === 'browser' || xhr.status >= 500 || xhr.status === 404 }));
      }
      try {
        const summary = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(xhr.getResponseHeader('X-Scorm-Result') || ''), c => c.charCodeAt(0))));
        const bundle = new Uint8Array(xhr.response);
        const entries = await readZip(bundle);
        const packages = [];
        for (const p of summary.packages) {
          const e = entries.find(x => x.name === `SCORM-${p.version}/${p.filename}`);
          if (!e) throw new Error('The server response was incomplete.');
          packages.push({ version: p.version, filename: p.filename, bytes: e.data, validation: validatePackage(await readZip(e.data), { sizeBytes: e.data.length }) });
        }
        resolve({ title: summary.title, warnings: summary.warnings, packages, bundle: { filename: summary.bundle, bytes: bundle }, where: 'server' });
      } catch (err) { reject(err); }
    };
    xhr.send(fd);
  });
}

async function viaBrowser(file, captions, opts) {
  const pct = { stage: 50, package: 65, validate: 85, bundle: 95, done: 100 };
  const read = async f => f ? { name: f.name, data: new Uint8Array(await f.arrayBuffer()) } : null;
  setStep('stage'); setBar(45);
  const result = await convert({
    kind: kind(), file: await read(file), captions: await read(captions), options: opts, limits: ZIP_LIMITS_BROWSER,
    onStep: s => { if (s in pct) { setBar(pct[s]); if (s !== 'bundle' && s !== 'done') setStep(s); } },
  });
  return { ...result, where: 'browser' };
}

async function start(file) {
  if (busy || !file) return;
  const k = kind();
  const detected = detectKind(file.name);
  if (detected !== k) {
    const hint = detected ? ` It looks like a ${KINDS[detected].label} file: choose ${KINDS[detected].label} in step 1.` : '';
    return fail(`${file.name} is not a ${KINDS[k].label} file (${KINDS[k].ext.join(', ')}).${hint}`);
  }
  if (file.size > BROWSER_MAX) return fail(`${file.name} is ${fmtSize(file.size)}. The limit is ${fmtSize(BROWSER_MAX)}.`);
  const captions = k === 'video' && $('#captions').files[0] || null;
  const opts = options();
  savePrefs();
  busy = true;
  drop.classList.add('busy');
  $('#file-name').textContent = file.name;
  $('#file-size').textContent = fmtSize(file.size);
  drawTree(file, captions, opts);
  setStep('upload'); setBar(0);
  show('work');
  say(`Converting ${file.name}.`);

  let result;
  const where = $('#where');
  try {
    if (fitsServer(file.size + (captions?.size || 0), opts.versions.length)) {
      where.textContent = 'Converting on server'; where.hidden = false;
      try { result = await viaServer(file, captions, opts); }
      catch (e) {
        if (!e.fallback) throw e;
        where.textContent = 'Converting in your browser';
        result = await viaBrowser(file, captions, opts);
      }
    } else {
      where.textContent = 'Converting in your browser'; where.hidden = false;
      setStep('upload', 'ok');
      result = await viaBrowser(file, captions, opts);
    }
  } catch (e) {
    return fail(e.message || 'Something went wrong while converting.');
  }
  setStep('done', 'ok'); setBar(100);
  where.textContent = result.where === 'server' ? 'Converted on server' : 'Converted in your browser';
  renderResult(result);
}

function renderResult(r) {
  busy = false;
  drop.classList.remove('busy');
  $('#result-title').textContent = r.title;
  const box = $('#packages');
  box.replaceChildren();
  for (const p of r.packages) {
    const v = p.validation;
    const cls = v.fail ? 'fail' : v.warn ? 'warn' : 'pass';
    const label = v.fail ? 'Failed checks' : v.warn ? 'Passed with warnings' : 'Passed all checks';
    const card = $('#pkg-tpl').content.firstElementChild.cloneNode(true);
    card.querySelector('.verdict').classList.add(cls);
    card.querySelector('.pkg-name').textContent = `SCORM ${p.version}`;
    card.querySelector('.pkg-meta').textContent = `${p.filename}, ${fmtSize(p.bytes.length)}`;
    card.querySelector('.verdict').textContent = label;
    card.querySelector('summary').textContent = `See the ${v.items.length} checks`;
    const ul = card.querySelector('ul');
    for (const it of v.items) { const li = document.createElement('li'); li.className = `st-${it.status}`; li.textContent = `${it.status === 'PASS' ? 'Pass' : it.status === 'WARN' ? 'Warning' : 'Fail'}: ${it.msg}`; ul.append(li); }
    const a = card.querySelector('a');
    a.href = blobUrl(p.bytes);
    a.download = p.filename;
    a.textContent = `Download SCORM ${p.version} package`;
    box.append(card);
  }
  const all = $('#dl-bundle');
  all.href = blobUrl(r.bundle.bytes);
  all.download = r.bundle.filename;
  const w = $('#warnings');
  w.replaceChildren();
  if (r.warnings.length) {
    const h = document.createElement('h4'); h.textContent = 'Worth knowing';
    const ul = document.createElement('ul');
    for (const t of r.warnings) { const li = document.createElement('li'); li.textContent = t; ul.append(li); }
    w.append(h, ul);
  }
  show('result');
  const failed = r.packages.some(p => p.validation.fail);
  say(failed ? 'Conversion finished, but a package failed its checks. See the details.' : 'Your SCORM packages are ready to download.');
  $('#result-title').focus({ preventScroll: true });
  if (window.matchMedia('(max-width: 980px)').matches) $('#panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- wiring ----------
loadPrefs();
syncKind();
form.addEventListener('change', e => { if (e.target.name !== 'file' && e.target.name !== 'captions') { syncKind(); savePrefs(); } });
form.addEventListener('submit', e => e.preventDefault());
fileInput.addEventListener('change', () => start(fileInput.files[0]));
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); if (!busy) drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer?.files?.[0]; if (f) start(f); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());
$('#again').addEventListener('click', () => { reset(); fileInput.focus(); });
$('#retry').addEventListener('click', () => { reset(); fileInput.focus(); });
