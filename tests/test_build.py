"""Unit tests: python3 -m unittest discover -s tests"""
import io, os, sys, shutil, tempfile, unittest, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scormkit import builder, validate  # noqa: E402

PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
       b"2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='scormtest_'))
        self.inp = self.tmp / 'in'
        self.inp.mkdir()
        self.out = self.tmp / 'out'

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def build(self, *names, **kw):
        opt = builder.Options(prefix='Test', **kw)
        built, report, master = builder.build([str(self.inp / n) for n in names], self.out, opt)
        return opt, built, report, master


class BuildTests(Base):
    def test_all_kinds_pass_both_versions(self):
        (self.inp / 'page.html').write_text('<html><head><title>My Page</title></head><body>Hi</body></html>')
        (self.inp / 'clip.mp4').write_bytes(b'\x00\x00\x00\x18ftypmp42fake')
        (self.inp / 'talk.mp3').write_bytes(b'ID3fake')
        (self.inp / 'Policy Doc.pdf').write_bytes(PDF)
        opt, built, report, master = self.build('page.html', 'clip.mp4', 'talk.mp3', 'Policy Doc.pdf')
        self.assertEqual(len(built), 4)
        for mod, res in built:
            self.assertEqual([v for v, _, _ in res], ['2004', '1.2'])
            for ver, zp, r in res:
                self.assertEqual(r.count('FAIL'), 0, (zp.name, r.items))
        self.assertTrue(report.is_file())
        self.assertTrue(master.is_file())
        self.assertEqual(built[0][0].title, 'My Page')

    def test_zip_layout_and_manifest(self):
        (self.inp / 'clip.mp4').write_bytes(b'fake')
        _, built, _, _ = self.build('clip.mp4')
        (_, z04, _), (_, z12, _) = built[0][1]
        with zipfile.ZipFile(z04) as z:
            names = z.namelist()
            self.assertEqual(names[0], 'imsmanifest.xml')
            self.assertIn('res/index.html', names)
            self.assertIn('res/clip.mp4', names)
            self.assertIn('adlcp_v1p3.xsd', names)            # full 2004 schema set
            self.assertTrue(all('\\' not in n for n in names))
            man = z.read('imsmanifest.xml').decode()
            self.assertNotIn('{{', man)
            self.assertNotIn('<!--', man)                      # no template comments leak
            ET.fromstring(man)
            self.assertIn('_2004"', man)
            self.assertIn('href="res/clip.mp4"', man)
            idx = z.read('res/index.html').decode()
            self.assertIn('API_1484_11', idx)
            self.assertNotIn('TEST BUILD', idx)
            self.assertNotIn('\u2014', idx)   # kit rule: no em dash characters
        with zipfile.ZipFile(z12) as z:
            names = z.namelist()
            self.assertNotIn('adlcp_v1p3.xsd', names)
            man = z.read('imsmanifest.xml').decode()
            self.assertIn('_12"', man)
            self.assertIn('adlcp:scormtype="sco"', man)
            self.assertNotIn('masteryscore', man)              # status-based: no masteryscore

    def test_versions_and_test_build(self):
        (self.inp / 'a.mp4').write_bytes(b'x')
        _, built, _, _ = self.build('a.mp4', versions=('1.2',), test_build=True, no_skip=True)
        res = built[0][1]
        self.assertEqual(len(res), 1)
        with zipfile.ZipFile(res[0][1]) as z:
            idx = z.read('res/index.html').decode()
        self.assertIn('TEST BUILD - timing disabled', idx)
        self.assertIn('NOSKIP=false', idx)                     # test build never blocks seeking

    def test_html_folder_keeps_assets_and_wiring(self):
        site = self.inp / 'site'
        (site / 'img').mkdir(parents=True)
        (site / 'img' / 'a.png').write_bytes(b'png')
        (site / 'index.html').write_text(
            '<html><head><title>S</title></head><body><img src="img/a.png" alt="">'
            '<script>function last(){window.scormComplete();}</script></body></html>')
        opt, built, _, _ = self.build('site')
        with zipfile.ZipFile(built[0][1][0][1]) as z:
            self.assertIn('res/img/a.png', z.namelist())
            idx = z.read('res/index.html').decode()
        self.assertEqual(idx.count('id="scorm-wrapper"'), 1)
        self.assertNotIn('addEventListener("load"', idx)      # already wired: no auto-complete
        self.assertFalse(any('does not call scormComplete' in w for w in opt.warnings))

    def test_html_wrapper_injection_is_idempotent(self):
        p = self.inp / 'p.html'
        p.write_text('<html><head><title>P</title></head><body>x</body></html>')
        self.build('p.html')
        built_html = zipfile.ZipFile(next((self.out / 'SCORM-2004').glob('*.zip'))).read('res/index.html').decode()
        p.write_text(built_html)
        shutil.rmtree(self.out)
        _, built, _, _ = self.build('p.html')
        again = zipfile.ZipFile(built[0][1][0][1]).read('res/index.html').decode()
        self.assertEqual(again.count('id="scorm-wrapper"'), 1)

    def test_external_font_is_rejected(self):
        (self.inp / 'f.html').write_text('<html><head><title>F</title><link rel="stylesheet" '
                                         'href="https://fonts.googleapis.com/css2?family=Inter"></head><body></body></html>')
        _, built, _, _ = self.build('f.html')
        self.assertTrue(all(r.count('FAIL') for _, _, r in built[0][1]))

    def test_scored_mastery(self):
        (self.inp / 'q.html').write_text('<html><head><title>Q</title></head><body></body></html>')
        _, built, _, _ = self.build('q.html', scored=True, mastery=80, versions=('1.2',))
        z = zipfile.ZipFile(built[0][1][0][1])
        self.assertIn('<adlcp:masteryscore>80</adlcp:masteryscore>', z.read('imsmanifest.xml').decode())
        self.assertIn('SCORM_SCORED=true', z.read('res/index.html').decode())

    def test_rejects_unknown_and_zip_inputs(self):
        (self.inp / 'x.docx').write_bytes(b'x')
        (self.inp / 'y.zip').write_bytes(b'x')
        with self.assertRaises(builder.BuildError):
            self.build('x.docx')
        with self.assertRaises(builder.BuildError):
            self.build('y.zip')


class ValidatorRegressionTests(Base):
    M04 = ('<?xml version="1.0"?><manifest identifier="x" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" '
           'xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"><metadata><schema>ADL SCORM</schema>'
           '<schemaversion>2004 4th Edition</schemaversion></metadata>{orgs}<resources>'
           '<resource identifier="R1" type="webcontent" adlcp:scormType="sco" href="res/index.html"/>'
           '<resource identifier="R2" type="webcontent" adlcp:scormType="asset" href="res/missing.html"/>'
           '</resources></manifest>')
    ORG1 = ('<organizations default="ORG1"><organization identifier="ORG1"><title>t</title>'
            '<item identifier="I1" identifierref="R1"><title>t</title></item></organization></organizations>')

    def pkg(self, html, orgs=None, man=None):
        d = self.tmp / 'pkg'
        (d / 'res').mkdir(parents=True, exist_ok=True)
        (d / 'imsmanifest.xml').write_text(man or self.M04.format(orgs=orgs or self.ORG1))
        (d / 'res' / 'index.html').write_text(html)
        return validate.validate(str(d), quiet=True)

    def fails(self, r):
        return [m for s, m in r.items if s == 'FAIL']

    def test_12_calls_do_not_satisfy_2004(self):
        r = self.pkg('<script>LMSInitialize("");LMSCommit("");cmi.completion_status;Terminate("");API_1484_11</script>')
        f = ' '.join(self.fails(r))
        self.assertIn('Initialize', f)
        self.assertIn('Commit', f)

    def test_default_organization_is_used(self):
        orgs = ('<organizations default="ORG2"><organization identifier="ORG1"><title>a</title>'
                '<item identifier="I1" identifierref="R1"><title>a</title></item></organization>'
                '<organization identifier="ORG2"><title>b</title><item identifier="I2" identifierref="R2">'
                '<title>b</title></item></organization></organizations>')
        r = self.pkg('<script>Initialize("")</script>', orgs=orgs)
        self.assertTrue(any('MISSING' in m or "not 'sco'" in m for m in self.fails(r)))

    def test_import_and_unquoted_src_detected(self):
        r = self.pkg('<style>@import "https://fonts.googleapis.com/css2?family=X";</style>'
                     '<script src=https://cdn.example.com/x.js></script>')
        f = ' '.join(self.fails(r))
        self.assertIn('fonts.googleapis.com', f)
        self.assertIn('cdn.example.com', f)

    def test_svg_namespace_is_not_external(self):
        r = self.pkg('<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>'
                     '<a href="https://example.com">link</a>')
        self.assertFalse(any('external loaded' in m for m in self.fails(r)))

    def test_backslash_zip_entries_fail(self):
        zp = self.tmp / 'bs.zip'
        with zipfile.ZipFile(zp, 'w') as z:
            z.writestr('imsmanifest.xml', self.M04.format(orgs=self.ORG1))
            z.writestr('res\\index.html', '<script>Initialize("")</script>')
        r = validate.validate(str(zp), quiet=True)
        self.assertTrue(any('backslash' in m for m in self.fails(r)))

    def test_doctype_rejected(self):
        man = '<?xml version="1.0"?><!DOCTYPE m [<!ENTITY a "aaaa">]><manifest identifier="x">&a;</manifest>'
        r = self.pkg('', man=man)
        self.assertTrue(any('DOCTYPE' in m for m in self.fails(r)))

    def test_manifest_not_at_root(self):
        zp = self.tmp / 'nested.zip'
        with zipfile.ZipFile(zp, 'w') as z:
            z.writestr('course/imsmanifest.xml', self.M04.format(orgs=self.ORG1))
            z.writestr('course/res/index.html', 'x')
        r = validate.validate(str(zp), quiet=True)
        self.assertTrue(any('NOT at root' in m for m in self.fails(r)))


if __name__ == '__main__':
    unittest.main()
