# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

KirimAman is a no-account, end-to-end encrypted large-file transfer app (share by link or email). Plain Node.js (>=18.17) HTTP server with zero required dependencies; `nodemailer` is an optional dependency used only for the email feature. Frontend is vanilla JS/HTML/CSS with no build step. All user-facing text (UI, API error messages, emails, README, test names) is in **Indonesian** — keep new strings in Indonesian.

## Commands

```bash
npm install   # only needed for email (nodemailer); safe to skip
npm start     # node server.js → http://localhost:3000
npm test      # node test/e2e.test.js
```

- There is no linter, formatter config, or build step.
- Tests are a single self-contained script with a tiny `test(name, fn)` helper (no framework, no per-test filter). To run one test, temporarily comment out the others in `test/e2e.test.js`. Tests run sequentially and share state (later tests reuse the `sent` transfer from the first one).
- The test boots the server on a random port via `createServer()` with `DATA_DIR` set to a temp dir, and loads `public/js/crypto.js` in Node (it attaches `KACrypto` to `globalThis`), so the real browser crypto code is exercised.
- Config is read from env vars, and `server.js` loads `.env` itself (no dotenv) without overriding already-set vars. See `.env.example` / README for the variables. Web Crypto requires HTTPS or `localhost` in the browser.

## Architecture

**Zero-knowledge model.** The browser generates a random AES-256-GCM key per transfer and puts it in the URL fragment (`/d/<id>#<key>`), which is never sent to the server. The server stores only ciphertext plus an encrypted, base64url *manifest* (file names, sizes, MIME types, sender note). Never add server-side code that needs plaintext names/content, and never log or persist the full link. Exception: in email mode the client sends the full link to `POST /complete` so the server can email it. It is validated, mailed, and not stored. Recipient addresses are also stripped from `meta.json` after sending.

**Crypto format (`public/js/crypto.js`).** This is the single source of truth, shared by the browser and the tests:
- Files are split into 4 MiB plaintext chunks; each encrypted chunk is `CHUNK_SIZE + 16` bytes (GCM tag), and the last chunk may be shorter. Zero-byte files still produce one chunk.
- The 12-byte IV is `fileIndex (u32) | 0x4B41 "KA" version marker (u32) | chunkIndex (u32)`. AAD is a single byte flagging the last chunk, which prevents reordering, replay, and truncation.
- The manifest is encrypted as file index `0xFFFFFFFF`, chunk 0, last=true.
- `CHUNK_SIZE`/`TAG_SIZE` are **duplicated in `server.js`** (marked "Harus sama dengan public/js/crypto.js"). The server uses them to validate `encSize` (it must equal `encSizeOf(plainSizeOf(encSize))`), compute chunk offsets, and check exact chunk lengths. Changing the chunk format requires updating both files and is incompatible with existing stored transfers.

**Upload flow.** `POST /api/transfers` (sizes and manifest, rate-limited per IP) returns `{id, token}`. Next, `PUT .../files/:i/chunks/:c` sends each chunk with `Authorization: Bearer <token>`. Then `POST .../complete` finishes the transfer. Only `sha256(token)` is stored. Chunks must arrive in order per file: the server rejects with 409 if `offset > received`, though re-sending an already-received chunk is allowed so retries work. Chunk writes and meta updates for a transfer are serialized through `withLock(id)`, an in-memory promise chain. Incomplete transfers are not downloadable and expire after `INCOMPLETE_TTL_HOURS`. Client-side retry with backoff is in `send.js`.

**Download flow.** `GET /api/transfers/:id` returns the encrypted manifest and the per-file `encSize`s. `download.js` fetches each encrypted chunk with HTTP `Range` requests (the server supports Range/HEAD), decrypts it, and streams it to disk via `showSaveFilePicker` on Chrome/Edge. Other browsers fall back to in-memory blobs.

**Storage.** Each transfer is stored on disk under `DATA_DIR/<id>/` as `meta.json` (written atomically via a tmp file and rename) and `file-<i>.bin` (preallocated empty, then written at offsets). `meta.json` is cached in-memory in `metaCache`, so tests that edit `meta.json` on disk must re-`require` the server to bypass the cache. Rate limiting is also in-memory. Both reset on restart, and the server assumes it runs as a single process. `cleanup()` runs at startup and then hourly, deleting expired or stale-incomplete transfers.

**Server structure (`server.js`).** This single file contains the config, helpers, API handlers, static file serving, a regex-based router (`route()`), and cleanup. Handlers throw `HttpError(status, msg)`, and the wrapper in `createServer()` turns it into `{error}` JSON (500s get a generic message). IDs are 22-char base64url (`ID_RE`). Static serving maps `/d/:id` to `download.html` and applies a strict CSP (`script-src 'self'`, `style-src 'self'`), so there must be **no inline scripts or styles** in HTML. `module.exports` exposes `createServer` and the constants for tests. The server only listens when `require.main === module`.

**Frontend.** Pages load plain `<script>` tags in order: `crypto.js` → `common.js` → `send.js` (from `index.html`) or `download.js` (from `download.html`). Shared helpers live on `window.KA` (`api`, `el`, `toast`, `formatBytes`, `formatDate`, `iconNode`). The crypto module is on `window.KACrypto`. The UI reads limits at runtime from `GET /api/config` and fills elements marked `data-limit`, `data-maxfiles`, etc.

**Versioning.** `package.json` `version` is the only source of the version number. The server reads it into `VERSION` and returns it from `/api/config`. `common.js` fetches the config once per page (`KA.config`, also used by `send.js`) and fills the footer's `[data-version]` element. To release: bump `package.json`, commit, then create an annotated tag `vX.Y.Z` on that commit and push it with `git push origin main --follow-tags`.

## Deployment notes

Docker image: `node:22-alpine`, data volume at `/data`. Behind Nginx, set `TRUST_PROXY=1` (rate limiting then uses `X-Forwarded-For`), `client_max_body_size` ≥ ~8m, and `proxy_request_buffering off`. If nginx has a `proxy_cache` active (aaPanel enables one globally in `proxy.conf`), nginx drops `Range` headers. The vhost therefore needs `proxy_cache off`, otherwise chunked downloads get 200 instead of 206.

Server-specific deployment details (hostnames, paths, process manager) are in `CLAUDE.local.md`, which is gitignored.
