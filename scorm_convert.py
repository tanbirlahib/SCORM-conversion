#!/usr/bin/env python3
"""SCORM conversion tool. Pure Python 3 standard library, no installs.

  python3 scorm_convert.py build INPUT [INPUT ...] --out DIR [options]
  python3 scorm_convert.py validate PACKAGE.zip|FOLDER

Each INPUT becomes one module (one SCO, one LMS activity):
  .html/.htm file, a folder of HTML (entry index.html), video (.mp4 .webm .m4v .ogv .mov),
  audio (.mp3 .m4a .aac .wav .ogg) or a .pdf.
"""
import argparse, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scormkit import builder, validate


def main(argv=None):
    ap = argparse.ArgumentParser(prog='scorm_convert.py', description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)

    b = sub.add_parser('build', help='convert content into SCORM packages')
    b.add_argument('inputs', nargs='+')
    b.add_argument('--out', required=True, help='output folder')
    b.add_argument('--prefix', default='Course', help='course name used in file names and identifiers')
    b.add_argument('--title', action='append', help='module title, once per input in order (default: <title> or file name)')
    b.add_argument('--versions', choices=['both', '2004', '12'], default='both')
    b.add_argument('--lang', default='en-GB')
    b.add_argument('--test-build', action='store_true',
                   help='TEST BUILD: visible banner, no seek blocking (kit doc 04 section 1)')
    b.add_argument('--video-threshold', type=float, default=0.95,
                   help='fraction of video/audio that must be played to complete (default 0.95)')
    b.add_argument('--no-skip', action='store_true', help='block seeking past the furthest point watched (final builds)')
    b.add_argument('--captions', help='.vtt captions file for a video input')
    b.add_argument('--pdf-complete', choices=['button', 'open'], default='button')
    b.add_argument('--html-complete', choices=['auto', 'load', 'manual', 'none'], default='auto',
                   help="auto: keep the content's own scormComplete() calls, else complete on load")
    b.add_argument('--entry', default='index.html', help='entry file for folder inputs')
    b.add_argument('--scored', action='store_true', help='content reports a real score via scormSetScore()')
    b.add_argument('--mastery', type=int, help='SCORM 1.2 masteryscore (only with --scored)')
    b.add_argument('--no-master', action='store_true', help='skip the master delivery bundle')

    v = sub.add_parser('validate', help='validate a SCORM zip or folder')
    v.add_argument('package')

    a = ap.parse_args(argv)
    if a.cmd == 'validate':
        return validate.main([a.package])

    if not 0 < a.video_threshold <= 1:
        ap.error('--video-threshold must be between 0 and 1')
    if a.mastery is not None and not a.scored:
        ap.error('--mastery needs --scored (status-based courses must not set a masteryscore)')
    opt = builder.Options(
        versions={'both': ('2004', '1.2'), '2004': ('2004',), '12': ('1.2',)}[a.versions],
        prefix=re.sub(r'[^A-Za-z0-9]+', '-', a.prefix).strip('-') or 'Course',
        lang=a.lang, test_build=a.test_build, video_threshold=a.video_threshold,
        no_skip=a.no_skip, pdf_complete=a.pdf_complete, html_complete=a.html_complete,
        html_entry=a.entry, captions=a.captions, scored=a.scored, mastery=a.mastery,
        master=not a.no_master)
    try:
        built, report, master = builder.build(a.inputs, a.out, opt, a.title)
    except builder.BuildError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    failed = False
    for mod, res in built:
        print(f"\nModule {mod.number}: {mod.title} ({mod.kind})")
        for ver, zp, r in res:
            failed |= bool(r.count('FAIL'))
            print(f"  SCORM {ver:<4}  {r.verdict:<22} {zp}")
            for s, m in r.items:
                if s == 'FAIL':
                    print(f"      [FAIL] {m}")
    if opt.warnings:
        print("\nWarnings:")
        for w in opt.warnings:
            print(f"  - {w}")
    print(f"\nReport: {report}")
    if master:
        print(f"Master bundle (delivery only, do not upload): {master}")
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
