'use strict';

/*
 * KirimAman — server kirim file terenkripsi end-to-end.
 *
 * Server hanya menyimpan data yang SUDAH dienkripsi di browser pengirim.
 * Kunci dekripsi ada di bagian "#..." (fragment) tautan, yang tidak pernah
 * dikirim browser ke server. Tanpa dependensi wajib; nodemailer opsional
 * untuk fitur kirim lewat email.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// Muat .env sederhana (KEY=VALUE) bila ada, tanpa menimpa variabel yang sudah diset.
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
} catch {
  /* tidak ada .env */
}

// ---------------------------------------------------------------- konfigurasi
const CONFIG = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  maxBytes: int(process.env.MAX_BYTES, 5 * 1024 ** 3), // 5 GB per kiriman
  maxFiles: int(process.env.MAX_FILES, 100),
  expiryDays: num(process.env.EXPIRY_DAYS, 15),
  maxRecipients: int(process.env.MAX_RECIPIENTS, 50),
  rateLimitPerHour: int(process.env.RATE_LIMIT_PER_HOUR, 30),
  incompleteTtlHours: num(process.env.INCOMPLETE_TTL_HOURS, 24),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  trustProxy: process.env.TRUST_PROXY === '1',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: process.env.SMTP_SECURE === '1',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  },
};

// Harus sama dengan public/js/crypto.js
const CHUNK_SIZE = 4 * 1024 * 1024; // ukuran potongan teks asli
const TAG_SIZE = 16; // tag autentikasi AES-GCM
const ENC_CHUNK = CHUNK_SIZE + TAG_SIZE;
const MAX_MANIFEST_BYTES = 512 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function num(v, d) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

// ------------------------------------------------------------- email (opsional)
let mailer = null;
if (CONFIG.smtp.host) {
  try {
    const nodemailer = require('nodemailer');
    mailer = nodemailer.createTransport({
      host: CONFIG.smtp.host,
      port: CONFIG.smtp.port,
      secure: CONFIG.smtp.secure,
      auth: CONFIG.smtp.user ? { user: CONFIG.smtp.user, pass: CONFIG.smtp.pass } : undefined,
    });
  } catch (err) {
    console.warn('[email] SMTP_HOST diisi tetapi paket "nodemailer" belum terpasang. Jalankan: npm install');
  }
}
const emailEnabled = () => Boolean(mailer && CONFIG.smtp.from);

// ------------------------------------------------------------------- utilitas
const encSizeOf = (plain) => plain + Math.max(1, Math.ceil(plain / CHUNK_SIZE)) * TAG_SIZE;
function plainSizeOf(enc) {
  const chunks = Math.max(1, Math.ceil(enc / ENC_CHUNK));
  return enc - chunks * TAG_SIZE;
}
const newId = () => crypto.randomBytes(16).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tDir = (id) => path.join(CONFIG.dataDir, id);
const metaPath = (id) => path.join(tDir(id), 'meta.json');
const filePath = (id, i) => path.join(tDir(id), `file-${i}.bin`);
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Data terlalu besar.'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = MAX_MANIFEST_BYTES * 2) {
  const buf = await readBody(req, limit);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Format JSON tidak valid.');
  }
}

function clientIp(req) {
  if (CONFIG.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Pembatas laju sederhana di memori: maksimal N kiriman baru per IP per jam.
const rate = new Map();
function checkRate(ip) {
  const now = Date.now();
  const list = (rate.get(ip) || []).filter((t) => now - t < 3600_000);
  if (list.length >= CONFIG.rateLimitPerHour) {
    throw new HttpError(429, 'Terlalu banyak kiriman dari jaringan Anda. Coba lagi nanti.');
  }
  list.push(now);
  rate.set(ip, list);
}

// ---------------------------------------------------------- penyimpanan meta
const metaCache = new Map();
const locks = new Map();

async function loadMeta(id) {
  if (!ID_RE.test(id)) return null;
  if (metaCache.has(id)) return metaCache.get(id);
  try {
    const meta = JSON.parse(await fsp.readFile(metaPath(id), 'utf8'));
    metaCache.set(id, meta);
    return meta;
  } catch {
    return null;
  }
}

async function saveMeta(meta) {
  metaCache.set(meta.id, meta);
  const tmp = metaPath(meta.id) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(meta));
  await fsp.rename(tmp, metaPath(meta.id));
}

// Menjalankan operasi per kiriman satu per satu agar meta tidak saling timpa.
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(id, next.catch(() => {}));
  return next;
}

async function removeTransfer(id) {
  metaCache.delete(id);
  await fsp.rm(tDir(id), { recursive: true, force: true });
}

const isExpired = (meta) => Date.now() > meta.expiresAt;

function requireUploader(meta, req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!meta || !token || sha256(token) !== meta.tokenHash) {
    throw new HttpError(403, 'Tidak diizinkan.');
  }
  if (meta.complete) throw new HttpError(409, 'Kiriman sudah selesai.');
  if (Date.now() - meta.createdAt > CONFIG.incompleteTtlHours * 3600_000) {
    throw new HttpError(410, 'Sesi unggah sudah kedaluwarsa.');
  }
}

// ----------------------------------------------------------------- handler API
async function getConfig(req, res) {
  send(res, 200, {
    maxBytes: CONFIG.maxBytes,
    maxFiles: CONFIG.maxFiles,
    expiryDays: CONFIG.expiryDays,
    maxRecipients: CONFIG.maxRecipients,
    chunkSize: CHUNK_SIZE,
    emailEnabled: emailEnabled(),
  });
}

async function createTransfer(req, res) {
  const body = await readJson(req);
  const files = Array.isArray(body.files) ? body.files : null;
  const manifest = typeof body.manifest === 'string' ? body.manifest : '';

  if (!files || files.length === 0) throw new HttpError(400, 'Tidak ada file.');
  if (files.length > CONFIG.maxFiles) {
    throw new HttpError(400, `Maksimal ${CONFIG.maxFiles} file per kiriman.`);
  }
  let total = 0;
  const encSizes = files.map((f) => {
    const s = Number(f && f.encSize);
    if (!Number.isSafeInteger(s) || s < TAG_SIZE) throw new HttpError(400, 'Ukuran file tidak valid.');
    const plain = plainSizeOf(s);
    if (plain < 0 || encSizeOf(plain) !== s) throw new HttpError(400, 'Ukuran file tidak valid.');
    total += plain;
    return s;
  });
  if (total > CONFIG.maxBytes) throw new HttpError(413, 'Total ukuran melebihi batas.');
  if (!manifest || manifest.length > MAX_MANIFEST_BYTES || !/^[A-Za-z0-9_-]+$/.test(manifest)) {
    throw new HttpError(400, 'Manifest tidak valid.');
  }

  let email = null;
  if (body.email) {
    if (!emailEnabled()) throw new HttpError(400, 'Fitur email belum diaktifkan di server ini.');
    const to = Array.isArray(body.email.to) ? body.email.to.map((x) => String(x).trim()) : [];
    const from = String(body.email.from || '').trim();
    const message = String(body.email.message || '').slice(0, 1000);
    if (to.length === 0 || to.length > CONFIG.maxRecipients) {
      throw new HttpError(400, `Isi 1–${CONFIG.maxRecipients} email penerima.`);
    }
    if (![...to, from].every((e) => EMAIL_RE.test(e) && e.length <= 254)) {
      throw new HttpError(400, 'Ada alamat email yang tidak valid.');
    }
    email = { to: [...new Set(to)], from, message };
  }

  checkRate(clientIp(req));

  const id = newId();
  const token = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const meta = {
    id,
    createdAt: now,
    expiresAt: now + CONFIG.expiryDays * 86400_000,
    tokenHash: sha256(token),
    complete: false,
    totalPlain: total,
    files: encSizes.map((encSize) => ({ encSize, received: 0 })),
    manifest,
    email,
  };
  await fsp.mkdir(tDir(id), { recursive: true });
  for (let i = 0; i < encSizes.length; i++) await fsp.writeFile(filePath(id, i), '');
  await saveMeta(meta);
  send(res, 201, { id, token, chunkSize: CHUNK_SIZE });
}

async function uploadChunk(req, res, id, fi, ci) {
  const meta = await loadMeta(id);
  if (!meta) throw new HttpError(404, 'Kiriman tidak ditemukan.');
  requireUploader(meta, req);
  const file = meta.files[fi];
  if (!file) throw new HttpError(404, 'File tidak ditemukan.');

  const offset = ci * ENC_CHUNK;
  if (!Number.isSafeInteger(offset) || offset >= file.encSize) throw new HttpError(400, 'Nomor potongan tidak valid.');
  const expected = Math.min(ENC_CHUNK, file.encSize - offset);
  const buf = await readBody(req, ENC_CHUNK);
  if (buf.length !== expected) throw new HttpError(400, 'Ukuran potongan tidak sesuai.');

  await withLock(id, async () => {
    if (offset > file.received) throw new HttpError(409, 'Potongan sebelumnya belum diterima.');
    const fh = await fsp.open(filePath(id, fi), 'r+');
    try {
      await fh.write(buf, 0, buf.length, offset);
    } finally {
      await fh.close();
    }
    file.received = Math.max(file.received, offset + buf.length);
    await saveMeta(meta);
  });
  send(res, 200, { received: file.received });
}

async function completeTransfer(req, res, id) {
  const meta = await loadMeta(id);
  if (!meta) throw new HttpError(404, 'Kiriman tidak ditemukan.');
  requireUploader(meta, req);
  const body = await readJson(req, 16 * 1024);
  if (!meta.files.every((f) => f.received === f.encSize)) {
    throw new HttpError(409, 'Masih ada file yang belum selesai diunggah.');
  }

  let emailed = 0;
  if (meta.email) {
    const link = String(body.link || '');
    let ok = false;
    try {
      const u = new URL(link);
      ok = /^https?:$/.test(u.protocol) && u.pathname === `/d/${id}` && u.hash.length > 10;
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(400, 'Tautan untuk email tidak valid.');
    try {
      await sendEmails(meta, link);
    } catch (err) {
      console.error('[email]', err.message);
      throw new HttpError(502, 'Email gagal dikirim. Periksa alamat penerima atau coba lagi.');
    }
    emailed = meta.email.to.length;
  }

  await withLock(id, async () => {
    meta.complete = true;
    meta.completedAt = Date.now();
    meta.email = meta.email ? { count: meta.email.to.length } : null; // jangan simpan alamat lebih lama
    await saveMeta(meta);
  });
  send(res, 200, { expiresAt: meta.expiresAt, emailed });
}

async function sendEmails(meta, link) {
  const { to, from, message } = meta.email;
  const expires = new Date(meta.expiresAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  const sizeTxt = formatBytes(meta.totalPlain);
  const count = meta.files.length;
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const text =
    `${from} mengirimkan ${count} file (${sizeTxt}) untuk Anda lewat KirimAman.\n\n` +
    (message ? `Pesan:\n${message}\n\n` : '') +
    `Unduh di sini:\n${link}\n\nTautan berlaku sampai ${expires}.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#1c1b22">
<h2 style="margin:0 0 8px">Ada file untuk Anda</h2>
<p><b>${esc(from)}</b> mengirimkan ${count} file (${sizeTxt}) lewat KirimAman.</p>
${message ? `<blockquote style="border-left:3px solid #e8603c;margin:16px 0;padding:4px 12px;color:#444">${esc(message).replace(/\n/g, '<br>')}</blockquote>` : ''}
<p><a href="${esc(link)}" style="display:inline-block;background:#1c1b22;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">Unduh file</a></p>
<p style="color:#666;font-size:13px">Tautan berlaku sampai ${expires}. File dienkripsi end-to-end.</p></div>`;
  // Satu email per penerima: alamat penerima lain tidak terlihat dan lebih jarang dianggap spam.
  for (const recipient of to) {
    await mailer.sendMail({
      from: CONFIG.smtp.from,
      replyTo: from,
      to: recipient,
      subject: `${from} mengirimkan file untuk Anda`,
      text,
      html,
    });
  }
}

async function getTransfer(req, res, id) {
  const meta = await loadMeta(id);
  if (!meta || !meta.complete || isExpired(meta)) throw new HttpError(404, 'Tautan tidak ditemukan atau sudah kedaluwarsa.');
  send(res, 200, {
    id,
    expiresAt: meta.expiresAt,
    manifest: meta.manifest,
    files: meta.files.map((f) => ({ encSize: f.encSize })),
    chunkSize: CHUNK_SIZE,
  });
}

async function downloadFile(req, res, id, fi) {
  const meta = await loadMeta(id);
  if (!meta || !meta.complete || isExpired(meta)) throw new HttpError(404, 'Tautan tidak ditemukan atau sudah kedaluwarsa.');
  const file = meta.files[fi];
  if (!file) throw new HttpError(404, 'File tidak ditemukan.');

  const size = file.encSize;
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) throw new HttpError(416, 'Range tidak valid.');
    start = parseInt(m[1], 10);
    end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath(id, fi), { start, end }).pipe(res);
}

// ------------------------------------------------------------ berkas statis
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (/^\/d\/[A-Za-z0-9_-]+\/?$/.test(pathname)) rel = '/download.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Tidak ditemukan.');
  let data;
  try {
    data = await fsp.readFile(full);
  } catch {
    const notFound = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html')).catch(() => null);
    if (notFound && !path.extname(rel)) {
      res.writeHead(404, { 'Content-Type': MIME['.html'], ...SECURITY_HEADERS });
      return res.end(notFound);
    }
    throw new HttpError(404, 'Tidak ditemukan.');
  }
  const ext = path.extname(full);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    ...SECURITY_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

// --------------------------------------------------------------------- router
async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const m = req.method;
  let r;

  if (p === '/api/config' && m === 'GET') return getConfig(req, res);
  if (p === '/api/transfers' && m === 'POST') return createTransfer(req, res);
  if ((r = /^\/api\/transfers\/([A-Za-z0-9_-]{22})\/files\/(\d{1,4})\/chunks\/(\d{1,7})$/.exec(p)) && m === 'PUT') {
    return uploadChunk(req, res, r[1], +r[2], +r[3]);
  }
  if ((r = /^\/api\/transfers\/([A-Za-z0-9_-]{22})\/complete$/.exec(p)) && m === 'POST') {
    return completeTransfer(req, res, r[1]);
  }
  if ((r = /^\/api\/transfers\/([A-Za-z0-9_-]{22})$/.exec(p)) && m === 'GET') return getTransfer(req, res, r[1]);
  if ((r = /^\/api\/transfers\/([A-Za-z0-9_-]{22})\/files\/(\d{1,4})$/.exec(p)) && (m === 'GET' || m === 'HEAD')) {
    return downloadFile(req, res, r[1], +r[2]);
  }
  if (p.startsWith('/api/')) throw new HttpError(404, 'Endpoint tidak ditemukan.');
  if (m === 'GET' || m === 'HEAD') return serveStatic(req, res, p);
  throw new HttpError(405, 'Metode tidak didukung.');
}

// ----------------------------------------------------------------- pembersihan
async function cleanup() {
  let entries = [];
  try {
    entries = await fsp.readdir(CONFIG.dataDir);
  } catch {
    return;
  }
  let removed = 0;
  for (const id of entries) {
    if (!ID_RE.test(id)) continue;
    const meta = await loadMeta(id);
    const stale =
      !meta ||
      isExpired(meta) ||
      (!meta.complete && Date.now() - meta.createdAt > CONFIG.incompleteTtlHours * 3600_000);
    if (stale) {
      await removeTransfer(id);
      removed++;
    } else {
      metaCache.delete(id); // jaga cache tetap kecil
    }
  }
  if (removed) console.log(`[cleanup] ${removed} kiriman kedaluwarsa dihapus`);
}

function formatBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`;
}

// ------------------------------------------------------------------- start up
function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Terjadi kesalahan di server.' : err.message });
      else res.destroy();
    });
  });
}

if (require.main === module) {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  const server = createServer();
  server.requestTimeout = 0; // unggahan besar butuh waktu
  server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`KirimAman berjalan di http://localhost:${CONFIG.port}`);
    console.log(`Data disimpan di ${CONFIG.dataDir} · batas ${formatBytes(CONFIG.maxBytes)} · kedaluwarsa ${CONFIG.expiryDays} hari`);
    console.log(`Kirim lewat email: ${emailEnabled() ? 'aktif' : 'nonaktif (isi SMTP_* untuk mengaktifkan)'}`);
  });
  cleanup();
  setInterval(cleanup, 3600_000).unref();
}

module.exports = { createServer, CONFIG, CHUNK_SIZE, TAG_SIZE };
