"""Build SCORM 2004 / 1.2 packages from HTML, video, audio or PDF sources."""
import os, re, shutil, tempfile, zipfile, datetime
from dataclasses import dataclass, field
from html import unescape
from pathlib import Path

from . import templates
from .validate import validate

HERE = Path(__file__).resolve().parent
WRAPPER_JS = (HERE / 'wrapper.js').read_text(encoding='utf-8')
SCHEMA_DIR = HERE / 'schema-2004'

VIDEO = {'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
         '.ogv': 'video/ogg', '.mov': 'video/quicktime'}
AUDIO = {'.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
         '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg'}
HTMLX = {'.html', '.htm'}
STORE_EXT = set(VIDEO) | set(AUDIO) | {'.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip',
                                         '.woff', '.woff2'}


class BuildError(Exception):
    pass


@dataclass
class Options:
    versions: tuple = ('2004', '1.2')
    prefix: str = 'Course'
    lang: str = 'en-GB'
    test_build: bool = False
    video_threshold: float = 0.95     # fraction of media that must be played
    no_skip: bool = False             # block seeking past the furthest point watched
    pdf_complete: str = 'button'      # 'button' | 'open'
    html_complete: str = 'auto'       # 'auto' | 'load' | 'manual' | 'none'
    html_entry: str = 'index.html'
    captions: str = None              # .vtt file for video
    scored: bool = False
    mastery: int = None               # 1.2 masteryscore, scored content only
    master: bool = True
    warnings: list = field(default_factory=list)


@dataclass
class Module:
    source: Path
    kind: str
    title: str
    number: int


def detect_kind(src: Path):
    if src.is_dir():
        return 'html'
    ext = src.suffix.lower()
    if ext in HTMLX:
        return 'html'
    if ext in VIDEO:
        return 'video'
    if ext in AUDIO:
        return 'audio'
    if ext == '.pdf':
        return 'pdf'
    if ext == '.zip':
        return 'zip'
    raise BuildError(f"unsupported input type: {src.name} "
                     f"(use .html/.htm, a folder, {', '.join(sorted(VIDEO))}, "
                     f"{', '.join(sorted(AUDIO))}, .pdf)")


def slugify(s, sep='-'):
    s = re.sub(r'[^A-Za-z0-9]+', sep, s).strip(sep).lower()
    return s[:60].strip(sep) or 'module'


def html_title(text):
    m = re.search(r'(?is)<title[^>]*>(.*?)</title>', text)
    return re.sub(r'\s+', ' ', unescape(m.group(1))).strip() if m else None


def pretty_name(p: Path):
    return re.sub(r'[_\-]+', ' ', p.stem).strip().title() or 'Module'


def safe_filename(name):
    base, ext = os.path.splitext(name)
    return (slugify(base) or 'file') + ext.lower()


# ---------------- staging (builds the res/ folder) ----------------

def _inject_wrapper(text, opt, title):
    """Insert the wrapper as the first script in <head>; idempotent."""
    tag = f'<script id="scorm-wrapper">\n{WRAPPER_JS}\n</script>'
    text = re.sub(r'(?is)<script id="scorm-wrapper">.*?</script>\s*', '', text)
    if opt.scored:
        tag = '<script>window.SCORM_SCORED=true;</script>\n' + tag
    m = re.search(r'(?is)<head\b[^>]*>', text)
    if m:
        return text[:m.end()] + '\n' + tag + text[m.end():]
    m = re.search(r'(?is)<html\b[^>]*>', text)
    if m:
        return text[:m.end()] + '\n<head>\n' + tag + '\n</head>' + text[m.end():]
    return (f'<!DOCTYPE html>\n<html lang="{opt.lang}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{title}</title>\n{tag}\n</head><body>\n{text}\n</body></html>')


def _append_body(text, snippet):
    i = text.lower().rfind('</body>')
    return text[:i] + snippet + '\n' + text[i:] if i >= 0 else text + '\n' + snippet


AUTO_LOAD = '<script>window.addEventListener("load",function(){if(window.scormComplete)window.scormComplete();});</script>'
MANUAL_BTN = ('<button type="button" id="scorm-mark-complete" style="position:fixed;right:16px;bottom:16px;'
              'z-index:9999;border:0;border-radius:999px;padding:12px 20px;min-height:44px;font:600 15px system-ui,sans-serif;'
              'background:#0b6bcb;color:#fff;cursor:pointer" '
              'onclick="if(window.scormComplete)window.scormComplete();this.disabled=true;this.textContent=\'Completed\'">'
              'Mark as complete</button>')


def stage_html(mod, opt, res):
    src = mod.source
    if src.is_dir():
        shutil.copytree(src, res, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('.*', '__MACOSX', 'imsmanifest.xml'))
        entry = opt.html_entry
        if not (res / entry).is_file():
            htmls = sorted(p.name for p in res.glob('*.htm*'))
            if len(htmls) == 1:
                entry = htmls[0]
            else:
                raise BuildError(f"{src}: no '{opt.html_entry}' found; pass --entry "
                                 f"(candidates: {htmls[:10]})")
    else:
        entry = 'index.html'
        shutil.copy2(src, res / entry)
        rel = re.findall(r'(?i)\b(?:src|href)\s*=\s*["\'](?!https?:|//|data:|#|mailto:|javascript:)([^"\']+)', src.read_text(encoding='utf-8', errors='replace'))
        missing = sorted({r for r in rel if not (src.parent / r.split('?')[0].split('#')[0]).exists()})
        local = sorted({r for r in rel if r not in missing})
        if local:
            opt.warnings.append(f"{src.name}: references local files {local[:5]} that are NOT copied "
                                "(single-file input). Convert the whole folder instead.")
        if missing:
            opt.warnings.append(f"{src.name}: broken relative references {missing[:5]}")
    page = res / entry
    text = page.read_text(encoding='utf-8', errors='replace')
    without_wrapper = re.sub(r'(?is)<script id="scorm-wrapper">.*?</script>', '', text)
    wired = 'scormComplete' in without_wrapper or 'scormFinishReturn' in without_wrapper
    mode = opt.html_complete
    if mode == 'auto':
        mode = 'none' if wired else 'load'
        if not wired:
            opt.warnings.append(f"{mod.title}: HTML does not call scormComplete(); completion is set "
                                "when the page loads. Wire the content (see README) for "
                                "last-slide completion and resume.")
    text = _inject_wrapper(text, opt, mod.title)
    if mode == 'load':
        text = _append_body(text, AUTO_LOAD)
    elif mode == 'manual':
        text = _append_body(text, MANUAL_BTN)
    if opt.test_build:
        text = _append_body(text, '<div role="note" style="position:fixed;left:12px;bottom:12px;z-index:9999;'
                                  'background:#b3261e;color:#fff;font:700 12px system-ui,sans-serif;padding:6px 12px;'
                                  'border-radius:999px;pointer-events:none">TEST BUILD - timing disabled</div>')
        opt.warnings.append(f"{mod.title}: TEST BUILD banner added. Timers inside custom HTML are "
                            "not removed automatically; remove them by hand if present.")
    page.write_text(text, encoding='utf-8')
    return entry


def stage_media(mod, opt, res):
    name = safe_filename(mod.source.name)
    shutil.copy2(mod.source, res / name)
    mime = (VIDEO if mod.kind == 'video' else AUDIO)[mod.source.suffix.lower()]
    cap = None
    if opt.captions and mod.kind == 'video':
        cp = Path(opt.captions)
        if not cp.is_file():
            raise BuildError(f"captions file not found: {cp}")
        cap = safe_filename(cp.name)
        shutil.copy2(cp, res / cap)
    elif mod.kind == 'video':
        opt.warnings.append(f"{mod.title}: no captions (.vtt) supplied - accessibility gap.")
    noskip = opt.no_skip and not opt.test_build
    html = templates.media_page(mod.kind, mod.title, opt.lang, name, mime, WRAPPER_JS,
                                opt.video_threshold, noskip, opt.test_build, cap,
                                pill=f"Module {mod.number}")
    (res / 'index.html').write_text(html, encoding='utf-8')
    return 'index.html'


def stage_pdf(mod, opt, res):
    name = safe_filename(mod.source.name)
    shutil.copy2(mod.source, res / name)
    html = templates.pdf_page(mod.title, opt.lang, name, WRAPPER_JS, opt.pdf_complete,
                              opt.test_build, pill=f"Module {mod.number}")
    (res / 'index.html').write_text(html, encoding='utf-8')
    opt.warnings.append(f"{mod.title}: PDF reading progress inside the viewer cannot be tracked; "
                        f"completion is set {'when opened' if opt.pdf_complete == 'open' else 'by the Mark as complete button'}. "
                        "Some mobile browsers show only the first page inline; the 'Open in new tab' link covers this.")
    return 'index.html'


# ---------------- packaging ----------------

def _write_zip(folder: Path, out: Path):
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.write(folder / 'imsmanifest.xml', 'imsmanifest.xml')   # manifest first, at root
        for p in sorted(folder.rglob('*')):
            if p.is_file() and p.name != 'imsmanifest.xml':
                arc = p.relative_to(folder).as_posix()           # always forward slashes
                ct = zipfile.ZIP_STORED if p.suffix.lower() in STORE_EXT else zipfile.ZIP_DEFLATED
                z.write(p, arc, compress_type=ct)


def build_module(mod, opt, out_dir: Path):
    """Returns list of (version, zip_path, Result)."""
    results = []
    with tempfile.TemporaryDirectory(prefix='scormbuild_') as tmp:
        content = Path(tmp) / 'content'
        content.mkdir()
        entry = {'html': stage_html, 'video': stage_media, 'audio': stage_media,
                 'pdf': stage_pdf}[mod.kind](mod, opt, content)
        files = sorted('res/' + p.relative_to(content).as_posix()
                       for p in content.rglob('*') if p.is_file())
        href = 'res/' + entry
        base = f"{opt.prefix}-Module-{mod.number:02d}-{slugify(mod.title)}"
        ident_base = f"{slugify(opt.prefix, '_')}_m{mod.number:02d}_{slugify(mod.title, '_')}"[:80]
        for ver in opt.versions:
            pkg = Path(tmp) / f'pkg{ver}'
            shutil.copytree(content, pkg / 'res')
            if ver == '2004':
                shutil.copytree(SCHEMA_DIR, pkg, dirs_exist_ok=True)
                man = templates.manifest_2004(ident_base + '_2004', mod.title, href, files)
                folder, suffix = 'SCORM-2004', 'SCORM-2004'
            else:
                man = templates.manifest_12(ident_base + '_12', mod.title, href, files,
                                            opt.mastery if opt.scored else None)
                folder, suffix = 'SCORM-1.2', 'SCORM-1.2'
            (pkg / 'imsmanifest.xml').write_text(man, encoding='utf-8')
            zp = out_dir / folder / f"{base}-{suffix}.zip"
            _write_zip(pkg, zp)
            results.append((ver, zp, validate(str(zp), quiet=True)))
    return results


def collect_modules(inputs, titles=None):
    mods, n = [], 0
    for i, raw in enumerate(inputs):
        src = Path(raw).expanduser().resolve()
        if not src.exists():
            raise BuildError(f"not found: {raw}")
        kind = detect_kind(src)
        if kind == 'zip':
            raise BuildError(f"{src.name}: is already a zip. Validate it with "
                             "'python3 scorm_convert.py validate <zip>', or extract it and pass the folder.")
        n += 1
        title = titles[i] if titles and i < len(titles) and titles[i] else None
        if not title and kind == 'html':
            f = src if src.is_file() else (src / 'index.html')
            if f.is_file():
                title = html_title(f.read_text(encoding='utf-8', errors='replace'))
        mods.append(Module(src, kind, title or pretty_name(src), n))
    return mods


def write_master(out_dir: Path, opt, built):
    readme = out_dir / 'README.txt'
    lines = [f"{opt.prefix} SCORM delivery bundle ({datetime.date.today().isoformat()})", "",
             "Upload ONE inner module zip per LMS activity. Never upload this master zip.",
             "Pick the folder that matches your LMS (SCORM-2004 or SCORM-1.2; try 1.2 if unsure).", ""]
    for mod, res in built:
        for ver, zp, r in res:
            lines.append(f"  {zp.parent.name}/{zp.name}  [{r.verdict}]")
    readme.write_text("\n".join(lines) + "\n", encoding='utf-8')
    master = out_dir / f"{opt.prefix}-SCORM.zip"
    with zipfile.ZipFile(master, 'w', zipfile.ZIP_STORED) as z:
        z.write(readme, 'README.txt')
        for mod, res in built:
            for ver, zp, r in res:
                z.write(zp, f"{zp.parent.name}/{zp.name}")
    return master


def write_report(out_dir: Path, opt, built):
    """Pre-Export Validation Report (kit doc 04 section 5). Only the static checks are
    automated; the rest is marked as needing a manual check rather than claimed."""
    vers = ' + '.join('SCORM ' + v for v in opt.versions)
    fails = [(zp, r) for _, res in built for _, zp, r in res if r.count('FAIL')]
    lines = ["# SCORM Validation Report", "",
             f"Generated: {datetime.datetime.now().isoformat(timespec='seconds')}", "",
             "```",
             f"Version:                 {vers}",
             f"Build Type:              {'Test' if opt.test_build else 'Final'}",
             f"Timing:                  {'Disabled (test build)' if opt.test_build else 'Per source content'}",
             "Responsive Validation:   NOT RUN - check at ~390 / 768 / 1280 px",
             f"Structure + API scan:    {'FAILED' if fails else 'Passed'} (static validator, every package)",
             "Completion Tracking:     NOT RUN - check with a mock API or LMS test upload",
             "Progress Tracking:       NOT RUN - check with a mock API or LMS test upload",
             "Suspend/Resume:          NOT RUN - check with a mock API or LMS test upload",
             f"Scoring:                 {'Scored - verify pass/fail' if opt.scored else 'N/A - status-based'}",
             "Accessibility:           NOT RUN - keyboard / screen reader pass needed",
             "```", "", "## Packages", "",
             "| Package | Verdict | Pass | Warn | Fail |", "|---|---|---|---|---|"]
    for _, res in built:
        for ver, zp, r in res:
            lines.append(f"| {zp.parent.name}/{zp.name} | {r.verdict} | {r.count('PASS')} | "
                         f"{r.count('WARN')} | {r.count('FAIL')} |")
    lines += ["", "## Warnings", ""]
    w = list(opt.warnings)
    for _, res in built:
        for ver, zp, r in res:
            w += [f"{zp.name}: [{s}] {m}" for s, m in r.items if s in ('WARN', 'FAIL')]
    lines += [f"- {x}" for x in w] or ["- none"]
    lines += ["", "## Recommendations", "",
              "- Do one live test upload per LMS: the validator checks that the calls exist, "
              "not that the LMS records them at runtime."]
    p = out_dir / 'SCORM-Validation-Report.md'
    p.write_text("\n".join(lines) + "\n", encoding='utf-8')
    return p


def build(inputs, out_dir, opt: Options, titles=None):
    out_dir = Path(out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    mods = collect_modules(inputs, titles)
    built = [(m, build_module(m, opt, out_dir)) for m in mods]
    report = write_report(out_dir, opt, built)
    master = write_master(out_dir, opt, built) if opt.master else None
    return built, report, master
