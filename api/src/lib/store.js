'use strict';
// A small key-value store with optimistic concurrency, in two versions:
//   MemoryStore  for tests and local development
//   TableStore   for Azure Table Storage
// Each record is {pk, rk, data, etag}. The data object is saved as one JSON text
// property, so Table Storage never has to guess number types (a problem v133 hit:
// large numbers such as timestamps were rejected on the first write).

const crypto = require('node:crypto');

class ConflictError extends Error { constructor(m) { super(m || 'conflict'); this.code = 'CONFLICT'; } }

const TABLES = ['codes', 'approved', 'admins', 'audit', 'rate'];

class MemoryStore {
  constructor() { this.t = new Map(TABLES.map(n => [n, new Map()])); this.failNext = null; }
  _tab(n) { if (!this.t.has(n)) throw new Error('unknown table ' + n); return this.t.get(n); }
  _k(pk, rk) { return pk + '\u0000' + rk; }
  async _maybeFail(op) { if (this.failNext && this.failNext(op)) { this.failNext = null; throw new Error('simulated storage failure'); } }
  async get(table, pk, rk) {
    await this._maybeFail('get');
    const r = this._tab(table).get(this._k(pk, rk));
    return r ? { pk, rk, data: JSON.parse(r.d), etag: r.etag } : null;
  }
  async create(table, pk, rk, data) {
    await this._maybeFail('create');
    const m = this._tab(table), k = this._k(pk, rk);
    if (m.has(k)) throw new ConflictError('exists');
    const etag = crypto.randomUUID(); m.set(k, { pk, rk, d: JSON.stringify(data), etag }); return etag;
  }
  async replace(table, pk, rk, data, etag) {
    await this._maybeFail('replace');
    const m = this._tab(table), k = this._k(pk, rk), cur = m.get(k);
    if (!cur || (etag && cur.etag !== etag)) throw new ConflictError('changed');
    const ne = crypto.randomUUID(); m.set(k, { pk, rk, d: JSON.stringify(data), etag: ne }); return ne;
  }
  async upsert(table, pk, rk, data) {
    await this._maybeFail('upsert');
    const etag = crypto.randomUUID(); this._tab(table).set(this._k(pk, rk), { pk, rk, d: JSON.stringify(data), etag }); return etag;
  }
  async remove(table, pk, rk, etag) {
    await this._maybeFail('remove');
    const m = this._tab(table), k = this._k(pk, rk), cur = m.get(k);
    if (!cur) return false;
    if (etag && cur.etag !== etag) throw new ConflictError('changed');
    m.delete(k); return true;
  }
  async list(table, pk) {
    await this._maybeFail('list');
    return [...this._tab(table).values()].filter(r => r.pk === pk).sort((a, b) => a.rk < b.rk ? -1 : 1).map(r => ({ pk: r.pk, rk: r.rk, data: JSON.parse(r.d), etag: r.etag }));
  }
}

class TableStore {
  constructor(connection) {
    const { TableClient } = require('@azure/data-tables');
    this.clients = Object.fromEntries(TABLES.map(n => [n, TableClient.fromConnectionString(connection, 'engage' + n, { allowInsecureConnection: /UseDevelopmentStorage|127\.0\.0\.1|localhost/.test(connection) })]));
    this.ready = null;
  }
  async _init() {
    if (!this.ready) this.ready = Promise.all(Object.values(this.clients).map(c => c.createTable().catch(e => { if (e.statusCode !== 409) throw e; })));
    return this.ready;
  }
  _c(n) { const c = this.clients[n]; if (!c) throw new Error('unknown table ' + n); return c; }
  static _rec(e) { return { pk: e.partitionKey, rk: e.rowKey, data: JSON.parse(e.d), etag: e.etag }; }
  static _conflict(e) { return e && (e.statusCode === 409 || e.statusCode === 412); }
  async get(table, pk, rk) {
    await this._init();
    try { return TableStore._rec(await this._c(table).getEntity(pk, rk)); }
    catch (e) { if (e.statusCode === 404) return null; throw e; }
  }
  async create(table, pk, rk, data) {
    await this._init();
    try { const r = await this._c(table).createEntity({ partitionKey: pk, rowKey: rk, d: JSON.stringify(data) }); return r.etag; }
    catch (e) { if (TableStore._conflict(e)) throw new ConflictError('exists'); throw e; }
  }
  async replace(table, pk, rk, data, etag) {
    await this._init();
    try { const r = await this._c(table).updateEntity({ partitionKey: pk, rowKey: rk, d: JSON.stringify(data) }, 'Replace', { etag: etag || '*' }); return r.etag; }
    catch (e) { if (TableStore._conflict(e) || e.statusCode === 404) throw new ConflictError('changed'); throw e; }
  }
  async upsert(table, pk, rk, data) {
    await this._init();
    const r = await this._c(table).upsertEntity({ partitionKey: pk, rowKey: rk, d: JSON.stringify(data) }, 'Replace'); return r.etag;
  }
  async remove(table, pk, rk, etag) {
    await this._init();
    try { await this._c(table).deleteEntity(pk, rk, { etag: etag || '*' }); return true; }
    catch (e) { if (e.statusCode === 404) return false; if (TableStore._conflict(e)) throw new ConflictError('changed'); throw e; }
  }
  async list(table, pk) {
    await this._init();
    const out = [];
    const safePk = String(pk).replace(/'/g, "''");
    for await (const e of this._c(table).listEntities({ queryOptions: { filter: `PartitionKey eq '${safePk}'` } })) out.push(TableStore._rec(e));
    return out.sort((a, b) => a.rk < b.rk ? -1 : 1);
  }
}

module.exports = { MemoryStore, TableStore, ConflictError, TABLES };
