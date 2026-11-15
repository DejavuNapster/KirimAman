(function () {
  'use strict';

  const { formatBytes, formatDate, toast, api, el, iconNode } = window.KA;
  const C = window.KACrypto;
  const $ = (id) => document.getElementById(id);

  const state = {
    items: [], // { file, path }
    mode: 'link',
    recipients: [],
    config: { maxBytes: 5 * 1024 ** 3, maxFiles: 100, expiryDays: 15, maxRecipients: 50, emailEnabled: false },
    uploading: false,
    abort: null,
  };
  const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

  // ------------------------------------------------------------ konfigurasi
  window.KA.config
    .then((cfg) => {
      state.config = cfg;
      document.querySelectorAll('[data-limit]').forEach((n) => (n.textContent = formatBytes(cfg.maxBytes)));
      document.querySelectorAll('[data-maxfiles]').forEach((n) => (n.textContent = cfg.maxFiles));
      document.querySelectorAll('[data-expiry]').forEach((n) => (n.textContent = cfg.expiryDays));
      document.querySelectorAll('[data-maxrcpt]').forEach((n) => (n.textContent = cfg.maxRecipients));
      if (!cfg.emailEnabled) {
        $('modeEmail').disabled = true;
        $('modeEmail').title = 'Fitur email belum diaktifkan di server ini';
      }
      render();
    })
    .catch(() => toast('Tidak bisa terhubung ke server.', 'error'));

  // ------------------------------------------------------------ pilih file
  const dropzone = $('dropzone');
  dropzone.addEventListener('click', () => $('fileInput').click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      $('fileInput').click();
    }
  });
  $('pickFolder').addEventListener('click', (e) => {
    e.stopPropagation();
    $('folderInput').click();
  });
  $('addFiles').addEventListener('click', () => $('fileInput').click());
  $('addFolder').addEventListener('click', () => $('folderInput').click());

  $('fileInput').addEventListener('change', (e) => {
    addItems([...e.target.files].map((f) => ({ file: f, path: f.name })));
    e.target.value = '';
  });
  $('folderInput').addEventListener('change', (e) => {
    addItems([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
    e.target.value = '';
  });

  // Seret-lepas di seluruh halaman, termasuk folder.
  let dragDepth = 0;
  const overlay = $('dragOverlay');
  window.addEventListener('dragenter', (e) => {
    if (state.uploading || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlay.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    if (state.uploading) return;
    addItems(await collectDropped(e.dataTransfer));
  });

  function hasFiles(e) {
    return e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  }

  async function collectDropped(dt) {
    const entries = [...(dt.items || [])]
      .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (!entries.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
    const out = [];
    async function walk(entry, prefix) {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ file, path: prefix + file.name });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const child of batch) await walk(child, prefix + entry.name + '/');
        } while (batch.length);
      }
    }
    for (const entry of entries) await walk(entry, '');
    return out;
  }

  function totalBytes() {
    return state.items.reduce((a, it) => a + it.file.size, 0);
  }

  function addItems(list) {
    if (!list.length) return;
    const seen = new Set(state.items.map((it) => it.path + ':' + it.file.size));
    let skippedLimit = 0;
    let total = totalBytes();
    for (const it of list) {
      const k = it.path + ':' + it.file.size;
      if (seen.has(k)) continue;
      if (state.items.length >= state.config.maxFiles || total + it.file.size > state.config.maxBytes) {
        skippedLimit++;
        continue;
      }
      seen.add(k);
      state.items.push(it);
      total += it.file.size;
    }
    if (skippedLimit) {
      toast(`${skippedLimit} file tidak ditambahkan: batas ${state.config.maxFiles} file atau ${formatBytes(state.config.maxBytes)} terlampaui.`, 'error');
    }
    render();
  }

  // ------------------------------------------------------------- tampilan
  function render() {
    const has = state.items.length > 0;
    dropzone.hidden = has;
    $('filesPanel').hidden = !has;
    $('filesCount').textContent = `${state.items.length} item · ${formatBytes(totalBytes())}`;

    const list = $('fileList');
    list.replaceChildren(
      ...state.items.map((it, idx) => {
        const slash = it.path.lastIndexOf('/');
        return el('li', {}, [
          iconNode(it.file.name, it.file.type),
          el('div', { class: 'fmeta' }, [
            el('span', { class: 'fname', title: it.path, text: slash >= 0 ? it.path.slice(slash + 1) : it.path }),
            el('span', {
              class: 'fsize',
              text: formatBytes(it.file.size) + (slash >= 0 ? ' · ' + it.path.slice(0, slash) : ''),
            }),
          ]),
          el('button', {
            type: 'button',
            class: 'icon-btn',
            'aria-label': 'Hapus ' + it.file.name,
            text: '×',
            onclick: () => {
              state.items.splice(idx, 1);
              render();
            },
          }),
        ]);
      }),
    );

    const pct = Math.min(100, (totalBytes() / state.config.maxBytes) * 100);
    $('usageFill').style.width = pct + '%';
    $('usageText').textContent = `${formatBytes(totalBytes())} dari ${formatBytes(state.config.maxBytes)}`;

    const email = state.mode === 'email';
    $('emailFields').hidden = !email;
    $('noteField').hidden = email;
    $('sendLabel').textContent = email ? 'Kirim file' : 'Buat tautan';
    document.querySelectorAll('.segmented button').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.mode === state.mode));
    });
    $('sendBtn').disabled = !has;
  }

  document.querySelectorAll('.segmented button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      state.mode = b.dataset.mode;
      render();
      if (state.mode === 'email') $('recipientInput').focus();
    });
  });

  // ------------------------------------------------------- penerima email
  const rInput = $('recipientInput');
  function commitRecipient() {
    const parts = rInput.value.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    let bad = 0;
    for (const p of parts) {
      if (!EMAIL_RE.test(p)) {
        bad++;
        continue;
      }
      if (state.recipients.includes(p.toLowerCase())) continue;
      if (state.recipients.length >= state.config.maxRecipients) {
        toast(`Maksimal ${state.config.maxRecipients} penerima.`, 'error');
        break;
      }
      state.recipients.push(p.toLowerCase());
    }
    rInput.value = '';
    if (bad) toast('Ada alamat email yang tidak valid.', 'error');
    renderRecipients();
    return bad === 0;
  }
  function renderRecipients() {
    const wrap = $('recipients');
    wrap.querySelectorAll('.rchip').forEach((n) => n.remove());
    state.recipients.forEach((r, i) => {
      wrap.insertBefore(
        el('span', { class: 'rchip' }, [
          r,
          el('button', {
            type: 'button',
            'aria-label': 'Hapus ' + r,
            text: '×',
            onclick: () => {
              state.recipients.splice(i, 1);
              renderRecipients();
            },
          }),
        ]),
        rInput,
      );
    });
  }
  rInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      commitRecipient();
    } else if (e.key === 'Backspace' && !rInput.value && state.recipients.length) {
      state.recipients.pop();
      renderRecipients();
    }
  });
  rInput.addEventListener('blur', () => rInput.value && commitRecipient());
  rInput.addEventListener('paste', () => setTimeout(commitRecipient, 0));
  $('recipients').addEventListener('click', () => rInput.focus());

  // ------------------------------------------------------------- kirim
  $('compose').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.items.length || state.uploading) return;

    let emailInfo = null;
    if (state.mode === 'email') {
      if (rInput.value && !commitRecipient()) return;
      const from = $('senderInput').value.trim();
      if (!state.recipients.length) return toast('Tambahkan minimal satu email penerima.', 'error');
      if (!EMAIL_RE.test(from)) return toast('Isi email Anda dengan benar.', 'error');
      emailInfo = { to: state.recipients.slice(), from, message: $('messageInput').value.trim() };
    }
    const note = state.mode === 'email' ? emailInfo.message : $('noteInput').value.trim();

    try {
      await upload(emailInfo, note);
    } catch (err) {
      showStage('compose');
      if (err.name === 'AbortError') toast('Pengiriman dibatalkan.');
      else toast(err.message || 'Pengiriman gagal.', 'error');
    } finally {
      state.uploading = false;
      state.abort = null;
    }
  });

  $('cancelBtn').addEventListener('click', () => state.abort && state.abort.abort());

  window.addEventListener('beforeunload', (e) => {
    if (state.uploading) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  async function upload(emailInfo, note) {
    state.uploading = true;
    state.abort = new AbortController();
    const signal = state.abort.signal;
    showStage('progress');
    setProgress(0, 'Membuat kunci enkripsi…');

    const items = state.items.slice();
    const total = items.reduce((a, it) => a + it.file.size, 0);
    const key = await C.generateKey();
    const keyStr = await C.exportKey(key);
    const manifest = await C.encryptManifest(key, {
      v: 1,
      note: note || '',
      files: items.map((it) => ({ name: it.path, size: it.file.size, type: it.file.type || '' })),
    });

    const created = await api('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: items.map((it) => ({ encSize: C.encSize(it.file.size) })), manifest, email: emailInfo }),
      signal,
    });

    const auth = { Authorization: 'Bearer ' + created.token };
    const started = performance.now();
    let done = 0;

    for (let fi = 0; fi < items.length; fi++) {
      const file = items[fi].file;
      const chunks = C.chunkCount(file.size);
      for (let ci = 0; ci < chunks; ci++) {
        const start = ci * C.CHUNK_SIZE;
        const end = Math.min(file.size, start + C.CHUNK_SIZE);
        const plain = await file.slice(start, end).arrayBuffer();
        const enc = await C.encryptChunk(key, fi, ci, ci === chunks - 1, plain);
        await withRetry(
          () =>
            api(`/api/transfers/${created.id}/files/${fi}/chunks/${ci}`, {
              method: 'PUT',
              headers: { ...auth, 'Content-Type': 'application/octet-stream' },
              body: enc,
              signal,
            }),
          signal,
        );
        done += end - start;
        const secs = (performance.now() - started) / 1000;
        const speed = secs > 0.5 ? done / secs : 0;
        const eta = speed ? Math.round((total - done) / speed) : null;
        setProgress(
          total ? done / total : 1,
          `File ${fi + 1} dari ${items.length} · ${formatBytes(done)} / ${formatBytes(total)}` +
            (speed ? ` · ${formatBytes(speed)}/dtk` + (eta !== null && eta > 1 ? ` · sisa ${formatEta(eta)}` : '') : ''),
        );
      }
    }

    const link = `${location.origin}/d/${created.id}#${keyStr}`;
    setProgress(1, emailInfo ? 'Mengirim email…' : 'Menyelesaikan…');
    const fin = await withRetry(
      () =>
        api(`/api/transfers/${created.id}/complete`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(emailInfo ? { link } : {}),
          signal,
        }),
      signal,
    );

    state.uploading = false;
    $('shareLink').value = link;
    $('doneTitle').textContent = emailInfo ? 'File terkirim' : 'Tautan siap dibagikan';
    $('doneDetail').textContent =
      (emailInfo ? `Email terkirim ke ${fin.emailed} penerima. ` : '') +
      `${items.length} file · ${formatBytes(total)} · berlaku sampai ${formatDate(fin.expiresAt)}`;
    showStage('done');
  }

  async function withRetry(fn, signal, tries = 4) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const retriable = err.name !== 'AbortError' && (!err.status || err.status >= 500 || err.status === 429);
        if (!retriable || attempt >= tries || signal.aborted) throw err;
        await new Promise((r) => setTimeout(r, 800 * attempt * attempt));
      }
    }
  }

  function formatEta(s) {
    if (s < 60) return s + ' dtk';
    if (s < 3600) return Math.round(s / 60) + ' mnt';
    return (s / 3600).toFixed(1).replace('.', ',') + ' jam';
  }

  const RING = 2 * Math.PI * 52;
  function setProgress(frac, detail) {
    const p = Math.round(frac * 100);
    $('pct').textContent = p + '%';
    $('ringFg').style.strokeDasharray = RING;
    $('ringFg').style.strokeDashoffset = RING * (1 - frac);
    if (detail) $('progressDetail').textContent = detail;
  }

  function showStage(name) {
    ['compose', 'progress', 'done'].forEach((s) => ($(s).hidden = s !== name));
  }

  // ------------------------------------------------------------- selesai
  $('copyBtn').addEventListener('click', async () => {
    const input = $('shareLink');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (_) {
      input.select();
      document.execCommand('copy');
    }
    $('copyBtn').textContent = 'Tersalin ✓';
    setTimeout(() => ($('copyBtn').textContent = 'Salin'), 2000);
  });
  $('shareLink').addEventListener('focus', (e) => e.target.select());

  $('againBtn').addEventListener('click', () => {
    state.items = [];
    state.recipients = [];
    $('noteInput').value = '';
    $('messageInput').value = '';
    renderRecipients();
    render();
    showStage('compose');
  });

  render();
})();
