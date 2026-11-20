/* Cahier Tasks: the device's copy of the board and its sync, ported from Tack
 * (web/src/data/store.ts, engine.ts, index.ts, transport.ts).
 *
 * Every edit lands here first: the row changes on this device and the change is queued, in one
 * IndexedDB transaction, so it can't be applied and then lost. The UI reads only this copy and
 * never waits for the network. The queue goes to POST /api/tasks/sync when there is a
 * connection; then GET /api/tasks/sync?since=<seq> brings back what changed elsewhere (other
 * devices, or Nook ticking a task). The server decides conflicts, field by field, by clock. */
import { HlcClock, PROTOCOL_VERSION } from "./core.mjs";

const DB_NAME = "cahier-tasks";
const TABLES = ["boards", "lists", "cards"];
const HAS_UPDATED_AT = new Set(TABLES);
const PUSH_BATCH = 200;
const RETRY_MS = 15000;   // while offline or failing
const POLL_MS = 30000;    // while online: Tack had server events; a poll is enough here
const CHANNEL = "cahier-tasks";
const LOCK = "cahier-tasks-sync";

export class SessionExpiredError extends Error {}
export class OutdatedClientError extends Error {}

const outboxKey = (table, id) => `${table}:${id}`;

// ---- IndexedDB, the small part of it we need -------------------------------------------------

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb() {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    for (const t of TABLES) db.createObjectStore(t, { keyPath: "id" });
    db.createObjectStore("outbox", { keyPath: "key" });
    db.createObjectStore("meta", { keyPath: "key" });
  };
  return req(r);
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

// ---- the store -------------------------------------------------------------------------------

export class TaskStore {
  constructor() {
    this.rows = { boards: new Map(), lists: new Map(), cards: new Map() };
    this.outbox = new Map();
    this.meta = { seq: undefined, epoch: 0, status: "connecting" };
    this.listeners = new Set();
    this.firstSync = false;
    this.db = null;
    this.clock = new HlcClock((crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 8));
    this.poke = () => {};
    this.channel = "BroadcastChannel" in self ? new BroadcastChannel(CHANNEL) : null;
    this.queue = Promise.resolve();  // writes to IndexedDB, in order
  }

  async open() {
    try {
      this.db = await openDb();
      await this.load();
    } catch (e) {
      // Private windows can refuse IndexedDB. The board still works, from memory, while open.
      this.db = null;
    }
    if (this.channel) {
      this.channel.onmessage = (e) => {
        if (e.data === "write") this.load().then(() => { this.emit(); this.poke(); });
        if (e.data === "status") this.load().then(() => this.emit());
      };
    }
  }

  async load() {
    if (!this.db) return;
    const tx = this.db.transaction([...TABLES, "outbox", "meta"], "readonly");
    const [boards, lists, cards, outbox, meta] = await Promise.all([
      ...TABLES.map((t) => req(tx.objectStore(t).getAll())),
      req(tx.objectStore("outbox").getAll()),
      req(tx.objectStore("meta").getAll()),
    ]);
    this.rows = {
      boards: new Map(boards.map((r) => [r.id, r])),
      lists: new Map(lists.map((r) => [r.id, r])),
      cards: new Map(cards.map((r) => [r.id, r])),
    };
    this.outbox = new Map(outbox.map((e) => [e.key, e]));
    for (const m of meta) this.meta[m.key] = m.value;
    for (const t of TABLES) for (const row of this.rows[t].values()) for (const c of Object.values(row.clocks || {})) this.clock.observe(c);
  }

  /** Writes what changed in memory to IndexedDB, in order, in one transaction. */
  persist(changes) {
    if (!this.db) return Promise.resolve();
    this.queue = this.queue.then(() => {
      const tx = this.db.transaction([...TABLES, "outbox", "meta"], "readwrite");
      for (const c of changes) {
        const store = tx.objectStore(c.store);
        if (c.value === undefined) store.delete(c.key);
        else store.put(c.value);
      }
      return done(tx);
    }).catch(() => {});
    return this.queue;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  // ---- edits (Tack store.ts) -----------------------------------------------------------------

  insert(table, id, fields) {
    return this.write(table, id, fields);
  }

  update(table, id, fields) {
    const stamped = { ...fields };
    if (HAS_UPDATED_AT.has(table)) stamped.updatedAt = new Date().toISOString();
    return this.write(table, id, stamped);
  }

  write(table, id, fields) {
    const clock = this.clock.now();
    const clocks = Object.fromEntries(Object.keys(fields).map((f) => [f, clock]));
    const existing = this.rows[table].get(id);
    const row = { ...existing, ...fields, id, clocks: { ...(existing && existing.clocks), ...clocks } };
    this.rows[table].set(id, row);
    const key = outboxKey(table, id);
    const queued = this.outbox.get(key);
    const entry = {
      key, table, id,
      fields: { ...(queued && queued.fields), ...fields },
      clocks: { ...(queued && queued.clocks), ...clocks },
    };
    this.outbox.set(key, entry);
    const saved = this.persist([{ store: table, value: row }, { store: "outbox", value: entry }]);
    this.emit();
    saved.then(() => {
      this.poke();
      if (this.channel) this.channel.postMessage("write");
    });
    return saved;
  }

  // ---- reading -------------------------------------------------------------------------------

  /** Card ids with edits still queued, but only while something holds the queue back. */
  unsent() {
    if (this.meta.status === "online" || this.meta.status === "connecting") return new Set();
    const out = new Set();
    for (const key of this.outbox.keys()) if (key.startsWith("cards:")) out.add(key.slice(6));
    return out;
  }

  // ---- sync (Tack engine.ts) -----------------------------------------------------------------

  sync() {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    do {
      this.again = false;
      try {
        await this.pushAll();
        await this.pull();
        this.firstSync = true;
        await this.setStatus("online");
      } catch (err) {
        if (err instanceof SessionExpiredError) await this.setStatus("expired");
        else if (err instanceof OutdatedClientError) await this.setStatus("outdated");
        else await this.setStatus("offline");
        this.again = false;
      }
    } while (this.again);
  }

  async pushAll() {
    for (;;) {
      const batch = [...this.outbox.values()].slice(0, PUSH_BATCH);
      if (batch.length === 0) return;
      const changes = batch.map(({ key, ...change }) => change);
      const response = await request("/api/tasks/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocol: PROTOCOL_VERSION, changes }),
      });
      this.clock.syncWall(response.serverTime);
      const writes = [];
      for (const entry of batch) this.acknowledge(entry, writes);
      for (const { table, id, row } of response.rejected) {
        this.outbox.delete(outboxKey(table, id));
        writes.push({ store: "outbox", key: outboxKey(table, id) });
        this.applyServerRow(table, id, row, writes);
      }
      await this.persist(writes);
      this.emit();
    }
  }

  /** Clears what the server received, keeping anything edited again while the request ran. */
  acknowledge(sent, writes) {
    const current = this.outbox.get(sent.key);
    if (!current) return;
    const fields = { ...current.fields };
    const clocks = { ...current.clocks };
    for (const [field, clock] of Object.entries(sent.clocks)) {
      if (clocks[field] === clock) { delete fields[field]; delete clocks[field]; }
    }
    if (Object.keys(clocks).length === 0) {
      this.outbox.delete(sent.key);
      writes.push({ store: "outbox", key: sent.key });
    } else {
      const next = { ...current, fields, clocks };
      this.outbox.set(sent.key, next);
      writes.push({ store: "outbox", value: next });
    }
  }

  async pull() {
    const since = this.meta.seq;
    let response = await request(`/api/tasks/sync?since=${since ?? 0}&protocol=${PROTOCOL_VERSION}`);
    if (since !== undefined && response.epoch !== this.meta.epoch) {
      // The server went back to a backup: its data is the truth now. Queued edits stay queued.
      const writes = [];
      for (const t of TABLES) {
        for (const id of this.rows[t].keys()) writes.push({ store: t, key: id });
        this.rows[t].clear();
      }
      await this.persist(writes);
      if (this.outbox.size > 0) this.again = true;
      response = await request(`/api/tasks/sync?since=0&protocol=${PROTOCOL_VERSION}`);
    }
    this.clock.syncWall(response.serverTime);
    const writes = [];
    for (const [table, rows] of Object.entries(response.rows)) {
      if (!this.rows[table]) continue;
      for (const row of rows) {
        for (const c of Object.values(row.clocks)) this.clock.observe(c);
        this.applyServerRow(table, row.id, row, writes);
      }
    }
    for (const { table, id } of response.tombstones) {
      if (!this.rows[table]) continue;
      this.outbox.delete(outboxKey(table, id));
      this.rows[table].delete(id);
      writes.push({ store: "outbox", key: outboxKey(table, id) }, { store: table, key: id });
    }
    this.meta.seq = response.seq;
    this.meta.epoch = response.epoch;
    writes.push({ store: "meta", value: { key: "seq", value: response.seq } },
      { store: "meta", value: { key: "epoch", value: response.epoch } });
    await this.persist(writes);
    this.emit();
    if (this.channel) this.channel.postMessage("status");  // other tabs reload what was pulled
  }

  /** What the server holds replaces this device's row, except for fields still queued here. */
  applyServerRow(table, id, row, writes) {
    const queued = this.outbox.get(outboxKey(table, id));
    if (!row) {
      if (queued) { this.outbox.delete(outboxKey(table, id)); writes.push({ store: "outbox", key: outboxKey(table, id) }); }
      this.rows[table].delete(id);
      writes.push({ store: table, key: id });
      return;
    }
    const merged = { ...row, ...(queued && queued.fields), clocks: { ...row.clocks, ...(queued && queued.clocks) } };
    this.rows[table].set(id, merged);
    writes.push({ store: table, value: merged });
  }

  async setStatus(value) {
    if (this.meta.status === value) return;
    this.meta.status = value;
    await this.persist([{ store: "meta", value: { key: "status", value } }]);
    this.emit();
    if (this.channel) this.channel.postMessage("status");
  }

  /** Only one tab per device talks to the server; the others follow through IndexedDB. */
  start() {
    const lead = () => {
      const sync = () => void this.sync();
      this.poke = sync;
      addEventListener("online", sync);
      addEventListener("focus", sync);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(); });
      setInterval(() => { if (this.meta.status !== "online") sync(); }, RETRY_MS);
      setInterval(() => { if (document.visibilityState === "visible") sync(); }, POLL_MS);
      sync();
    };
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request(LOCK, () => { lead(); return new Promise(() => {}); });
    } else {
      lead();
    }
  }
}

async function request(url, init) {
  let res;
  try {
    // With redirects followed, Access's redirect to its login page would look like an outage.
    res = await fetch(url, { ...init, redirect: "manual", cache: "no-store" });
  } catch (e) {
    throw new Error("offline");
  }
  if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) throw new SessionExpiredError();
  if (res.status === 426) throw new OutdatedClientError();
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}
