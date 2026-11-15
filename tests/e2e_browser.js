// End-to-end: build real packages, open them in Chromium inside a mock LMS frame,
// and check completion, progress, resume, console errors and mobile overflow.
// Needs: python3, ffmpeg, Node + Playwright (require('playwright')).
// Run: node tests/e2e_browser.js
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const ROOT = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scorm-e2e-'));
const inp = path.join(work, 'in'), out = path.join(work, 'out'), site = path.join(work, 'site');
fs.mkdirSync(inp); fs.mkdirSync(site);

function sh(cmd, args) { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }

// --- inputs (webm: open codecs, always playable in Chromium builds) ---
sh('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-f', 'lavfi',
  '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-c:a', 'libopus', '-shortest',
  path.join(inp, 'safety-video.webm')]);
sh('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '3', '-c:a', 'libopus',
  path.join(inp, 'briefing.ogg')]);
fs.writeFileSync(path.join(inp, 'policy.pdf'), '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
fs.writeFileSync(path.join(inp, 'page.html'), '<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><title>Plain Page</title></head><body><p>Hello</p></body></html>');
sh('python3', [path.join(ROOT, 'scorm_convert.py'), 'build', ...['safety-video.webm', 'briefing.ogg', 'policy.pdf', 'page.html'].map(f => path.join(inp, f)),
  '--out', out, '--prefix', 'E2E', '--video-threshold', '0.9', '--no-master']);

// --- unzip each package under site/<name>/ and add an LMS harness page ---
const HARNESS = ver => `<!DOCTYPE html><html><head><meta charset="utf-8"><script>
window.__data = JSON.parse(sessionStorage.getItem('lms') || '{}'); window.__calls = [];
function rec(n, f){ return function(){ window.__calls.push([n].concat([].slice.call(arguments))); return f.apply(null, arguments); }; }
function get(k){ return window.__data[k] == null ? '' : String(window.__data[k]); }
function set(k,v){ window.__data[k] = String(v); return 'true'; }
function persist(){ sessionStorage.setItem('lms', JSON.stringify(window.__data)); return 'true'; }
${ver === '2004'
    ? "window.API_1484_11={Initialize:rec('Initialize',()=>'true'),GetValue:rec('GetValue',get),SetValue:rec('SetValue',set),Commit:rec('Commit',persist),Terminate:rec('Terminate',persist),GetLastError:()=> '0',GetErrorString:()=>'',GetDiagnostic:()=>''};"
    : "window.API={LMSInitialize:rec('LMSInitialize',()=>'true'),LMSGetValue:rec('LMSGetValue',get),LMSSetValue:rec('LMSSetValue',set),LMSCommit:rec('LMSCommit',persist),LMSFinish:rec('LMSFinish',persist),LMSGetLastError:()=> '0',LMSGetErrorString:()=>'',LMSGetDiagnostic:()=>''};"}
</script><style>html,body,iframe{margin:0;border:0;width:100%;height:100%}</style></head>
<body><iframe id="sco" src="res/index.html"></iframe></body></html>`;

const pkgs = {};
for (const dir of ['SCORM-2004', 'SCORM-1.2']) {
  for (const f of fs.readdirSync(path.join(out, dir))) {
    const name = f.replace(/\.zip$/, ''), dest = path.join(site, name);
    sh('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', path.join(out, dir, f), dest]);
    fs.writeFileSync(path.join(dest, 'lms.html'), HARNESS(dir === 'SCORM-2004' ? '2004' : '1.2'));
    pkgs[name] = name;
  }
}
const find = (part, ver) => Object.keys(pkgs).find(n => n.includes(part) && n.endsWith(ver));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.pdf': 'application/pdf', '.vtt': 'text/vtt' };
const server = http.createServer((req, res) => {
  const p = path.join(site, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(site) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  const data = fs.readFileSync(p), type = MIME[path.extname(p)] || 'application/octet-stream';
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const s = range[1] ? +range[1] : 0, e = range[2] ? +range[2] : data.length - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${data.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1 });
    return res.end(data.subarray(s, e + 1));
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': data.length }); res.end(data);
});

let failures = 0;
function check(name, cond, info) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  ' + JSON.stringify(info)}`); if (!cond) failures++; }

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  async function open(ctx, pkg) {
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(base + pkg + '/lms.html');
    const frame = page.frame({ url: /res\/index\.html/ });
    await frame.waitForLoadState('load');
    return { page, frame, errors, data: () => page.evaluate(() => window.__data), calls: () => page.evaluate(() => window.__calls) };
  }

  for (const ver of ['2004', '1.2']) {
    const ST = ver === '2004' ? 'cmi.completion_status' : 'cmi.core.lesson_status';
    // ---- video: play to the end -> completed; reload -> resume dialog ----
    {
      const ctx = await browser.newContext();
      const s = await open(ctx, find('safety-video', ver));
      check(`[${ver}] video: status incomplete on launch`, (await s.data())[ST] === 'incomplete', await s.data());
      await s.frame.evaluate(() => { const v = document.getElementById('media'); v.muted = true; v.playbackRate = 2; return v.play(); });
      await s.frame.waitForFunction(() => document.getElementById('media').ended, null, { timeout: 20000 });
      await s.page.waitForTimeout(300);
      const d = await s.data();
      check(`[${ver}] video: completed after watching`, d[ST] === 'completed', d);
      if (ver === '2004') check(`[2004] video: progress_measure = 1`, Number(d['cmi.progress_measure']) === 1, d);
      else check(`[1.2] video: score.raw carries 100% progress`, d['cmi.core.score.raw'] === '100', d);
      check(`[${ver}] video: no console errors`, s.errors.length === 0, s.errors);
      // simulate a later session mid-way: saved position 2s+ shows the Welcome back dialog
      await s.page.evaluate(ver => { const d = window.__data; d['cmi.suspend_data'] = JSON.stringify({ t: 3, max: 3 }); sessionStorage.setItem('lms', JSON.stringify(d)); }, ver);
      await s.page.reload();
      const f2 = s.page.frame({ url: /res\/index\.html/ });
      await f2.waitForLoadState('load');
      check(`[${ver}] video: resume dialog on return`, await f2.isVisible('#resume.open'), null);
      await f2.click('#resume-yes');
      await f2.waitForFunction(() => document.getElementById('media').currentTime >= 2.9, null, { timeout: 5000 }).catch(() => {});
      const t = await f2.evaluate(() => document.getElementById('media').currentTime);
      check(`[${ver}] video: Resume seeks to saved position`, t >= 2.9, t);
      await ctx.close();
    }
    // ---- audio: plays and completes ----
    {
      const ctx = await browser.newContext();
      const s = await open(ctx, find('briefing', ver));
      await s.frame.evaluate(() => { const v = document.getElementById('media'); v.muted = true; return v.play(); });
      await s.frame.waitForFunction(() => document.getElementById('media').ended, null, { timeout: 20000 });
      await s.page.waitForTimeout(300);
      check(`[${ver}] audio: completed`, (await s.data())[ST] === 'completed', await s.data());
      await ctx.close();
    }
    // ---- PDF: incomplete until the button, then completed; mobile has no horizontal scroll ----
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const s = await open(ctx, find('policy', ver));
      check(`[${ver}] pdf: incomplete before Mark as complete`, (await s.data())[ST] === 'incomplete', await s.data());
      const over = await s.frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`[${ver}] pdf: no horizontal overflow at 390px`, over <= 0, over);
      await s.frame.click('#done');
      check(`[${ver}] pdf: completed after button`, (await s.data())[ST] === 'completed', await s.data());
      await ctx.close();
    }
    // ---- plain HTML: auto-complete on load; Terminate exactly once on unload ----
    {
      const ctx = await browser.newContext();
      const s = await open(ctx, find('plain-page', ver));
      await s.page.waitForTimeout(200);
      check(`[${ver}] html: completed on load`, (await s.data())[ST] === 'completed', await s.data());
      await s.frame.evaluate(() => window.scormFinishReturn());
      await s.frame.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      const term = (await s.calls()).filter(c => c[0] === (ver === '2004' ? 'Terminate' : 'LMSFinish')).length;
      check(`[${ver}] html: Terminate/LMSFinish called once`, term === 1, term);
      await ctx.close();
    }
  }
  await browser.close();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall browser checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
