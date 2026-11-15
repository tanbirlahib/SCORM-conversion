# SCORM Conversion Kit: deep check

Reviewed: `SCORM-Kit-Files.zip` (11 files: 8 Word docs, `validate_scorm.py`, `Validate-ScormPackage.ps1`,
`SCORM-Validation-Report.md`). Method: read every document in full, compared both validators with the
copies in the installed `scorm-conversion` skill, and ran the Python validator against purpose-built
test packages. How each finding was established is noted: **tested** (reproduced by running code),
**code reading** (follows directly from the source), or **doc comparison**.

## Summary

The kit is well organised and the core standard is sound (manifest at root, one SCO, `res/index.html`,
dual 2004/1.2, self-contained, resume). The problems are: the kit is **missing files it depends on**,
the **validator can pass packages it should fail**, the **wrapper has three runtime bugs** (two affect
scored courses), and **several documents contradict each other**.

| # | Severity | Area | Finding | How |
|---|---|---|---|---|
| 1 | High | Kit contents | README describes 3 folders and `Skill/scorm-conversion.skill`; the zip is flat and has **no .skill file**. Doc 05 B4/B5 rely on `Package-Scorm.ps1`, `Embed-GoogleFonts.ps1` and `wiring-guide.md` (the `showResume` popup), none of which are in the kit. A colleague given only this zip cannot build a package. | doc comparison |
| 2 | High | Validator | SCORM 2004 checks pass on SCORM 1.2 code: `Initialize\s*\(` matches `LMSInitialize(`, `Commit\s*\(` matches `LMSCommit(`. A 2004 manifest with 1.2-only runtime calls gets **PASSED WITH WARNINGS**. The PowerShell validator uses the same patterns. | tested (Python); same regex in .ps1 |
| 3 | High | Wrapper | Scored courses: `scormSave()` writes progress into `cmi.score.raw` (and `score.scaled` on 2004) on every navigation, overwriting a real quiz score. Docs 01/02/05 say scored courses report the real score. | code reading |
| 4 | High | Docs | Doc 05 section 6 says status-based courses should "Use masteryscore 0". Doc 01 section 7, doc 05 B3 and the manifest template say **no masteryscore** for status-based courses (because score.raw carries progress). These are opposite instructions. | doc comparison |
| 5 | Medium | Wrapper | SCORM 1.2: `if(st!=="completed") S(ST(),"incomplete")` downgrades a `passed`/`failed` lesson_status back to `incomplete` on the next save. | code reading |
| 6 | Medium | Wrapper | `scormFinishReturn()` calls Terminate, then the `unload` handler calls Commit + Terminate again. Calls after Terminate are errors in both standards (silently swallowed). | code reading |
| 7 | Medium | Wrapper | Only `unload` is used to save on exit; it is unreliable on mobile and with the back/forward cache. `pagehide` should be used too. | code reading |
| 8 | Medium | Validator | Python validator takes the first `<organization>`, ignoring `organizations default=`. A package whose default org points at a missing file passes. The PowerShell validator does honour the default, so the two validators can disagree. | tested |
| 9 | Medium | Validator | Python validator misses `@import "https://..."` and unquoted `src=https://...`; a Google Fonts `@import` plus an unquoted CDN script both passed as "No external LOADED assets". | tested |
| 10 | Medium | Docs | Test-build rules conflict: doc 01 section 3 says the TEST build should "keep the quiz gate"; doc 01 section 0 and doc 04 section 1 say quizzes "must not block navigation". | doc comparison |
| 11 | Medium | Report | `SCORM-Validation-Report.md` contradicts the kit standard: it lists `res/index.html` and the 2004 schema files as problems, recommends deleting the XSDs and moving content to root, and holds up Whistleblowing (root `index.html`, no schema set) as the cleaner model. Under docs 01/05, Whistleblowing is the non-conformant set. | doc comparison |
| 12 | Medium | Docs | Doc 06 tells suppliers the validator "checks every item in the list above automatically". It cannot check call order (Commit before Terminate), success status for scored content (only a WARN), or the staging upload. Doc 06 also says "no http(s)://" without the hyperlink exemption that docs 05/04 and the validator allow. | doc comparison |
| 13 | Medium | Design | On SCORM 2004 the wrapper also writes progress into `cmi.score.scaled`; doc 06 says score.scaled "is what our reporting uses". Status-based courses will appear in reports as having a score equal to their progress. | code reading + doc comparison |
| 14 | Low | Validator | Zip entries saved with backslashes (`res\index.html`, common from some Windows zip tools) are reported as "launch file MISSING" instead of the real cause. | tested |
| 15 | Low | Packager | `{{ID}}` is replaced throughout the template, including inside the instruction comment, which is why the VCAD manifests ship `<!-- ... Replace educateU_antifraud_m01_2004 ... -->` (the report's finding). | code reading (skill `package_scorm.py`) |
| 16 | Low | Manifest | The 1.2 template's `xsi:schemaLocation` names `imscp_rootv1p1p2.xsd` / `adlcp_rootv1p2.xsd`, but 1.2 packages ship without them. Harmless on most LMSs, flagged by strict checkers. | doc comparison |
| 17 | Low | Docs | Doc 07 says the "generic validator" matches scormType case-sensitively and misses findAPI. Both current validators already handle these, so that note is stale. | code reading |
| 18 | Low | Docs | Asterisks were lost in conversion to Word: "manifest-.xml" (doc 03), "imsss_.xsd" (doc 07). Docs 01-04 cite Markdown files (`validation-and-reporting.md`) rather than the numbered Word docs a reader has. README says "PASS / FAIL" while the validator prints "PASSED / REJECTED". | doc comparison |
| 19 | Low | Report | PASS counts are not comparable across the two validators: the .ps1 emits extra PASS lines (default organization, launch item), so "18 PASS" from Python is not the same scale as a PowerShell run. | code reading |

## Checked and correct

- `validate_scorm.py` is identical to the skill's copy; `Validate-ScormPackage.ps1` differs only by a BOM
  and is pure ASCII, so it is safe on Windows PowerShell 5.1.
- Doc 07's inventory adds up (29 + 4 + 14 + 49 = 96 files) and matches the standard 2004 schema set.
- The validation report's counts are internally consistent (19 checks per 2004 zip, 16 per 1.2 zip),
  and its Whistleblowing identifier-collision finding is correct.
- Manifest templates are well-formed; the item-level `imsss:sequencing` placement is valid.

## What was done about it

The tool in this repository fixes 2, 3, 5, 6, 7, 8, 9, 14, 15 and 16, with regression tests for each in
`tests/`. Findings 1, 4, 10, 11, 12, 13, 17, 18 and 19 are documentation decisions for the kit owner.
For 4 and 13 the tool follows the template and doc 01 (no masteryscore, progress in score for
status-based courses) and uses `--scored` to switch progress out of the score fields.
