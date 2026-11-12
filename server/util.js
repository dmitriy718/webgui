'use strict';

const crypto = require('crypto');

/** Generate a URL-safe unique id with an optional prefix. */
function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

/** Constant-time string comparison. */
function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still compare to keep timing uniform-ish, then report mismatch.
    crypto.timingSafeEqual(Buffer.alloc(ab.length, 0), Buffer.alloc(ab.length, 0));
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** Hash a password with scrypt + random salt. Returns "scrypt$<salt>$<hash>" hex strings. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Verify a password against a stored hash produced by hashPassword. */
function verifyPassword(password, stored) {
  try {
    if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
    const [, saltHex, hashHex] = stored.split('$');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Generate a random session token. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Parse a JSON body from a request stream with a size limit. */
async function readJsonBody(req, limitBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Parse multipart/form-data with an explicit boundary. */
function parseMultipartWithBoundary(buf, boundary) {
  const fields = {};
  const files = {};
  const boundaryBuf = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(boundaryBuf);
  if (pos === -1) return { fields, files };
  pos += boundaryBuf.length;
  while (pos < buf.length) {
    // Check for closing "--"
    if (buf.slice(pos, pos + 2).toString() === '--') break;
    // Skip CRLF after boundary
    if (buf.slice(pos, pos + 2).toString() === '\r\n') pos += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headerText = buf.slice(pos, headerEnd).toString('utf8');
    pos = headerEnd + 4;
    const nextBoundary = buf.indexOf(boundaryBuf, pos);
    if (nextBoundary === -1) break;
    // Body ends with \r\n before next boundary
    const bodyEnd = nextBoundary - 2;
    const body = buf.slice(pos, bodyEnd);
    pos = nextBoundary + boundaryBuf.length;

    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    if (fileMatch) {
      files[name] = body;
    } else {
      fields[name] = body.toString('utf8');
    }
  }
  return { fields, files };
}

/** Read a multipart body given a full request (uses Content-Type boundary). */
async function readMultipart(req, limitBytes = 50 * 1024 * 1024) {
  const ct = req.headers['content-type'] || '';
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) throw Object.assign(new Error('Missing multipart boundary'), { status: 400 });
  const boundary = m[1] || m[2];
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
  const buf = Buffer.concat(chunks);
  return parseMultipartWithBoundary(buf, boundary);
}

/** Escape HTML to prevent XSS in rendered output. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Truncate a string to a max length with an ellipsis. */
function truncate(s, max = 120) {
  s = String(s);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Simple in-memory rate limiter (sliding window per key). */
function makeRateLimiter({ limit, windowMs, maxKeys = 10000 } = { limit: 600, windowMs: 60000 }) {
  const hits = new Map();
  // Periodic cleanup
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      if (now - v.start > windowMs) hits.delete(k);
      else {
        // Drop expired entries
        while (v.times.length && now - v.times[0] > windowMs) v.times.shift();
      }
    }
    if (hits.size > maxKeys) {
      // Evict oldest entries
      let i = 0;
      for (const k of hits.keys()) {
        if (i++ >= hits.size - maxKeys) break;
        hits.delete(k);
      }
    }
  }, Math.max(windowMs, 30000));
  timer.unref();

  return {
    /** Returns true if the key is allowed, false if rate-limited. */
    hit(key) {
      const now = Date.now();
      let v = hits.get(key);
      if (!v) {
        v = { start: now, times: [] };
        hits.set(key, v);
      }
      while (v.times.length && now - v.times[0] > windowMs) v.times.shift();
      if (v.times.length >= limit) return false;
      v.times.push(now);
      return true;
    },
  };
}

/** Parse a query string from a URL into a plain object. */
function parseQuery(url) {
  const q = {};
  const i = url.indexOf('?');
  if (i === -1) return q;
  const params = new URLSearchParams(url.slice(i + 1));
  for (const [k, v] of params) q[k] = v;
  return q;
}

/** Serve a file with correct content type and no-cache for html. */
function contentTypeForPath(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    webp: 'image/webp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
  };
  return map[ext] || 'application/octet-stream';
}

module.exports = {
  uid,
  timingSafeEqual,
  hashPassword,
  verifyPassword,
  randomToken,
  readJsonBody,
  readMultipart,
  parseMultipartWithBoundary,
  escapeHtml,
  truncate,
  makeRateLimiter,
  parseQuery,
  contentTypeForPath,
};
