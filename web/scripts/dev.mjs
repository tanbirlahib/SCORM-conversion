// Local dev server mirroring Vercel: static files from public/, functions from api/.
// Run: node scripts/dev.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const vercel = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
const globalHeaders = vercel.headers.find(h => h.source === '/(.*)').headers;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const port = Number(process.argv[2] || process.env.PORT || 3000);

createServer(async (req, res) => {
  for (const h of globalHeaders) res.setHeader(h.key, h.value);
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, '');
      const mod = await import(pathToFileURL(join(root, 'api', `${name}.js`)).href).catch(() => null);
      const fn = mod?.[req.method];
      if (!fn) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"Not found"}'); }
      const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Readable.toWeb(req), duplex: 'half' });
      const response = await fn(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    let p = normalize(join(pub, decodeURIComponent(url.pathname)));
    if (!p.startsWith(pub)) { res.writeHead(403); return res.end(); }
    if ((await stat(p).catch(() => null))?.isDirectory()) p = join(p, 'index.html');
    const data = await readFile(p);
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(e);
    res.writeHead(e.code === 'ENOENT' ? 404 : 500); res.end(e.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
}).listen(port, () => console.log(`SCORM Converter dev server: http://localhost:${port}`));
