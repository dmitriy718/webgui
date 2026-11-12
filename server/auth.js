'use strict';

/**
 * auth.js — Optional password authentication with scrypt hashing and
 * opaque session tokens. Disabled by default; enabled by setting
 * WEBGUI_PASSWORD or calling enableWithPassword().
 */

const { hashPassword, verifyPassword, randomToken, timingSafeEqual } = require('./util');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class Auth {
  constructor() {
    this.enabled = false;
    this._passwordHash = null;
    /** @type {Map<string, {expires:number}>} token -> expiry */
    this._sessions = new Map();
    this._cookieName = 'webgui_session';
  }

  /** Enable authentication with the given plaintext password. */
  enableWithPassword(password) {
    if (typeof password !== 'string' || password.length < 4) {
      throw new Error('Password must be a string of at least 4 characters');
    }
    this._passwordHash = hashPassword(password);
    this.enabled = true;
  }

  /** @returns {boolean} whether authentication is required */
  isEnabled() {
    return this.enabled;
  }

  /** Attempt login. Returns a session token or null. */
  login(password) {
    if (!this.enabled) return null;
    if (typeof password !== 'string' || !verifyPassword(password, this._passwordHash)) {
      return null;
    }
    this._prune();
    const token = randomToken(32);
    this._sessions.set(token, { expires: Date.now() + SESSION_TTL_MS });
    return token;
  }

  /** Validate a raw session token (from cookie or Authorization header). */
  validateToken(token) {
    if (!this.enabled || typeof token !== 'string' || !token) return false;
    const s = this._sessions.get(token);
    if (!s) return false;
    if (Date.now() > s.expires) {
      this._sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(token) {
    if (typeof token === 'string') this._sessions.delete(token);
  }

  cookieToken(req) {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      if (name === this._cookieName) {
        try {
          return decodeURIComponent(part.slice(idx + 1).trim());
        } catch {
          return part.slice(idx + 1).trim();
        }
      }
    }
    return null;
  }

  /** Extract a token from Cookie or `Authorization: Bearer <token>`. */
  tokenFromRequest(req) {
    const auth = req.headers.authorization || '';
    if (/^Bearer\s+/i.test(auth)) {
      const t = auth.replace(/^Bearer\s+/i, '').trim();
      if (t) return t;
    }
    return this.cookieToken(req);
  }

  /** Set-Cookie value for a new session. */
  sessionCookie(token) {
    return `${this._cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  }

  /** Set-Cookie value that clears the session. */
  clearCookie() {
    return `${this._cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  /** Count of active sessions (for admin/health endpoints). */
  activeSessions() {
    this._prune();
    return this._sessions.size;
  }

  _prune() {
    const now = Date.now();
    for (const [t, s] of this._sessions) {
      if (now > s.expires) this._sessions.delete(t);
    }
  }
}

module.exports = { Auth };
