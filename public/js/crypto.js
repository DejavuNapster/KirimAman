/*
 * Enkripsi end-to-end KirimAman (berjalan di browser, juga bisa di Node 18+).
 *
 * - Setiap kiriman memakai satu kunci AES-256-GCM acak yang dibuat di browser.
 * - Kunci ditaruh di fragment tautan (#...), yang tidak pernah dikirim ke server.
 * - File dipotong per 4 MiB; tiap potongan dienkripsi dengan IV unik
 *   (nomor file + nomor potongan) dan penanda "potongan terakhir" sebagai AAD,
 *   sehingga potongan tidak bisa ditukar, diulang, atau dipotong diam-diam.
 * - Nama file, ukuran, dan pesan disimpan dalam manifest yang juga terenkripsi.
 */
(function (root) {
  'use strict';

  const CHUNK_SIZE = 4 * 1024 * 1024;
  const TAG_SIZE = 16;
  const ENC_CHUNK = CHUNK_SIZE + TAG_SIZE;
  const MANIFEST_INDEX = 0xffffffff;
  const subtle = root.crypto.subtle;

  function b64uEncode(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64uDecode(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function iv(fileIndex, chunkIndex) {
    const b = new Uint8Array(12);
    const v = new DataView(b.buffer);
    v.setUint32(0, fileIndex >>> 0);
    v.setUint32(4, 0x4b41); // penanda versi "KA"
    v.setUint32(8, chunkIndex >>> 0);
    return b;
  }

  const aad = (isLast) => new Uint8Array([isLast ? 1 : 0]);
  const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK_SIZE));
  const encSize = (size) => size + chunkCount(size) * TAG_SIZE;

  async function generateKey() {
    return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  async function exportKey(key) {
    return b64uEncode(await subtle.exportKey('raw', key));
  }

  async function importKey(str) {
    const raw = b64uDecode(str);
    if (raw.length !== 32) throw new Error('Kunci tidak valid');
    return subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  }

  async function encryptChunk(key, fileIndex, chunkIndex, isLast, data) {
    const out = await subtle.encrypt(
      { name: 'AES-GCM', iv: iv(fileIndex, chunkIndex), additionalData: aad(isLast) },
      key,
      data,
    );
    return new Uint8Array(out);
  }

  async function decryptChunk(key, fileIndex, chunkIndex, isLast, data) {
    const out = await subtle.decrypt(
      { name: 'AES-GCM', iv: iv(fileIndex, chunkIndex), additionalData: aad(isLast) },
      key,
      data,
    );
    return new Uint8Array(out);
  }

  async function encryptManifest(key, obj) {
    const data = new TextEncoder().encode(JSON.stringify(obj));
    return b64uEncode(await encryptChunk(key, MANIFEST_INDEX, 0, true, data));
  }

  async function decryptManifest(key, str) {
    const data = await decryptChunk(key, MANIFEST_INDEX, 0, true, b64uDecode(str));
    return JSON.parse(new TextDecoder().decode(data));
  }

  root.KACrypto = {
    CHUNK_SIZE,
    TAG_SIZE,
    ENC_CHUNK,
    chunkCount,
    encSize,
    generateKey,
    exportKey,
    importKey,
    encryptChunk,
    decryptChunk,
    encryptManifest,
    decryptManifest,
  };
})(typeof window !== 'undefined' ? window : globalThis);
