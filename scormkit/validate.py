#!/usr/bin/env python3
"""Validate a SCORM package (.zip or extracted folder). Pure stdlib.

Based on the SCORM Conversion Kit's validate_scorm.py, with these fixes:
  - SCORM 2004 runtime checks no longer pass on SCORM 1.2 calls
    (Initialize/Commit used to match LMSInitialize/LMSCommit).
  - The launch item is taken from the DEFAULT organization, not the first one.
  - Zip entries with backslash separators or unsafe paths (.., absolute) FAIL.
  - Detects @import "http...", unquoted src=http..., srcset and protocol-relative URLs.
  - Every <file href> listed in the manifest must exist (WARN if not).
  - Leftover template placeholders ({{ID}}, {{TITLE}}) FAIL.

Exit 0 = PASS / PASS WITH WARNINGS, 1 = hard FAIL, 2 = usage error.
Usage: python3 -m scormkit.validate <package.zip | folder> [--quiet]
"""
import os, re, sys, zipfile, tempfile, shutil
import xml.etree.ElementTree as ET


class Result:
    def __init__(self, quiet=False):
        self.items = []
        self.quiet = quiet

    def add(self, status, msg):
        self.items.append((status, msg))
        if not self.quiet:
            print(f"  [{status:<4}] {msg}")

    def section(self, t):
        if not self.quiet:
            print(f"\n{t}\n" + "-" * len(t))

    def count(self, s):
        return sum(1 for st, _ in self.items if st == s)

    @property
    def verdict(self):
        if self.count('FAIL'):
            return "REJECTED"
        return "PASSED WITH WARNINGS" if self.count('WARN') else "PASSED"


def _local(tag):
    return tag.split('}')[-1]


def _attr(el, name):
    for k, v in el.attrib.items():
        if _local(k).lower() == name.lower():
            return v
    return None


def _read(p):
    with open(p, encoding='utf-8', errors='replace') as fh:
        return fh.read()


def validate(path, quiet=False):
    r = Result(quiet)
    if not quiet:
        print(f"\nSCORM Package Validator\n=======================\nTarget: {path}")
    tmp = None
    try:
        if os.path.isdir(path):
            root = path
        elif path.lower().endswith('.zip') and os.path.isfile(path):
            r.section("1. Zip container")
            mb = os.path.getsize(path) / 1048576
            r.add('PASS' if mb <= 500 else 'FAIL', f"Zip is {mb:.1f} MB (limit 500 MB)")
            with zipfile.ZipFile(path) as z:
                names = z.namelist()
                bad_sep = [n for n in names if '\\' in n]
                unsafe = [n for n in names if n.startswith('/') or re.match(r'^[A-Za-z]:', n)
                          or '..' in n.replace('\\', '/').split('/')]
                if bad_sep:
                    r.add('FAIL', f"{len(bad_sep)} zip entr(y/ies) use backslash separators "
                                  f"(e.g. '{bad_sep[0]}'); LMSs will not find these files. "
                                  "Re-zip with forward slashes.")
                if unsafe:
                    r.add('FAIL', f"unsafe zip entry path(s): {unsafe[:3]}")
                    return r
                if not bad_sep:
                    r.add('PASS', "Zip entry paths use forward slashes")
                tmp = tempfile.mkdtemp(prefix='scormval_')
                z.extractall(tmp)
            root = tmp
        else:
            print("ERROR: need an existing .zip or folder")
            return None

        r.section("2. Manifest location")
        man = os.path.join(root, 'imsmanifest.xml')
        if os.path.isfile(man):
            r.add('PASS', "imsmanifest.xml found at package root")
        else:
            found = None
            for dp, _, fns in os.walk(root):
                if 'imsmanifest.xml' in fns:
                    found = os.path.join(dp, 'imsmanifest.xml')
                    break
            if not found:
                r.add('FAIL', "No imsmanifest.xml anywhere in the package")
                return r
            r.add('FAIL', f"imsmanifest.xml is NOT at root (found at {os.path.relpath(found, root)}). "
                          "Zip the CONTENTS, not the folder.")
            man = found
        pkg = os.path.dirname(man)

        r.section("3. Manifest parse + SCORM version")
        raw = _read(man)
        if re.search(r'<!(DOCTYPE|ENTITY)', raw, re.I):
            # Manifests never need a DTD; refusing it blocks XXE / entity-expansion attacks.
            r.add('FAIL', "manifest contains a DOCTYPE/ENTITY declaration - not allowed")
            return r
        try:
            tree = ET.fromstring(raw.encode('utf-8'))
            r.add('PASS', "imsmanifest.xml is well-formed XML")
        except ET.ParseError as e:
            r.add('FAIL', f"manifest is not valid XML: {e}")
            return r
        if '{{' in raw and '}}' in raw:
            r.add('FAIL', "manifest still contains template placeholders ({{...}})")
        sv = ''
        for el in tree.iter():
            if _local(el.tag) == 'schemaversion':
                sv = (el.text or '').strip()
                break
        if '2004' in sv or 'CAM 1.3' in sv or 'adlcp_v1p3' in raw:
            ver = '2004'
        elif '1.2' in sv or 'adlcp_rootv1p2' in raw:
            ver = '1.2'
        else:
            ver = '1.2'
            r.add('WARN', f"could not detect version (schemaversion '{sv}'), assuming 1.2")
        if sv:
            r.add('PASS', f"Detected SCORM {ver} (schemaversion '{sv}')")
        if not tree.get('identifier'):
            r.add('FAIL', "manifest has no identifier attribute")

        r.section("4. Launch structure")
        orgs_el = next((e for e in tree.iter() if _local(e.tag) == 'organizations'), None)
        orgs = [e for e in tree.iter() if _local(e.tag) == 'organization']
        resources = {e.get('identifier'): e for e in tree.iter() if _local(e.tag) == 'resource'}
        href = None
        if not orgs:
            r.add('FAIL', "no <organization>")
        else:
            default = orgs_el.get('default') if orgs_el is not None else None
            org = next((o for o in orgs if o.get('identifier') == default), None)
            if default and org is None:
                r.add('FAIL', f"organizations default='{default}' matches no <organization>")
                org = orgs[0]
            org = org or orgs[0]
            items = [e for e in org.iter() if _local(e.tag) == 'item' and e.get('identifierref')]
            if not items:
                r.add('FAIL', f"default organization '{org.get('identifier')}' has no <item> with identifierref")
            else:
                ref = items[0].get('identifierref')
                res_el = resources.get(ref)
                if res_el is None:
                    r.add('FAIL', f"identifierref '{ref}' matches no <resource>")
                else:
                    href = res_el.get('href')
                    if not href:
                        r.add('FAIL', f"resource '{ref}' has no href")
                    else:
                        r.add('PASS', f"Launch file (href): '{href}'")
                        lp = os.path.join(pkg, href.split('?')[0].split('#')[0].replace('/', os.sep))
                        r.add('PASS' if os.path.isfile(lp) else 'FAIL',
                              "Launch file exists in package" if os.path.isfile(lp)
                              else f"launch file '{href}' MISSING")
                    st = (_attr(res_el, 'scormtype') or '').lower()
                    if st and st != 'sco':
                        r.add('FAIL', f"launch resource '{ref}' is scormtype='{st}', not 'sco'")
        missing = []
        for res_el in resources.values():
            for f in res_el:
                if _local(f.tag) == 'file' and f.get('href'):
                    fp = os.path.join(pkg, f.get('href').replace('/', os.sep))
                    if not os.path.isfile(fp):
                        missing.append(f.get('href'))
        if missing:
            r.add('WARN', f"{len(missing)} <file href> listed in manifest but not in package: {missing[:5]}")

        r.section("5. Single-SCO rule")
        sco = sum(1 for e in resources.values() if (_attr(e, 'scormtype') or '').lower() == 'sco')
        if sco == 1:
            r.add('PASS', "Exactly one SCO resource")
        elif sco == 0:
            r.add('WARN', "no resource marked scormtype='sco' - verify the launch resource is the SCO")
        else:
            r.add('FAIL', f"{sco} SCOs found - this standard requires ONE SCO per package")

        r.section("6. Runtime API calls (static scan)")
        code = []
        for dp, _, fns in os.walk(pkg):
            for fn in fns:
                if fn.lower().endswith(('.html', '.htm', '.js')):
                    code.append(_read(os.path.join(dp, fn)))
        code = '\n'.join(code)

        def has(pat, label, sev='FAIL'):
            ok = re.search(pat, code) is not None
            r.add('PASS' if ok else sev, label + (" - found" if ok else " - NOT found"))

        if ver == '2004':
            # \b stops these matching the SCORM 1.2 names LMSInitialize / LMSCommit / ...
            has(r'\bInitialize\s*\(', 'Initialize("")')
            has(r'cmi\.completion_status', 'Sets cmi.completion_status')
            has(r'cmi\.success_status', 'Sets cmi.success_status (only needed for scored content)', 'WARN')
            has(r'cmi\.score\.raw', 'Sets cmi.score.raw', 'WARN')
            has(r'cmi\.score\.scaled', 'Sets cmi.score.scaled', 'WARN')
            has(r'cmi\.progress_measure', 'Sets cmi.progress_measure', 'WARN')
            has(r'\bCommit\s*\(', 'Commit("")')
            has(r'\bTerminate\s*\(', 'Terminate("")')
            has(r'API_1484_11', 'References API_1484_11')
            has(r'cmi\.(location|suspend_data)', 'Bookmarking (cmi.location / cmi.suspend_data)', 'WARN')
            has(r'\bGetValue\s*\(', 'Reads state on startup (GetValue)', 'WARN')
        else:
            has(r'\bLMSInitialize\s*\(', 'LMSInitialize("")')
            has(r'cmi\.core\.lesson_status', 'Sets cmi.core.lesson_status')
            has(r'cmi\.core\.score\.raw', 'Sets cmi.core.score.raw (score/progress)', 'WARN')
            has(r'\bLMSCommit\s*\(', 'LMSCommit("")')
            has(r'\bLMSFinish\s*\(', 'LMSFinish("")')
            has(r'(cmi\.core\.lesson_location|cmi\.suspend_data)', 'Bookmarking', 'WARN')
            has(r'\bLMSGetValue\s*\(', 'Reads state on startup (LMSGetValue)', 'WARN')
        has(r'(findAPI|\.parent\b|\.opener\b)', 'API discovery (parent/opener walking)', 'WARN')

        r.section("7. Asset paths (self-containment)")
        ext, links = [], 0
        url = r'((?:https?:)?//[^\s"\'<>)]+)'
        pats = [
            r'(?i)\b(?:src|poster|data)\s*=\s*["\']?' + url,
            r'(?i)\bsrcset\s*=\s*["\'][^"\']*?' + url,
            r'(?i)<link\b[^>]*\bhref\s*=\s*["\']?' + url,
            r'(?i)url\(\s*["\']?' + url,
            r'(?i)@import\s+["\']' + url,
        ]
        for dp, _, fns in os.walk(pkg):
            for fn in fns:
                if not fn.lower().endswith(('.html', '.htm', '.js', '.css', '.svg')):
                    continue
                t = _read(os.path.join(dp, fn))
                for p in pats:
                    for m in re.finditer(p, t):
                        u = m.group(1)
                        if re.match(r'(?i)^(?:https?:)?//(www\.)?w3\.org/', u):
                            continue  # XML namespaces inside inline SVG, never fetched
                        ext.append(f"{os.path.relpath(os.path.join(dp, fn), pkg)}: {u}")
                links += len(re.findall(r'(?i)<a\b[^>]*\bhref\s*=\s*["\']?https?://', t))
        if not ext:
            r.add('PASS', "No external LOADED assets (CDN scripts/styles/fonts/images)")
        else:
            r.add('FAIL', f"{len(set(ext))} external loaded asset(s) - must be self-contained:")
            if not quiet:
                for e in sorted(set(ext))[:15]:
                    print(f"         - {e}")
            r.items[-1] = ('FAIL', r.items[-1][1] + " " + "; ".join(sorted(set(ext))[:5]))
        if links:
            r.add('INFO', f"{links} external <a href> hyperlink(s) - allowed; verify they are intended")
        return r
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
        if not quiet and r.items:
            print(f"\nSummary\n-------\n  Passed: {r.count('PASS')}   Warnings: {r.count('WARN')}   "
                  f"Failed: {r.count('FAIL')}\n\n  VERDICT: {r.verdict}")
            print("  Note: runtime checks are a STATIC scan - do one live LMS test upload too.")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    args = [a for a in argv if not a.startswith('--')]
    if len(args) != 1:
        print(__doc__)
        return 2
    r = validate(args[0], quiet='--quiet' in argv)
    if r is None:
        return 2
    return 1 if r.count('FAIL') else 0


if __name__ == '__main__':
    sys.exit(main())
