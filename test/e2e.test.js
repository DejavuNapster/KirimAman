'use strict';
// Uji ujung-ke-ujung: enkripsi → unggah → selesai → ambil → dekripsi → cocokkan.
// Jalankan: npm test

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kirimaman-test-'));
process.env.DATA_DIR = tmp;
process.env.MAX_BYTES = String(20 * 1024 * 1024);
process.env.RATE_LIMIT_PER_HOUR = '1000';

const { createServer } = require('../server');
require('../public/js/crypto.js');
const C = globalThis.KACrypto;

let base;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['✓', name]);
  } catch (err) {
    results.push(['✗', name + ' — ' + err.message]);
    process.exitCode = 1;
  }
}

async function j(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function sendFiles(buffers, note = 'Halo!') {
  const key = await C.generateKey();
  const keyStr = await C.exportKey(key);
  const manifest = await C.encryptManifest(key, {
    v: 1,
    note,
    files: buffers.map((b, i) => ({ name: `folder/file-${i}.bin`, size: b.length, type: '' })),
  });
  const created = await j('POST', '/api/transfers', { files: buffers.map((b) => ({ encSize: C.encSize(b.length) })), manifest });
  assert.strictEqual(created.status, 201, JSON.stringify(created.data));
  const { id, token } = created.data;
  for (let fi = 0; fi < buffers.length; fi++) {
    const buf = buffers[fi];
    const chunks = C.chunkCount(buf.length);
    for (let ci = 0; ci < chunks; ci++) {
      const plain = buf.subarray(ci * C.CHUNK_SIZE, Math.min(buf.length, (ci + 1) * C.CHUNK_SIZE));
      const enc = await C.encryptChunk(key, fi, ci, ci === chunks - 1, plain);
      const res = await fetch(`${base}/api/transfers/${id}/files/${fi}/chunks/${ci}`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token },
        body: enc,
      });
      assert.strictEqual(res.status, 200, await res.text());
    }
  }
  const fin = await j('POST', `/api/transfers/${id}/complete`, {}, { Authorization: 'Bearer ' + token });
  assert.strictEqual(fin.status, 200, JSON.stringify(fin.data));
  return { id, token, keyStr };
}

async function receive(id, keyStr) {
  const info = await j('GET', `/api/transfers/${id}`);
  assert.strictEqual(info.status, 200);
  const key = await C.importKey(keyStr);
  const manifest = await C.decryptManifest(key, info.data.manifest);
  const out = [];
  for (let fi = 0; fi < manifest.files.length; fi++) {
    const size = manifest.files[fi].size;
    const encSize = info.data.files[fi].encSize;
    const chunks = C.chunkCount(size);
    const parts = [];
    for (let ci = 0; ci < chunks; ci++) {
      const start = ci * C.ENC_CHUNK;
      const end = Math.min(encSize, start + C.ENC_CHUNK) - 1;
      const res = await fetch(`${base}/api/transfers/${id}/files/${fi}`, { headers: { Range: `bytes=${start}-${end}` } });
      assert.strictEqual(res.status, 206);
      const enc = new Uint8Array(await res.arrayBuffer());
      parts.push(await C.decryptChunk(key, fi, ci, ci === chunks - 1, enc));
    }
    out.push(Buffer.concat(parts));
  }
  return { manifest, files: out };
}

(async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const sizes = [0, 1, 1000, C.CHUNK_SIZE, C.CHUNK_SIZE + 1, 2 * C.CHUNK_SIZE + 12345];
  const buffers = sizes.map((s) => crypto.randomBytes(s));
  let sent;

  await test('kirim & terima 6 file (0 B – 8,0 MB) utuh, byte demi byte', async () => {
    sent = await sendFiles(buffers);
    const got = await receive(sent.id, sent.keyStr);
    assert.strictEqual(got.manifest.note, 'Halo!');
    assert.strictEqual(got.manifest.files[0].name, 'folder/file-0.bin');
    got.files.forEach((b, i) => assert.ok(b.equals(buffers[i]), `file ${i} berbeda`));
  });

  await test('server hanya menyimpan data terenkripsi (tak ada teks asli di disk)', async () => {
    const stored = fs.readFileSync(path.join(tmp, sent.id, 'file-2.bin'));
    assert.strictEqual(stored.length, 1000 + 16);
    assert.ok(!stored.subarray(0, 1000).equals(buffers[2]));
    const meta = fs.readFileSync(path.join(tmp, sent.id, 'meta.json'), 'utf8');
    assert.ok(!meta.includes('file-0.bin') && !meta.includes('Halo'), 'nama file/pesan bocor di meta');
  });

  await test('kunci salah tidak bisa membuka manifest', async () => {
    const other = await C.exportKey(await C.generateKey());
    await assert.rejects(receive(sent.id, other));
  });

  await test('potongan yang diubah ditolak saat dekripsi', async () => {
    const p = path.join(tmp, sent.id, 'file-2.bin');
    const orig = fs.readFileSync(p);
    const bad = Buffer.from(orig);
    bad[10] ^= 0xff;
    fs.writeFileSync(p, bad);
    await assert.rejects(receive(sent.id, sent.keyStr));
    fs.writeFileSync(p, orig);
  });

  await test('token unggah salah ditolak (403) dan kiriman selesai tak bisa diubah', async () => {
    const res = await fetch(`${base}/api/transfers/${sent.id}/files/0/chunks/0`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer salah' },
      body: new Uint8Array(16),
    });
    assert.strictEqual(res.status, 403);
    const res2 = await fetch(`${base}/api/transfers/${sent.id}/files/0/chunks/0`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + sent.token },
      body: new Uint8Array(16),
    });
    assert.strictEqual(res2.status, 409);
  });

  await test('kiriman yang belum selesai tidak bisa diunduh, potongan loncat ditolak', async () => {
    const key = await C.generateKey();
    const manifest = await C.encryptManifest(key, { v: 1, files: [{ name: 'a', size: C.CHUNK_SIZE * 2 }] });
    const cr = await j('POST', '/api/transfers', { files: [{ encSize: C.encSize(C.CHUNK_SIZE * 2) }], manifest });
    assert.strictEqual((await j('GET', `/api/transfers/${cr.data.id}`)).status, 404);
    const res = await fetch(`${base}/api/transfers/${cr.data.id}/files/0/chunks/1`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + cr.data.token },
      body: new Uint8Array(C.ENC_CHUNK),
    });
    assert.strictEqual(res.status, 409);
    const fin = await j('POST', `/api/transfers/${cr.data.id}/complete`, {}, { Authorization: 'Bearer ' + cr.data.token });
    assert.strictEqual(fin.status, 409);
  });

  await test('melebihi batas ukuran ditolak (413)', async () => {
    const r = await j('POST', '/api/transfers', { files: [{ encSize: C.encSize(21 * 1024 * 1024) }], manifest: 'abc' });
    assert.strictEqual(r.status, 413);
  });

  await test('email ditolak bila SMTP belum diatur', async () => {
    const r = await j('POST', '/api/transfers', {
      files: [{ encSize: C.encSize(5) }],
      manifest: 'abc',
      email: { to: ['a@b.co'], from: 'c@d.co' },
    });
    assert.strictEqual(r.status, 400);
  });

  await test('tautan kedaluwarsa memberi 404 dan dibersihkan', async () => {
    const metaFile = path.join(tmp, sent.id, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.expiresAt = Date.now() - 1000;
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    // server menyimpan cache meta; buat server baru agar membaca ulang dari disk
    delete require.cache[require.resolve('../server')];
    const fresh = require('../server').createServer();
    await new Promise((r) => fresh.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${fresh.address().port}/api/transfers/${sent.id}`);
    assert.strictEqual(res.status, 404);
    fresh.close();
  });

  await test('versi aplikasi tersedia di /api/config dan sama dengan package.json', async () => {
    const { version } = require('../package.json');
    const r = await j('GET', '/api/config');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.version, version);
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('data-version'), 'footer belum punya tempat versi');
  });

  await test('halaman & berkas statis tersaji dengan header keamanan', async () => {
    for (const p of ['/', `/d/${sent.id}`, '/js/send.js', '/js/download.js', '/css/style.css', '/favicon.svg']) {
      const res = await fetch(base + p);
      assert.strictEqual(res.status, 200, p);
      if (p === '/' || p.startsWith('/d/')) assert.ok(res.headers.get('content-security-policy'));
    }
    const trav = await fetch(base + '/..%2fserver.js');
    assert.notStrictEqual(trav.status, 200);
  });

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [mark, name] of results) console.log(mark, name);
  console.log(process.exitCode ? '\nADA UJI YANG GAGAL' : `\nSemua ${results.length} uji lulus`);
})();
