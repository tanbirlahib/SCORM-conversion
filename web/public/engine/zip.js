// Minimal ZIP writer/reader with no dependencies. Works in browsers and Node 18+
// (uses the standard CompressionStream / DecompressionStream 'deflate-raw').

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
const deflate = bytes => pipe(bytes, new CompressionStream('deflate-raw'));
const inflate = bytes => pipe(bytes, new DecompressionStream('deflate-raw'));

const enc = new TextEncoder();
export const toBytes = d => (typeof d === 'string' ? enc.encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d));

// Already-compressed media gain nothing from deflate; store them.
const STORE = /\.(mp4|m4v|webm|ogv|mov|mp3|m4a|aac|ogg|oga|wav|pdf|png|jpe?g|gif|webp|zip|woff2?)$/i;

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** entries: [{ name, data }] in order. Names always use forward slashes. Returns Uint8Array. */
export async function writeZip(entries) {
  const { time, date } = dosDateTime();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name.replace(/\\/g, '/'));
    const raw = toBytes(e.data);
    const crc = crc32(raw);
    let method = 0, body = raw;
    if (!STORE.test(e.name) && raw.length > 64) {
      const d = await deflate(raw);
      if (d.length < raw.length) { method = 8; body = d; }
    }
    if (raw.length > 0xfffffffe || offset > 0xfffffffe) throw new Error('package larger than 4 GB is not supported');
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
    local.setUint32(14, crc, true); local.setUint32(18, body.length, true); local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true); cd.setUint16(10, method, true); cd.setUint16(12, time, true);
    cd.setUint16(14, date, true); cd.setUint32(16, crc, true); cd.setUint32(20, body.length, true);
    cd.setUint32(24, raw.length, true); cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return concat([...parts, ...central, new Uint8Array(end.buffer)]);
}

export function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Reads a ZIP into [{ name, data }] (files only). Guards against zip bombs and
 * unsafe paths. limits: { maxEntries, maxTotal } in entries / bytes uncompressed.
 */
export async function readZip(bytes, limits = {}) {
  const maxEntries = limits.maxEntries ?? 5000, maxTotal = limits.maxTotal ?? 500 * 1024 * 1024;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a valid zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count > maxEntries) throw new Error(`zip has ${count} entries (limit ${maxEntries})`);
  const dec = new TextDecoder();
  const out = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip directory');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('encrypted zip files are not supported');
    total += usize;
    if (total > maxTotal) throw new Error(`zip expands to more than ${Math.round(maxTotal / 1048576)} MB`);
    const lnlen = dv.getUint16(loc + 26, true), lxlen = dv.getUint16(loc + 28, true);
    const start = loc + 30 + lnlen + lxlen;
    const body = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = body.slice();
    else if (method === 8) data = await inflate(body);
    else throw new Error(`unsupported compression method ${method} in ${name}`);
    if (data.length !== usize) throw new Error(`size mismatch in ${name}`);
    out.push({ name, data });
  }
  return out;
}
