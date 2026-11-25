'use strict';
// Runs the storage layer against real Azure Table Storage (or the Azurite emulator), using the
// real @azure/data-tables library. Skipped unless ENGAGE_TEST_TABLES holds a connection string.
// CI starts Azurite and sets it; locally: npx azurite-table --inMemoryPersistence, then
//   ENGAGE_TEST_TABLES="UseDevelopmentStorage=true" npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { TableStore, ConflictError } = require('../src/lib/store');
const { AuthService } = require('../src/lib/auth');
const config = require('../src/lib/config');

const conn = process.env.ENGAGE_TEST_TABLES;
const opts = { skip: !conn && 'set ENGAGE_TEST_TABLES to run against Table Storage' };

test('records round-trip with large numbers, and conflicts are detected', opts, async () => {
  const s = new TableStore(conn), rk = 'x' + Date.now() + '@example.com';
  const data = { at: Date.now(), big: 2 ** 53 - 1, frac: 1.5, text: "it's" };
  const e1 = await s.create('codes', 'code', rk, data);
  assert.deepEqual((await s.get('codes', 'code', rk)).data, data);
  await assert.rejects(s.create('codes', 'code', rk, data), ConflictError);
  const e2 = await s.replace('codes', 'code', rk, { v: 2 }, e1);
  await assert.rejects(s.replace('codes', 'code', rk, { v: 3 }, e1), ConflictError);
  assert.equal(await s.remove('codes', 'code', rk, e2), true);
  assert.equal(await s.remove('codes', 'code', rk), false);
});

test('the full sign-in flow works on Table Storage', opts, async () => {
  const cfg = config.load({ SESSION_SECRET: 'x'.repeat(40), ADMIN_EMAILS: 'boss@example.com', ENGAGE_TABLES_CONNECTION: conn, ENGAGE_DEV_PRINT_CODES: '1' });
  const sent = [];
  const auth = new AuthService({ cfg, store: new TableStore(conn), mailer: { async send(t, c) { sent.push(c); } }, log: { error() {} } });
  await auth.store.remove('codes', 'code', 'boss@example.com');
  assert.equal((await auth.requestCode('boss@example.com', '192.0.2.1')).outcome, 'sent');
  assert.equal((await auth.verifyCode('boss@example.com', sent[0])).ok, true);
  assert.equal((await auth.addApproved('boss@example.com', 'u@example.com')).ok, true);
  assert.ok((await auth.listApproved()).some(u => u.email === 'u@example.com'));
  assert.equal((await auth.removeApproved('boss@example.com', 'u@example.com')).ok, true);
});
