// In-memory SCORM package checks (port of ../../scormkit/validate.py).
// Input: [{ name, data: Uint8Array }]. Output: { verdict, items: [{status, msg}] }.
// No XML parser dependency: the manifest is checked with targeted patterns, which is
// enough for packages this engine builds and for typical third-party manifests.

const dec = new TextDecoder();
const text = e => dec.decode(e.data);
const attr = (tag, name) => {
  const m = new RegExp(`\\b(?:[\\w-]+:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3]) : null;
};

export function validatePackage(entries, { sizeBytes } = {}) {
  const items = [];
  const add = (status, msg) => items.push({ status, msg });
  const names = entries.map(e => e.name);
  const byName = new Map(entries.map(e => [e.name, e]));

  if (sizeBytes != null) add(sizeBytes <= 500 * 1048576 ? 'PASS' : 'FAIL', `Zip is ${(sizeBytes / 1048576).toFixed(1)} MB (limit 500 MB)`);
  const bad = names.filter(n => n.includes('\\'));
  if (bad.length) add('FAIL', `${bad.length} zip entries use backslash separators (e.g. ${bad[0]})`);
  const unsafe = names.filter(n => n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..'));
  if (unsafe.length) { add('FAIL', `unsafe zip paths: ${unsafe.slice(0, 3).join(', ')}`); return finish(items); }

  const man = byName.get('imsmanifest.xml');
  if (!man) {
    const nested = names.find(n => n.endsWith('/imsmanifest.xml'));
    add('FAIL', nested ? `imsmanifest.xml is not at the zip root (found ${nested}). Zip the contents, not the folder.` : 'No imsmanifest.xml in the package');
    return finish(items);
  }
  add('PASS', 'imsmanifest.xml found at package root');
  const raw = text(man);
  if (/<!(DOCTYPE|ENTITY)/i.test(raw)) { add('FAIL', 'manifest contains a DOCTYPE/ENTITY declaration'); return finish(items); }
  if (!/<manifest\b[\s\S]*<\/manifest>\s*$/.test(raw.trim())) add('FAIL', 'manifest is not a complete <manifest> document');
  if (/\{\{[^}]*\}\}/.test(raw)) add('FAIL', 'manifest still contains template placeholders');

  const sv = (/<(?:\w+:)?schemaversion>\s*([^<]*)</i.exec(raw) || [])[1]?.trim() || '';
  const ver = /2004|CAM 1\.3/.test(sv) || raw.includes('adlcp_v1p3') ? '2004' : '1.2';
  add('PASS', `Detected SCORM ${ver}${sv ? ` (schemaversion '${sv}')` : ''}`);

  // default organization -> first item with identifierref -> resource href
  const orgsTag = (/<(?:\w+:)?organizations\b[^>]*>/i.exec(raw) || [''])[0];
  const def = attr(orgsTag, 'default');
  const orgRe = /<(?:\w+:)?organization\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?organization>/gi;
  const orgs = [...raw.matchAll(orgRe)].map(m => ({ id: attr(m[1], 'identifier'), body: m[2] }));
  const resources = new Map([...raw.matchAll(/<(?:\w+:)?resource\b([^>]*?)\/?>/gi)].map(m => [attr(m[1], 'identifier'), m[1]]));
  let href = null;
  if (!orgs.length) add('FAIL', 'no <organization>');
  else {
    let org = orgs.find(o => o.id === def);
    if (def && !org) add('FAIL', `organizations default='${def}' matches no <organization>`);
    org = org || orgs[0];
    const item = /<(?:\w+:)?item\b[^>]*\bidentifierref\s*=\s*["']([^"']+)["']/i.exec(org.body);
    if (!item) add('FAIL', 'default organization has no <item> with identifierref');
    else {
      const res = resources.get(item[1]);
      if (!res) add('FAIL', `identifierref '${item[1]}' matches no <resource>`);
      else {
        href = attr(res, 'href');
        if (!href) add('FAIL', `resource '${item[1]}' has no href`);
        else {
          add('PASS', `Launch file: ${href}`);
          const p = href.split(/[?#]/)[0];
          add(byName.has(p) ? 'PASS' : 'FAIL', byName.has(p) ? 'Launch file exists in package' : `launch file ${href} is missing`);
        }
        const st = (attr(res, 'scormtype') || '').toLowerCase();
        if (st && st !== 'sco') add('FAIL', `launch resource is scormtype='${st}', not 'sco'`);
      }
    }
  }
  const missing = [...raw.matchAll(/<(?:\w+:)?file\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]).filter(f => !byName.has(f));
  if (missing.length) add('WARN', `${missing.length} <file> entries listed in the manifest are not in the package`);
  const sco = [...resources.values()].filter(r => (attr(r, 'scormtype') || '').toLowerCase() === 'sco').length;
  add(sco === 1 ? 'PASS' : sco === 0 ? 'WARN' : 'FAIL', sco === 1 ? 'Exactly one SCO' : sco === 0 ? 'no resource marked as SCO' : `${sco} SCOs found (one per package required)`);

  const code = entries.filter(e => /\.(html?|js)$/i.test(e.name)).map(text).join('\n');
  const has = (re, label, sev = 'FAIL') => add(re.test(code) ? 'PASS' : sev, `${label}${re.test(code) ? '' : ' not found'}`);
  if (ver === '2004') {
    has(/\bInitialize\s*\(/, 'Initialize()');
    has(/cmi\.completion_status/, 'Sets cmi.completion_status');
    has(/cmi\.progress_measure/, 'Sets cmi.progress_measure', 'WARN');
    has(/cmi\.score\.scaled/, 'Sets cmi.score.scaled', 'WARN');
    has(/\bCommit\s*\(/, 'Commit()');
    has(/\bTerminate\s*\(/, 'Terminate()');
    has(/API_1484_11/, 'Finds API_1484_11');
    has(/cmi\.(location|suspend_data)/, 'Bookmarking (resume)', 'WARN');
  } else {
    has(/\bLMSInitialize\s*\(/, 'LMSInitialize()');
    has(/cmi\.core\.lesson_status/, 'Sets cmi.core.lesson_status');
    has(/cmi\.core\.score\.raw/, 'Sets cmi.core.score.raw (progress)', 'WARN');
    has(/\bLMSCommit\s*\(/, 'LMSCommit()');
    has(/\bLMSFinish\s*\(/, 'LMSFinish()');
    has(/(cmi\.core\.lesson_location|cmi\.suspend_data)/, 'Bookmarking (resume)', 'WARN');
  }

  const url = String.raw`((?:https?:)?\/\/[^\s"'<>)]+)`;
  const pats = [String.raw`\b(?:src|poster|data)\s*=\s*["']?` + url, String.raw`\bsrcset\s*=\s*["'][^"']*?` + url,
    String.raw`<link\b[^>]*\bhref\s*=\s*["']?` + url, String.raw`url\(\s*["']?` + url, String.raw`@import\s+["']` + url].map(p => new RegExp(p, 'gi'));
  const ext = new Set();
  for (const e of entries.filter(e => /\.(html?|js|css|svg)$/i.test(e.name))) {
    const t = text(e);
    for (const re of pats) for (const m of t.matchAll(re)) if (!/^(?:https?:)?\/\/(www\.)?w3\.org\//i.test(m[1])) ext.add(m[1]);
  }
  add(ext.size ? 'FAIL' : 'PASS', ext.size ? `${ext.size} external loaded asset(s): ${[...ext].slice(0, 3).join(', ')}` : 'Self-contained (no CDN or external assets)');
  return finish(items, ver);
}

function finish(items, version = null) {
  const n = s => items.filter(i => i.status === s).length;
  return { version, items, pass: n('PASS'), warn: n('WARN'), fail: n('FAIL'),
    verdict: n('FAIL') ? 'REJECTED' : n('WARN') ? 'PASSED WITH WARNINGS' : 'PASSED' };
}
