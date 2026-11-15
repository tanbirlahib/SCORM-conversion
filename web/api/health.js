// Vercel Function: GET /api/health -> service status and limits (used by the page and monitoring).
import { SERVER_LIMIT } from '../public/engine/limits.js';

export function GET() {
  return new Response(JSON.stringify({ ok: true, service: 'scorm-converter', serverLimitBytes: SERVER_LIMIT }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
