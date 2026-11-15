(function (root) {
  'use strict';

  function formatBytes(n) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    n = Number(n) || 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    const digits = i === 0 ? 0 : n < 10 ? 1 : 0;
    return n.toFixed(digits).replace('.', ',') + ' ' + u[i];
  }

  function formatDate(ms) {
    return new Date(ms).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  let toastTimer = null;
  function toast(message, kind) {
    const el = document.getElementById('toast');
    if (!el) return alert(message);
    el.textContent = message;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4500);
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = 'Terjadi kesalahan (' + res.status + ').';
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch (_) {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const type = res.headers.get('content-type') || '';
    return type.includes('application/json') ? res.json() : res;
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => c && node.append(c));
    return node;
  }

  const ICONS = {
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/></svg>',
    video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M17 10l4-2v8l-4-2"/></svg>',
    audio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
    archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/></svg>',
    doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  };

  function iconFor(name, type) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if ((type || '').startsWith('image/') || /^(png|jpe?g|gif|webp|svg|heic|bmp|tiff?)$/.test(ext)) return ICONS.image;
    if ((type || '').startsWith('video/') || /^(mp4|mov|mkv|avi|webm)$/.test(ext)) return ICONS.video;
    if ((type || '').startsWith('audio/') || /^(mp3|wav|flac|aac|ogg|m4a)$/.test(ext)) return ICONS.audio;
    if (/^(zip|rar|7z|tar|gz|bz2|xz)$/.test(ext)) return ICONS.archive;
    if (/^(pdf|docx?|xlsx?|pptx?|txt|md|csv|odt|rtf)$/.test(ext)) return ICONS.doc;
    return ICONS.file;
  }

  function iconNode(name, type) {
    const span = document.createElement('span');
    span.className = 'ficon';
    span.innerHTML = iconFor(name, type); // ikon statis milik kita sendiri, bukan input pengguna
    return span;
  }

  // Konfigurasi server diambil sekali per halaman dan dipakai bersama (send.js juga memakainya).
  const config = api('/api/config');
  config
    .then((cfg) => {
      document.querySelectorAll('[data-version]').forEach((n) => {
        if (!cfg.version) return;
        n.textContent = 'KirimAman v' + cfg.version;
        n.hidden = false;
      });
    })
    .catch(() => {});

  root.KA = { formatBytes, formatDate, toast, api, el, iconNode, config };
})(window);
