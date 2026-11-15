"""HTML page and manifest templates. Everything is self-contained: no CDN,
no web fonts, icons are inline SVG."""
from html import escape
from xml.sax.saxutils import escape as xesc, quoteattr

BASE_CSS = """
:root{--bg:#0f1720;--surface:#ffffff;--ink:#14202b;--muted:#5b6b78;--accent:#0b6bcb;
--accent-ink:#ffffff;--radius:clamp(10px,1.4vw,16px);--gap:clamp(12px,2vw,22px);
--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--ink);font-family:var(--font);display:flex;flex-direction:column;min-height:100vh}
header.hdr{display:flex;align-items:center;justify-content:space-between;gap:var(--gap);padding:clamp(10px,1.6vw,18px) clamp(14px,3vw,32px);color:#fff}
header.hdr h1{font-size:clamp(1rem,2.2vw,1.35rem);margin:0;font-weight:700}
.pill{background:rgba(255,255,255,.14);color:#fff;border-radius:999px;padding:4px 12px;font-size:.8rem;white-space:nowrap}
main.stage{flex:1;display:flex;flex-direction:column;align-items:center;padding:0 clamp(10px,3vw,32px) var(--gap)}
.card{background:var(--surface);border-radius:var(--radius);width:100%;max-width:1200px;padding:var(--gap);box-shadow:0 8px 30px rgba(0,0,0,.25)}
.media{width:100%;max-height:70vh;background:#000;border-radius:calc(var(--radius) - 4px);display:block}
audio.media{background:transparent;max-height:none}
.doc{width:100%;height:72vh;border:0;border-radius:calc(var(--radius) - 4px);background:#e9eef2}
.bar{height:8px;background:#e3e9ee;border-radius:999px;overflow:hidden;margin-top:var(--gap)}
.bar>span{display:block;height:100%;width:0;background:var(--accent);transition:width .3s}
.row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-top:12px}
.status{color:var(--muted);font-size:.95rem}
.btn{appearance:none;border:0;border-radius:999px;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;padding:10px 20px;min-height:44px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;text-decoration:none}
.btn.secondary{background:#e3e9ee;color:var(--ink)}
.btn[disabled]{opacity:.5;cursor:default}
.btn:focus-visible,a:focus-visible{outline:3px solid #ffbf47;outline-offset:2px}
.btn svg{width:18px;height:18px}
.test-banner{position:fixed;left:12px;bottom:12px;z-index:50;background:#b3261e;color:#fff;font-size:.75rem;font-weight:700;letter-spacing:.04em;padding:6px 12px;border-radius:999px;pointer-events:none}
.modal{position:fixed;inset:0;background:rgba(5,10,15,.6);display:none;align-items:center;justify-content:center;padding:16px;z-index:60}
.modal.open{display:flex}
.dialog{background:var(--surface);border-radius:var(--radius);padding:clamp(18px,3vw,28px);max-width:420px;width:100%;text-align:center}
.dialog h2{margin:0 0 8px;font-size:1.25rem}
.dialog p{margin:0 0 18px;color:var(--muted)}
.dialog .row{justify-content:center}
@media (max-width:520px){.doc{height:62vh}.row{flex-direction:column;align-items:stretch}.btn{justify-content:center}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
"""

ICON_CHECK = ('<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" '
              'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" '
              'stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>')
ICON_OPEN = ('<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" '
             'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
             'stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>')

TEST_BANNER = '<div class="test-banner" role="note">TEST BUILD - timing disabled</div>'

RESUME_DIALOG = """<div class="modal" id="resume" role="dialog" aria-modal="true" aria-labelledby="resume-h">
  <div class="dialog">
    <h2 id="resume-h">Welcome back</h2>
    <p>Would you like to resume where you left off?</p>
    <div class="row">
      <button class="btn" id="resume-yes" type="button">Resume</button>
      <button class="btn secondary" id="resume-no" type="button">Start over</button>
    </div>
  </div>
</div>"""


def page(title, lang, body, script, wrapper_js, test_build, pill=""):
    return f"""<!DOCTYPE html>
<html lang="{escape(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{escape(title)}</title>
<script id="scorm-wrapper">
{wrapper_js}
</script>
<style>{BASE_CSS}</style>
</head>
<body>
<header class="hdr"><h1>{escape(title)}</h1>{f'<span class="pill">{escape(pill)}</span>' if pill else ''}</header>
<main class="stage">
{body}
</main>
{RESUME_DIALOG}
{TEST_BANNER if test_build else ''}
<script>
{script}
</script>
</body>
</html>
"""


MEDIA_SCRIPT = r"""
(function(){
  var TH=__THRESHOLD__, NOSKIP=__NOSKIP__;
  var v=document.getElementById('media'), fill=document.getElementById('fill'),
      status=document.getElementById('status'), bar=document.getElementById('bar');
  var maxT=0, last=0, completed=false, lastSave=0;
  function frac(){ return (v.duration && isFinite(v.duration)) ? Math.min(1,maxT/v.duration) : 0; }
  function ui(){
    var p=Math.round(frac()*100);
    fill.style.width=p+'%'; bar.setAttribute('aria-valuenow',p);
    status.textContent = completed ? 'Complete' : ('Watched ' + p + '% (' + Math.round(TH*100) + '% needed to complete)');
  }
  function save(force){
    var now=Date.now(); if(!force && now-lastSave<5000) return; lastSave=now;
    if(window.scormSaveState) window.scormSaveState({t:Math.floor(v.currentTime),max:Math.floor(maxT)}, frac(), Math.floor(v.currentTime));
  }
  function check(){
    if(!completed && v.duration && frac()>=TH-1e-9){ completed=true; if(window.scormComplete) window.scormComplete(); }
    ui();
  }
  v.addEventListener('timeupdate',function(){
    var t=v.currentTime;
    if(!v.seeking && t>last && t-last<2.5 && t>maxT) maxT=t;
    last=t; check(); save(false);
  });
  v.addEventListener('seeking',function(){
    if(NOSKIP && v.currentTime>maxT+1){ v.currentTime=maxT; }
    last=v.currentTime;
  });
  v.addEventListener('ended',function(){ maxT=v.duration||maxT; check(); save(true); });
  v.addEventListener('pause',function(){ save(true); });
  v.addEventListener('loadedmetadata',ui);
  window.addEventListener('pagehide',function(){ save(true); });

  var st=window.scormGetState ? window.scormGetState() : null;
  if(st && typeof st.max==='number'){ maxT=st.max; }
  if(st && typeof st.t==='number' && st.t>2){
    var m=document.getElementById('resume'), yes=document.getElementById('resume-yes'), no=document.getElementById('resume-no');
    m.classList.add('open'); yes.focus();
    function seek(t){ if(v.readyState>=1){ v.currentTime=t; last=t; } else v.addEventListener('loadedmetadata',function(){ v.currentTime=t; last=t; },{once:true}); }
    yes.onclick=function(){ m.classList.remove('open'); seek(st.t); v.focus(); };
    no.onclick=function(){ m.classList.remove('open'); seek(0); v.focus(); };
    m.addEventListener('keydown',function(e){ if(e.key==='Escape') no.onclick(); });
  }
  ui();
})();
"""


def media_page(kind, title, lang, filename, mime, wrapper_js, threshold, noskip,
               test_build, captions=None, pill=""):
    track = ""
    if captions:
        track = (f'<track kind="captions" src="{escape(captions)}" srclang="{escape(lang.split("-")[0])}" '
                 f'label="Captions" default>')
    tag = "video" if kind == "video" else "audio"
    extra = ' playsinline preload="metadata"' if tag == "video" else ' preload="metadata"'
    body = f"""<div class="card">
  <{tag} id="media" class="media" controls{extra} aria-label="{escape(title)}">
    <source src="{escape(filename)}" type="{escape(mime)}">{track}
    Your browser cannot play this {tag}. <a href="{escape(filename)}">Download it</a>.
  </{tag}>
  <div class="bar" id="bar" role="progressbar" aria-label="Viewing progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="fill"></span></div>
  <div class="row"><span class="status" id="status" aria-live="polite"></span>
  <button class="btn secondary" type="button" onclick="window.scormFinishReturn&&window.scormFinishReturn()">Save and exit</button></div>
</div>"""
    script = (MEDIA_SCRIPT.replace("__THRESHOLD__", repr(float(threshold)))
              .replace("__NOSKIP__", "true" if noskip else "false"))
    return page(title, lang, body, script, wrapper_js, test_build, pill)


PDF_SCRIPT = r"""
(function(){
  var MODE='__MODE__';
  var btn=document.getElementById('done'), status=document.getElementById('status');
  var st=window.scormGetState ? window.scormGetState() : null;
  function setDone(){
    if(window.scormComplete) window.scormComplete();
    btn.disabled=true; btn.lastChild.textContent=' Completed';
    status.textContent='This document is marked as complete.';
  }
  if(st && st.done){ setDone(); }
  else {
    if(window.scormSaveState) window.scormSaveState({opened:true,done:false},0,'1');
    if(MODE==='open'){ setDone(); }
  }
  btn.addEventListener('click',function(){
    if(window.scormSaveState) window.scormSaveState({opened:true,done:true},1,'1');
    setDone();
  });
})();
"""


def pdf_page(title, lang, filename, wrapper_js, mode, test_build, pill=""):
    body = f"""<div class="card">
  <iframe class="doc" src="{escape(filename)}" title="{escape(title)} (PDF document)"></iframe>
  <div class="row">
    <span class="status" id="status" aria-live="polite">Read the document, then mark it as complete.</span>
    <span class="row" style="margin:0">
      <a class="btn secondary" href="{escape(filename)}" target="_blank" rel="noopener">{ICON_OPEN} Open in new tab</a>
      <button class="btn" id="done" type="button">{ICON_CHECK} Mark as complete</button>
    </span>
  </div>
</div>"""
    return page(title, lang, body, PDF_SCRIPT.replace("__MODE__", mode), wrapper_js,
                test_build, pill)


# ---- manifests (no template comments are emitted into the output) ----

def _files_xml(files, indent="      "):
    return "\n".join(f'{indent}<file href={quoteattr(f)}/>' for f in files)


def manifest_2004(ident, title, href, files):
    t = xesc(title)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier={quoteattr(ident)} version="1.0"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:imsss="http://www.imsglobal.org/xsd/imsss"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3"
  xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3" xmlns:lom="http://ltsc.ieee.org/xsd/LOM"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd http://www.adlnet.org/xsd/adlseq_v1p3 adlseq_v1p3.xsd http://www.adlnet.org/xsd/adlnav_v1p3 adlnav_v1p3.xsd http://ltsc.ieee.org/xsd/LOM lom.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 4th Edition</schemaversion>
    <lom:lom><lom:general><lom:title><lom:string>{t}</lom:string></lom:title></lom:general></lom:lom>
  </metadata>
  <organizations default="ORG1">
    <organization identifier="ORG1">
      <title>{t}</title>
      <item identifier="ITEM1" identifierref="RES1">
        <title>{t}</title>
        <imsss:sequencing><imsss:deliveryControls completionSetByContent="true" objectiveSetByContent="true"/></imsss:sequencing>
      </item>
      <imsss:sequencing><imsss:controlMode flow="true"/></imsss:sequencing>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES1" type="webcontent" adlcp:scormType="sco" href={quoteattr(href)}>
{_files_xml(files)}
    </resource>
  </resources>
</manifest>
"""


def manifest_12(ident, title, href, files, mastery=None):
    t = xesc(title)
    ms = f"\n        <adlcp:masteryscore>{int(mastery)}</adlcp:masteryscore>" if mastery is not None else ""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier={quoteattr(ident)} version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG1">
    <organization identifier="ORG1">
      <title>{t}</title>
      <item identifier="ITEM1" identifierref="RES1" isvisible="true">
        <title>{t}</title>{ms}
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES1" type="webcontent" adlcp:scormtype="sco" href={quoteattr(href)}>
{_files_xml(files)}
    </resource>
  </resources>
</manifest>
"""
