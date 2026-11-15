// Vercel Function: POST /api/convert
// multipart/form-data: kind, options (JSON), file, captions (optional .vtt)
// 200 -> application/zip (delivery bundle) + X-Scorm-Result header (base64 JSON summary)
// 4xx -> application/json { error }
import { convert, ConvertError, KINDS, extOf } from '../public/engine/build.js';
import { fitsServer, ZIP_LIMITS_SERVER, SERVER_LIMIT } from '../public/engine/limits.js';

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function POST(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > SERVER_LIMIT + 64 * 1024) return json(413, { error: 'File too large for server conversion.', fallback: 'browser' });
  if (!(request.headers.get('content-type') || '').startsWith('multipart/form-data')) return json(415, { error: 'Send the file as multipart/form-data.' });

  let form;
  try { form = await request.formData(); } catch { return json(400, { error: 'Could not read the upload.' }); }
  const kind = String(form.get('kind') || '');
  const file = form.get('file');
  const captions = form.get('captions');
  let options = {};
  try { options = JSON.parse(String(form.get('options') || '{}')); } catch { return json(400, { error: 'Options must be JSON.' }); }
  if (!KINDS[kind]) return json(400, { error: 'Choose a file type: html, video, audio or pdf.' });
  if (!file || typeof file === 'string') return json(400, { error: 'No file was uploaded.' });
  if (!KINDS[kind].ext.includes(extOf(file.name))) return json(400, { error: `${file.name} is not a ${KINDS[kind].label} file.` });
  const versions = Array.isArray(options.versions) && options.versions.length ? options.versions.length : 2;
  if (!fitsServer(file.size + (captions && typeof captions !== 'string' ? captions.size : 0), versions)) {
    return json(413, { error: 'File too large for server conversion.', fallback: 'browser' });
  }

  try {
    const result = await convert({
      kind,
      file: { name: file.name, data: new Uint8Array(await file.arrayBuffer()) },
      captions: captions && typeof captions !== 'string' ? { name: captions.name, data: new Uint8Array(await captions.arrayBuffer()) } : null,
      options,
      limits: ZIP_LIMITS_SERVER,
    });
    const summary = {
      title: result.title, kind: result.kind, warnings: result.warnings, bundle: result.bundle.filename,
      packages: result.packages.map(p => ({ version: p.version, filename: p.filename, size: p.bytes.length,
        verdict: p.validation.verdict, pass: p.validation.pass, warn: p.validation.warn, fail: p.validation.fail })),
    };
    return new Response(result.bundle.bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${result.bundle.filename.replace(/[^\w.-]/g, '_')}"`,
        'X-Scorm-Result': Buffer.from(JSON.stringify(summary)).toString('base64'),
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof ConvertError || /zip|entries|expands|encrypted|compression/i.test(e.message)) return json(422, { error: e.message });
    console.error('convert failed', e);
    return json(500, { error: 'Conversion failed on the server. Try again, or convert in your browser.', fallback: 'browser' });
  }
}

export function GET() {
  return json(405, { error: 'Use POST with multipart/form-data.' });
}
