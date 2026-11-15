// Learner pages and manifests. Mirrors ../../scormkit/templates.py; the shared
// CSS and player scripts come from there via assets.js (generated).
import { TPL, WRAPPER_JS } from './assets.js';

export const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
export const xesc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const qattr = s => `"${xesc(s).replace(/"/g, '&quot;')}"`;

function page(title, lang, body, script, testBuild, pill) {
  return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<script id="scorm-wrapper">
${WRAPPER_JS}
</script>
<style>${TPL.BASE_CSS}</style>
</head>
<body>
<header class="hdr"><h1>${esc(title)}</h1>${pill ? `<span class="pill">${esc(pill)}</span>` : ''}</header>
<main class="stage">
${body}
</main>
${TPL.RESUME_DIALOG}
${testBuild ? TPL.TEST_BANNER : ''}
<script>
${script}
</script>
</body>
</html>
`;
}

export function mediaPage({ kind, title, lang, filename, mime, threshold, noSkip, testBuild, captions, pill }) {
  const tag = kind === 'video' ? 'video' : 'audio';
  const extra = tag === 'video' ? ' playsinline preload="metadata"' : ' preload="metadata"';
  const track = captions
    ? `<track kind="captions" src="${esc(captions)}" srclang="${esc(lang.split('-')[0])}" label="Captions" default>` : '';
  const body = `<div class="card">
  <${tag} id="media" class="media" controls${extra} aria-label="${esc(title)}">
    <source src="${esc(filename)}" type="${esc(mime)}">${track}
    Your browser cannot play this ${tag}. <a href="${esc(filename)}">Download it</a>.
  </${tag}>
  <div class="bar" id="bar" role="progressbar" aria-label="Viewing progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="fill"></span></div>
  <div class="row"><span class="status" id="status" aria-live="polite"></span>
  <button class="btn secondary" type="button" onclick="window.scormFinishReturn&&window.scormFinishReturn()">Save and exit</button></div>
</div>`;
  const script = TPL.MEDIA_SCRIPT.replace('__THRESHOLD__', String(Number(threshold)))
    .replace('__NOSKIP__', noSkip ? 'true' : 'false');
  return page(title, lang, body, script, testBuild, pill);
}

export function pdfPage({ title, lang, filename, mode, testBuild, pill }) {
  const body = `<div class="card">
  <iframe class="doc" src="${esc(filename)}" title="${esc(title)} (PDF document)"></iframe>
  <div class="row">
    <span class="status" id="status" aria-live="polite">Read the document, then mark it as complete.</span>
    <span class="row" style="margin:0">
      <a class="btn secondary" href="${esc(filename)}" target="_blank" rel="noopener">${TPL.ICON_OPEN} Open in new tab</a>
      <button class="btn" id="done" type="button">${TPL.ICON_CHECK} Mark as complete</button>
    </span>
  </div>
</div>`;
  return page(title, lang, body, TPL.PDF_SCRIPT.replace('__MODE__', mode === 'open' ? 'open' : 'button'), testBuild, pill);
}

const filesXml = files => files.map(f => `      <file href=${qattr(f)}/>`).join('\n');

export function manifest2004(ident, title, href, files) {
  const t = xesc(title);
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier=${qattr(ident)} version="1.0"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:imsss="http://www.imsglobal.org/xsd/imsss"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3"
  xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3" xmlns:lom="http://ltsc.ieee.org/xsd/LOM"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd http://www.adlnet.org/xsd/adlseq_v1p3 adlseq_v1p3.xsd http://www.adlnet.org/xsd/adlnav_v1p3 adlnav_v1p3.xsd http://ltsc.ieee.org/xsd/LOM lom.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 4th Edition</schemaversion>
    <lom:lom><lom:general><lom:title><lom:string>${t}</lom:string></lom:title></lom:general></lom:lom>
  </metadata>
  <organizations default="ORG1">
    <organization identifier="ORG1">
      <title>${t}</title>
      <item identifier="ITEM1" identifierref="RES1">
        <title>${t}</title>
        <imsss:sequencing><imsss:deliveryControls completionSetByContent="true" objectiveSetByContent="true"/></imsss:sequencing>
      </item>
      <imsss:sequencing><imsss:controlMode flow="true"/></imsss:sequencing>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES1" type="webcontent" adlcp:scormType="sco" href=${qattr(href)}>
${filesXml(files)}
    </resource>
  </resources>
</manifest>
`;
}

export function manifest12(ident, title, href, files, mastery = null) {
  const t = xesc(title);
  const ms = mastery != null ? `\n        <adlcp:masteryscore>${Math.round(mastery)}</adlcp:masteryscore>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier=${qattr(ident)} version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG1">
    <organization identifier="ORG1">
      <title>${t}</title>
      <item identifier="ITEM1" identifierref="RES1" isvisible="true">
        <title>${t}</title>${ms}
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES1" type="webcontent" adlcp:scormtype="sco" href=${qattr(href)}>
${filesXml(files)}
    </resource>
  </resources>
</manifest>
`;
}
