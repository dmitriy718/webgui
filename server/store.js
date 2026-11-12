'use strict';

/**
 * store.js — Persistent JSON document store backed by one file per collection.
 *
 * Collections live in <dataDir>/<name>.json. Writes are atomic
 * (temp file + rename) so a crash mid-write cannot corrupt data.
 * All operations are synchronous and safe to call from anywhere.
 */

const fs = require('fs');
const path = require('path');
const { uid } = require('./util');

class Store {
  /**
   * @param {string} dataDir  Directory for JSON files.
   * @param {string} name     Collection name (file basename).
   */
  constructor(dataDir, name) {
    this.dir = dataDir;
    this.name = name;
    this.file = path.join(dataDir, `${name}.json`);
    /** @type {Map<string, object>} */
    this._map = new Map();
    /** @type {string[]} insertion order (stable list ordering) */
    this._order = [];
    this._load();
  }

  _load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Corrupted or unreadable file: back it up and start fresh so the
        // app always boots.
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch { /* ignore */ }
      }
    }
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      for (const doc of data.docs || []) {
        if (!doc || typeof doc._id !== 'string') continue;
        this._map.set(doc._id, doc);
        this._order.push(doc._id);
      }
    } catch {
      // Unparseable file: keep a backup copy and start empty.
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch { /* ignore */ }
    }
  }

  _persist() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const payload = JSON.stringify({ docs: this.allRaw() }, null, 2);
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** Insert a document. Generates `_id` (and `_created`/`_modified`) if absent. */
  insert(doc) {
    const d = { ...doc };
    if (typeof d._id !== 'string' || !d._id) d._id = uid(this.name.slice(0, 3));
    if (this._map.has(d._id)) {
      throw new Error(`Document ${d._id} already exists`);
    }
    const now = new Date().toISOString();
    d._created = d._created || now;
    d._modified = d._modified || now;
    this._map.set(d._id, d);
    this._order.push(d._id);
    this._persist();
    return this._clone(d);
  }

  /** Replace an existing document. Returns null if it does not exist. */
  replace(doc) {
    if (typeof doc._id !== 'string' || !this._map.has(doc._id)) return null;
    const cur = this._map.get(doc._id);
    const next = { ...cur, ...doc, _id: cur._id, _created: cur._created };
    next._modified = new Date().toISOString();
    this._map.set(next._id, next);
    this._persist();
    return this._clone(next);
  }

  /** Shallow-merge a patch into an existing document. Returns updated doc or null. */
  update(id, patch) {
    const cur = this._map.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, _id: cur._id, _created: cur._created };
    next._modified = new Date().toISOString();
    this._map.set(id, next);
    this._persist();
    return this._clone(next);
  }

  get(id) {
    const d = this._map.get(id);
    return d ? this._clone(d) : null;
  }

  delete(id) {
    if (!this._map.has(id)) return false;
    this._map.delete(id);
    this._order = this._order.filter((x) => x !== id);
    this._persist();
    return true;
  }

  /** All documents in insertion order. */
  all() {
    return this._order.map((id) => this._clone(this._map.get(id)));
  }

  /** Same as all() but without cloning (for internal use / serialization). */
  allRaw() {
    return this._order.map((id) => this._map.get(id));
  }

  count() {
    return this._map.size;
  }

  _clone(doc) {
    return JSON.parse(JSON.stringify(doc));
  }
}

class StoreManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this._stores = new Map();
  }

  /** Get (or lazily create) a named collection. */
  collection(name) {
    if (!this._stores.has(name)) {
      this._stores.set(name, new Store(this.dataDir, name));
    }
    return this._stores.get(name);
  }
}

module.exports = { Store, StoreManager };
