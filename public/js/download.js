(function () {
  'use strict';

  const { formatBytes, formatDate, toast, api, el, iconNode } = window.KA;
  const C = window.KACrypto;
  const $ = (id) => document.getElementById(id);

  const id = (location.pathname.match(/^\/d\/([A-Za-z0-9_-]+)/) || [])[1];
  const keyStr = location.hash.slice(1);
  let transfer = null;
  let key = null;
  let manifest = null;
  let busy = false;

  function fail(title, detail) {
    $('failTitle').textContent = title;
    $('failDetail').textContent = detail;
    show('failed');
  }
  function show(name) {
    ['loading', 'ready', 'failed'].forEach((s) => ($(s).hidden = s !== name));
  }

  async function init() {
    if (!id) return fail('Tautan tidak valid', 'Alamat tautan ini tidak dikenali.');
    if (!keyStr) {
      return fail('Tautan tidak lengkap', 'Bagian kunci (setelah tanda #) hilang. Minta pengirim membagikan ulang tautan lengkapnya.');
    }
    try {
      transfer = await api('/api/transfers/' + id);
    } catch (err) {
      if (err.status === 404) {
        return fail('Tautan sudah kedaluwarsa', 'File di tautan ini sudah dihapus atau tautannya salah. Minta pengirim mengirim ulang.');
      }
      return fail('Tidak bisa terhubung', err.message);
    }
    try {
      key = await C.importKey(keyStr);
      manifest = await C.decryptManifest(key, transfer.manifest);
    } catch (_) {
      return fail('Kunci tidak cocok', 'Tautan ini tidak lengkap atau sudah diubah, jadi file tidak bisa didekripsi.');
    }
    render();
  }

  function render() {
    const files = manifest.files;
    const total = files.reduce((a, f) => a + f.size, 0);
    $('dlTitle').textContent = files.length === 1 ? baseName(files[0].name) : `${files.length} file`;
    $('dlMeta').textContent = `${formatBytes(total)} · berlaku sampai ${formatDate(transfer.expiresAt)}`;
    if (manifest.note) {
      $('dlNote').textContent = manifest.note;
      $('dlNote').hidden = false;
    }
    $('dlList').replaceChildren(
      ...files.map((f, i) => {
        const slash = f.name.lastIndexOf('/');
        return el('li', { id: 'row-' + i }, [
          iconNode(f.name, f.type),
          el('div', { class: 'fmeta' }, [
            el('span', { class: 'fname', title: f.name, text: baseName(f.name) }),
            el('span', { class: 'fsize', text: formatBytes(f.size) + (slash >= 0 ? ' · ' + f.name.slice(0, slash) : '') }),
            el('span', { class: 'fbar', hidden: '' }, [el('span')]),
          ]),
          el('button', {
            type: 'button',
            class: 'chip',
            text: 'Unduh',
            onclick: () => guarded(() => downloadOne(i)),
          }),
        ]);
      }),
    );
    $('dlAll').hidden = files.length < 2;
    show('ready');
  }

  $('dlAll').addEventListener('click', () => guarded(downloadAll));

  async function guarded(fn) {
    if (busy) return toast('Tunggu unduhan yang sedang berjalan selesai.');
    busy = true;
    try {
      await fn();
    } catch (err) {
      if (err.name !== 'AbortError') toast(err.message || 'Unduhan gagal.', 'error');
    } finally {
      busy = false;
    }
  }

  const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
  const safeName = (p) => baseName(p).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'file';

  async function fetchChunk(fi, ci) {
    const encSize = transfer.files[fi].encSize;
    const start = ci * C.ENC_CHUNK;
    const end = Math.min(encSize, start + C.ENC_CHUNK) - 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`/api/transfers/${id}/files/${fi}`, { headers: { Range: `bytes=${start}-${end}` } });
        if (res.status === 404) throw Object.assign(new Error('Tautan sudah kedaluwarsa.'), { fatal: true });
        if (!res.ok) throw new Error('Gagal mengambil data (' + res.status + ').');
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length !== end - start + 1) throw new Error('Data yang diterima tidak lengkap.');
        return buf;
      } catch (err) {
        if (err.fatal || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 700 * attempt * attempt));
      }
    }
  }

  // Mengambil dan mendekripsi file potong demi potong. Potongan berikutnya
  // sudah diambil sementara potongan sekarang sedang didekripsi.
  async function decryptFile(fi, write) {
    const info = manifest.files[fi];
    const chunks = C.chunkCount(info.size);
    const row = $('row-' + fi);
    const bar = row.querySelector('.fbar');
    bar.hidden = false;
    let next = fetchChunk(fi, 0);
    for (let ci = 0; ci < chunks; ci++) {
      const enc = await next;
      if (ci + 1 < chunks) next = fetchChunk(fi, ci + 1);
      let plain;
      try {
        plain = await C.decryptChunk(key, fi, ci, ci === chunks - 1, enc);
      } catch (_) {
        throw new Error('File rusak atau sudah diubah, dekripsi dibatalkan.');
      }
      await write(plain);
      bar.firstChild.style.width = ((ci + 1) / chunks) * 100 + '%';
    }
    row.classList.add('done');
    row.querySelector('.chip').textContent = 'Terunduh ✓';
  }

  async function downloadOne(fi) {
    const info = manifest.files[fi];
    if (window.showSaveFilePicker) {
      let handle;
      try {
        handle = await window.showSaveFilePicker({ suggestedName: safeName(info.name) });
      } catch (err) {
        if (err.name === 'AbortError') return;
        handle = null; // jatuh ke cara biasa
      }
      if (handle) {
        const w = await handle.createWritable();
        try {
          await decryptFile(fi, (d) => w.write(d));
          await w.close();
        } catch (err) {
          await w.abort().catch(() => {});
          throw err;
        }
        return;
      }
    }
    await downloadAsBlob(fi);
  }

  async function downloadAsBlob(fi) {
    const info = manifest.files[fi];
    const parts = [];
    await decryptFile(fi, (d) => parts.push(d));
    const url = URL.createObjectURL(new Blob(parts, { type: info.type || 'application/octet-stream' }));
    const a = el('a', { href: url, download: safeName(info.name) });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function downloadAll() {
    const files = manifest.files;
    if (window.showDirectoryPicker) {
      let dir = null;
      try {
        dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
      if (dir) {
        for (let i = 0; i < files.length; i++) {
          const segs = files[i].name.split('/').map((s) => s.replace(/[\\:*?"<>|\u0000-\u001f]/g, '_')).filter((s) => s && s !== '.' && s !== '..');
          let target = dir;
          for (const s of segs.slice(0, -1)) target = await target.getDirectoryHandle(s, { create: true });
          const fh = await target.getFileHandle(segs[segs.length - 1] || 'file', { create: true });
          const w = await fh.createWritable();
          try {
            await decryptFile(i, (d) => w.write(d));
            await w.close();
          } catch (err) {
            await w.abort().catch(() => {});
            throw err;
          }
        }
        toast('Semua file tersimpan.', 'ok');
        return;
      }
    }
    for (let i = 0; i < files.length; i++) await downloadAsBlob(i);
    toast('Semua file sudah diunduh.', 'ok');
  }

  init();
})();
