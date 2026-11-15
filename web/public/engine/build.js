// Isomorphic conversion engine: one input file -> SCORM 2004 and/or 1.2 packages.
// Mirrors ../../scormkit/builder.py. Used by api/convert.js (server) and the page (browser).
import { WRAPPER_JS, SCHEMA_2004 } from './assets.js';
import { mediaPage, pdfPage, manifest2004, manifest12, esc } from './templates.js';
import { writeZip, readZip, toBytes } from './zip.js';
import { validatePackage } from './validate.js';

export const KINDS = {
  html: { label: 'HTML', ext: ['.html', '.htm', '.zip'] },
  video: { label: 'Video', ext: ['.mp4', '.m4v', '.webm', '.ogv', '.mov'] },
  audio: { label: 'Audio', ext: ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga'] },
  pdf: { label: 'PDF', ext: ['.pdf'] },
};
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg' };

export class ConvertError extends Error {}

export const extOf = n => { const m = /\.[^./\\]+$/.exec(n); return m ? m[0].toLowerCase() : ''; };
export const slugify = (s, sep = '-') => String(s).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, sep)
  .replace(new RegExp(`^\\${sep}+|\\${sep}+$`, 'g'), '').toLowerCase().slice(0, 60).replace(new RegExp(`\\${sep}+$`), '') || 'module';
const safeName = n => slugify(n.replace(/\.[^.]+$/, '')) + extOf(n);
const prettyName = n => n.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()) || 'Module';
const dec = new TextDecoder();

export function detectKind(name) {
  const e = extOf(name);
  return Object.keys(KINDS).find(k => KINDS[k].ext.includes(e)) || null;
}

export function normalizeOptions(o = {}) {
  const versions = Array.isArray(o.versions) ? o.versions.filter(v => v === '2004' || v === '1.2') : ['2004', '1.2'];
  const threshold = Number(o.threshold ?? 0.95);
  return {
    courseName: String(o.courseName || 'Course').slice(0, 80),
    title: o.title ? String(o.title).slice(0, 200) : '',
    versions: versions.length ? [...new Set(versions)] : ['2004', '1.2'],
    testBuild: !!o.testBuild,
    threshold: threshold > 0 && threshold <= 1 ? threshold : 0.95,
    noSkip: !!o.noSkip,
    pdfComplete: o.pdfComplete === 'open' ? 'open' : 'button',
    htmlComplete: ['auto', 'load', 'manual', 'none'].includes(o.htmlComplete) ? o.htmlComplete : 'auto',
    lang: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(o.lang || '') ? o.lang : 'en-GB',
  };
}

// ---------- HTML ----------
const AUTO_LOAD = '<script>window.addEventListener("load",function(){if(window.scormComplete)window.scormComplete();});</script>';
const MANUAL_BTN = '<button type="button" id="scorm-mark-complete" style="position:fixed;right:16px;bottom:16px;z-index:9999;border:0;border-radius:999px;padding:12px 20px;min-height:44px;font:600 15px system-ui,sans-serif;background:#0b6bcb;color:#fff;cursor:pointer" onclick="if(window.scormComplete)window.scormComplete();this.disabled=true;this.textContent=\'Completed\'">Mark as complete</button>';
const TEST_NOTE = '<div role="note" style="position:fixed;left:12px;bottom:12px;z-index:9999;background:#b3261e;color:#fff;font:700 12px system-ui,sans-serif;padding:6px 12px;border-radius:999px;pointer-events:none">TEST BUILD - timing disabled</div>';
const WRAP_RE = /<script id="scorm-wrapper">[\s\S]*?<\/script>\s*/gi;

function injectWrapper(html, title, lang) {
  const tag = `<script id="scorm-wrapper">\n${WRAPPER_JS}\n</script>`;
  html = html.replace(WRAP_RE, '');
  let m = /<head\b[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + '\n' + tag + html.slice(m.index + m[0].length);
  m = /<html\b[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + '\n<head>\n' + tag + '\n</head>' + html.slice(m.index + m[0].length);
  return `<!DOCTYPE html>\n<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>\n${tag}\n</head><body>\n${html}\n</body></html>`;
}
const appendBody = (html, s) => { const i = html.toLowerCase().lastIndexOf('</body>'); return i >= 0 ? html.slice(0, i) + s + '\n' + html.slice(i) : html + '\n' + s; };
const htmlTitle = h => { const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h); return m ? m[1].replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : ''; };

async function stageHtml(file, opt, warnings, limits) {
  let files;
  if (extOf(file.name) === '.zip') {
    const all = await readZip(file.data, limits);
    files = all.filter(f => !f.name.split('/').some(p => p.startsWith('.') || p === '__MACOSX') && !/(^|\/)imsmanifest\.xml$/i.test(f.name));
    if (files.some(f => f.name.includes('\\') || f.name.startsWith('/') || f.name.split('/').includes('..'))) throw new ConvertError('The zip contains unsafe file paths.');
    const tops = new Set(files.map(f => f.name.split('/')[0]));
    if (tops.size === 1 && files.every(f => f.name.includes('/'))) { const t = [...tops][0] + '/'; files = files.map(f => ({ ...f, name: f.name.slice(t.length) })); }
    if (!files.length) throw new ConvertError('The zip is empty.');
  } else {
    files = [{ name: 'index.html', data: file.data }];
    const src = dec.decode(file.data);
    const rel = [...src.matchAll(/\b(?:src|href)\s*=\s*["'](?!https?:|\/\/|data:|#|mailto:|tel:|javascript:)([^"']+)["']/gi)].map(m => m[1]);
    if (rel.length) warnings.push(`This HTML file refers to ${rel.length} local file(s) (e.g. ${rel[0]}) that were not uploaded. Upload the whole site as a .zip to include them.`);
  }
  let entry = files.find(f => /^index\.html?$/i.test(f.name));
  if (!entry) {
    const roots = files.filter(f => /^[^/]+\.html?$/i.test(f.name));
    if (roots.length === 1) entry = roots[0];
    else throw new ConvertError(roots.length ? `Several HTML pages found (${roots.slice(0, 4).map(r => r.name).join(', ')}). Name the start page index.html.` : 'No HTML page found at the top of the zip. Include an index.html.');
  }
  let html = dec.decode(entry.data);
  const title = opt.title || htmlTitle(html) || prettyName(file.name);
  const wired = /scormComplete|scormFinishReturn/.test(html.replace(WRAP_RE, ''));
  let mode = opt.htmlComplete;
  if (mode === 'auto') {
    mode = wired ? 'none' : 'load';
    if (!wired) warnings.push('This HTML does not call scormComplete(), so completion is recorded when the page opens. Choose "Learner clicks Mark as complete" to require an action instead.');
  }
  html = injectWrapper(html, title, opt.lang);
  if (mode === 'load') html = appendBody(html, AUTO_LOAD);
  if (mode === 'manual') html = appendBody(html, MANUAL_BTN);
  if (opt.testBuild) {
    html = appendBody(html, TEST_NOTE);
    warnings.push('Test build: banner added. Timers written inside your own HTML are not removed automatically.');
  }
  entry.data = toBytes(html);
  return { title, entry: entry.name, files };
}

// ---------- media / PDF ----------
function stageMedia(kind, file, captions, opt, warnings) {
  const name = safeName(file.name);
  const title = opt.title || prettyName(file.name);
  const files = [{ name, data: file.data }];
  let cap = null;
  if (captions && kind === 'video') {
    if (extOf(captions.name) !== '.vtt') throw new ConvertError('Captions must be a WebVTT (.vtt) file.');
    cap = safeName(captions.name);
    if (cap === name) cap = 'captions.vtt';
    files.push({ name: cap, data: captions.data });
  } else if (kind === 'video') warnings.push('No captions file was added. Captions are needed for deaf and hard-of-hearing learners.');
  if (extOf(file.name) === '.mov') warnings.push('.mov files only play in Safari. Convert to .mp4 (H.264) for all browsers.');
  const html = mediaPage({ kind, title, lang: opt.lang, filename: name, mime: MIME[extOf(file.name)], threshold: opt.threshold,
    noSkip: opt.noSkip && !opt.testBuild, testBuild: opt.testBuild, captions: cap, pill: opt.courseName });
  files.push({ name: 'index.html', data: toBytes(html) });
  return { title, entry: 'index.html', files };
}

function stagePdf(file, opt, warnings) {
  const name = safeName(file.name);
  const title = opt.title || prettyName(file.name);
  warnings.push(`Reading progress inside a PDF cannot be tracked; completion is recorded ${opt.pdfComplete === 'open' ? 'when the learner opens it' : 'when the learner clicks Mark as complete'}.`);
  const html = pdfPage({ title, lang: opt.lang, filename: name, mode: opt.pdfComplete, testBuild: opt.testBuild, pill: opt.courseName });
  return { title, entry: 'index.html', files: [{ name, data: file.data }, { name: 'index.html', data: toBytes(html) }] };
}

// ---------- main ----------
/**
 * convert({ kind, file: {name, data}, captions?: {name, data}, options, limits?, onStep? })
 * -> { title, kind, warnings, packages: [{version, filename, bytes, validation}], bundle: {filename, bytes}, report }
 */
export async function convert({ kind, file, captions = null, options = {}, limits = {}, onStep = () => {} }) {
  if (!KINDS[kind]) throw new ConvertError(`Unknown file type "${kind}".`);
  if (!file || !file.data || !file.data.length) throw new ConvertError('The file is empty.');
  if (!KINDS[kind].ext.includes(extOf(file.name))) throw new ConvertError(`${file.name} is not a supported ${KINDS[kind].label} file (${KINDS[kind].ext.join(', ')}).`);
  const opt = normalizeOptions(options);
  const warnings = [];
  onStep('stage');
  const staged = kind === 'html' ? await stageHtml(file, opt, warnings, limits)
    : kind === 'pdf' ? stagePdf(file, opt, warnings) : stageMedia(kind, file, captions, opt, warnings);

  const files = staged.files.map(f => ({ name: 'res/' + f.name, data: toBytes(f.data) })).sort((a, b) => a.name.localeCompare(b.name));
  const href = 'res/' + staged.entry;
  const course = opt.courseName.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'Course';
  const base = `${course}-${slugify(staged.title)}`;
  const ident = `${slugify(opt.courseName, '_')}_${slugify(staged.title, '_')}`.slice(0, 80);
  const packages = [];
  for (const ver of opt.versions) {
    onStep('package', ver);
    const list = files.map(f => f.name);
    const manifest = ver === '2004' ? manifest2004(ident + '_2004', staged.title, href, list) : manifest12(ident + '_12', staged.title, href, list);
    const entries = [{ name: 'imsmanifest.xml', data: toBytes(manifest) }, ...files];
    if (ver === '2004') for (const [p, t] of Object.entries(SCHEMA_2004)) entries.push({ name: p, data: toBytes(t) });
    const bytes = await writeZip(entries);
    onStep('validate', ver);
    const validation = validatePackage(entries, { sizeBytes: bytes.length });
    packages.push({ version: ver, filename: `${base}-SCORM-${ver}.zip`, bytes, validation, fileCount: entries.length });
  }
  onStep('bundle');
  const report = buildReport(staged.title, kind, opt, packages, warnings);
  const readme = `${staged.title}: SCORM delivery bundle\n\nUpload ONE package per LMS activity. Do not upload this bundle.\nUse SCORM-1.2 if you are not sure what your LMS supports.\n\n` +
    packages.map(p => `  SCORM-${p.version}/${p.filename}  [${p.validation.verdict}]`).join('\n') + '\n';
  const bundle = await writeZip([{ name: 'README.txt', data: readme }, { name: 'SCORM-Validation-Report.md', data: report },
    ...packages.map(p => ({ name: `SCORM-${p.version}/${p.filename}`, data: p.bytes }))]);
  onStep('done');
  return { title: staged.title, kind, warnings, packages, report, bundle: { filename: `${base}-SCORM-bundle.zip`, bytes: bundle } };
}

function buildReport(title, kind, opt, packages, warnings) {
  const failed = packages.some(p => p.validation.fail);
  const lines = ['# SCORM Validation Report', '', `Module: ${title} (${KINDS[kind].label})`, `Generated: ${new Date().toISOString()}`, '', '```',
    `Version:                 ${opt.versions.map(v => 'SCORM ' + v).join(' + ')}`,
    `Build Type:              ${opt.testBuild ? 'Test' : 'Final'}`,
    `Timing:                  ${opt.testBuild ? 'Disabled (test build)' : 'Per source content'}`,
    'Responsive Validation:   NOT RUN - check at ~390 / 768 / 1280 px',
    `Structure + API scan:    ${failed ? 'FAILED' : 'Passed'}`,
    'Completion Tracking:     NOT RUN - confirm with one LMS test upload',
    'Progress Tracking:       NOT RUN - confirm with one LMS test upload',
    'Suspend/Resume:          NOT RUN - confirm with one LMS test upload',
    'Scoring:                 N/A - status-based',
    'Accessibility:           NOT RUN - keyboard / screen reader pass needed', '```', '', '## Checks', ''];
  for (const p of packages) {
    lines.push(`### ${p.filename}: ${p.validation.verdict}`, '');
    for (const i of p.validation.items) lines.push(`- [${i.status}] ${i.msg}`);
    lines.push('');
  }
  lines.push('## Warnings', '', ...(warnings.length ? warnings.map(w => `- ${w}`) : ['- none']), '',
    '## Recommendations', '', '- Upload one package to your LMS as a test before rolling it out.');
  return lines.join('\n') + '\n';
}
