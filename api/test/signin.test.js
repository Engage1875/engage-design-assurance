'use strict';
// Tests of the sign-in service: run with `cd api && npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/lib/config');
const { MemoryStore } = require('../src/lib/store');
const { AuthService, normEmail } = require('../src/lib/auth');
const { makeHandler, visitorIp, COOKIE, PUBLIC_ANSWER } = require('../src/lib/http');

const ORIGIN = 'https://engage.example.net';
const BASE_ENV = { SESSION_SECRET: 'x'.repeat(40), ADMIN_EMAILS: 'boss@example.com', ENGAGE_DEV_MEMORY_STORE: '1', ENGAGE_DEV_PRINT_CODES: '1', ENGAGE_ALLOWED_ORIGIN: ORIGIN, ENGAGE_REQUEST_FLOOR_MS: '40', ENGAGE_MAIL_TIMEOUT_MS: '100' };

function setup(envExtra = {}, opts = {}) {
  const cfg = config.load({ ...BASE_ENV, ...envExtra });
  let t = 1_800_000_000_000;
  const clock = { now: () => t, add: ms => { t += ms; } };
  const store = new MemoryStore();
  const sent = [];
  const mailer = opts.mailer || { async send(to, code) { sent.push({ to, code }); } };
  const auth = new AuthService({ cfg, store, mailer, now: clock.now, log: { error() {}, info() {} } });
  const appFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engage-api-')), 'Engage.html');
  fs.writeFileSync(appFile, '<!doctype html><title>ENGAGE</title>');
  const handle = makeHandler({ auth, cfg, appHtmlPath: appFile });
  const call = async (method, p, body, headers = {}) => {
    const r = await handle({ method, path: p, headers: { origin: ORIGIN, 'x-azure-clientip': '203.0.113.9', ...headers }, body: body ? JSON.stringify(body) : '' });
    return { ...r, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })() };
  };
  const lastCode = to => [...sent].reverse().find(s => s.to === to)?.code;
  const signIn = async email => {
    await call('POST', '/api/auth/request', { email });
    const r = await call('POST', '/api/auth/verify', { email, code: lastCode(email) });
    assert.equal(r.status, 200, 'signed in ' + email);
    return `${COOKIE}=${r.headers['Set-Cookie'].split(';')[0].split('=')[1]}`;
  };
  return { cfg, store, sent, auth, call, clock, lastCode, signIn };
}

// ---------- configuration ----------
test('configuration refuses a short secret, no administrators, or dev switches in Azure', () => {
  assert.throws(() => config.load({ ...BASE_ENV, SESSION_SECRET: 'short' }), /SESSION_SECRET/);
  assert.throws(() => config.load({ ...BASE_ENV, ADMIN_EMAILS: '' }), /ADMIN_EMAILS/);
  assert.throws(() => config.load({ ...BASE_ENV, WEBSITE_INSTANCE_ID: 'abc' }), /Development switches/);
  assert.throws(() => config.load({ SESSION_SECRET: 'x'.repeat(40), ADMIN_EMAILS: 'a@b.co', WEBSITE_INSTANCE_ID: 'abc', ENGAGE_ALLOWED_ORIGIN: 'http://x' }), /ENGAGE_ALLOWED_ORIGIN/);
  assert.throws(() => config.load({ SESSION_SECRET: 'x'.repeat(40), ADMIN_EMAILS: 'a@b.co' }), /ENGAGE_TABLES_CONNECTION/);
});

test('email addresses are normalised and checked', () => {
  assert.equal(normEmail('  Steve@Example.COM '), 'steve@example.com');
  for (const bad of ['', 'no-at', 'a@b', 'a b@c.com', 'a@b.com/x', 'x#y@z.com', 'x?y@z.com', 'a'.repeat(250) + '@b.co']) assert.equal(normEmail(bad), '', bad);
});

test('the visitor address is the one Azure records, not its own front end', () => {
  assert.equal(visitorIp({ 'x-azure-clientip': '198.51.100.7' }), '198.51.100.7');
  assert.equal(visitorIp({ 'x-forwarded-for': '198.51.100.7:5544, 10.0.0.1' }), '198.51.100.7');
  assert.equal(visitorIp({ 'x-forwarded-for': '[2001:db8::1]:443, 10.0.0.1' }), '2001:db8::1');
  assert.equal(visitorIp({ 'x-forwarded-for': '2001:db8::1' }), '2001:db8::1');
});

// ---------- requests from outside the site ----------
test('changes from another site, or without an Origin header, are refused', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/api/auth/request', { email: 'boss@example.com' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/auth/request', { email: 'boss@example.com' }, { origin: '' })).status, 403);
  assert.equal((await call('POST', '/api/auth/verify', { email: 'boss@example.com', code: '123456' }, { origin: undefined })).status, 403);
});

test('responses carry security headers and are never cached', async () => {
  const { call } = setup();
  const r = await call('GET', '/api/auth/me');
  assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.headers['X-Frame-Options'], 'DENY');
});

// ---------- asking for a code ----------
test('an approved address gets a 6-digit code; every request gets the same answer', async () => {
  const s = setup();
  await s.auth.addApproved('boss@example.com', 'user@example.com');
  const a = await s.call('POST', '/api/auth/request', { email: 'user@example.com' });
  const b = await s.call('POST', '/api/auth/request', { email: 'stranger@example.com' });
  const c = await s.call('POST', '/api/auth/request', { email: 'not an email' });
  assert.deepEqual([a.json, b.json, c.json], [PUBLIC_ANSWER, PUBLIC_ANSWER, PUBLIC_ANSWER]);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].code, /^\d{6}$/);
  assert.equal(s.sent[0].to, 'user@example.com');
});

test('code requests take at least the fixed time, approved or not', async () => {
  const s = setup({ ENGAGE_REQUEST_FLOOR_MS: '150' });
  for (const email of ['boss@example.com', 'nobody@example.com']) {
    const t0 = Date.now();
    await s.call('POST', '/api/auth/request', { email });
    assert.ok(Date.now() - t0 >= 140, email);
  }
});

test('only a hash of the code is stored', async () => {
  const s = setup();
  await s.call('POST', '/api/auth/request', { email: 'boss@example.com' });
  const rec = await s.store.get('codes', 'code', 'boss@example.com');
  assert.ok(!JSON.stringify(rec.data).includes(s.lastCode('boss@example.com')));
});

test('a second code needs 45 seconds, and an address gets at most 5 an hour', async () => {
  const s = setup();
  const req = () => s.auth.requestCode('boss@example.com', '1.1.1.1');
  assert.equal((await req()).outcome, 'sent');
  assert.equal((await req()).outcome, 'too-soon');
  for (let i = 0; i < 4; i++) { s.clock.add(46_000); assert.equal((await req()).outcome, 'sent'); }
  s.clock.add(46_000);
  assert.equal((await req()).outcome, 'address-limited');
  s.clock.add(3_600_000);
  assert.equal((await req()).outcome, 'sent');
});

test('one visitor address is limited across many email addresses', async () => {
  const s = setup();
  let limited = 0;
  for (let i = 0; i < 35; i++) if ((await s.auth.requestCode(`p${i}@example.com`, '9.9.9.9')).outcome === 'ip-limited') limited++;
  assert.equal(limited, 35 - s.cfg.maxRequestsPerIpPerHour);
  assert.equal((await s.auth.requestCode('boss@example.com', '8.8.8.8')).outcome, 'sent', 'other visitors unaffected');
});

test('simultaneous code requests leave exactly one valid code', async () => {
  const s = setup();
  const r = await Promise.all([1, 2, 3].map(() => s.auth.requestCode('boss@example.com', '1.1.1.1')));
  assert.equal(r.filter(x => x.outcome === 'sent').length + r.filter(x => x.outcome === 'raced' || x.outcome === 'too-soon').length, 3);
  const codes = s.sent.map(x => x.code);
  const ok = [];
  for (const c of codes) ok.push((await s.auth.verifyCode('boss@example.com', c)).ok);
  assert.equal(ok.filter(Boolean).length, 1);
});

test('a failed email hand-off keeps the code the user already held', async () => {
  let fail = false; const sent = [];
  const s = setup({}, { mailer: { async send(to, code) { if (fail) throw new Error('down'); sent.push(code); } } });
  await s.auth.requestCode('boss@example.com', '1.1.1.1');
  fail = true; s.clock.add(46_000);
  assert.equal((await s.auth.requestCode('boss@example.com', '1.1.1.1')).outcome, 'mail-failed');
  assert.equal((await s.auth.verifyCode('boss@example.com', sent[0])).ok, true);
});

test('an email hand-off that times out is "unknown" and its code is kept', async () => {
  const codes = [];
  const s = setup({}, { mailer: { send: (to, code) => { codes.push(code); return new Promise(() => {}); } } });
  assert.equal((await s.auth.requestCode('boss@example.com', '1.1.1.1')).outcome, 'mail-unknown');
  assert.equal((await s.auth.verifyCode('boss@example.com', codes[0])).ok, true);
});

test('a storage failure is answered like any other request', async () => {
  const s = setup();
  s.store.failNext = op => op === 'get';
  const r = await s.call('POST', '/api/auth/request', { email: 'boss@example.com' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, PUBLIC_ANSWER);
});

// ---------- checking a code ----------
test('a correct code signs in once; it cannot be used again', async () => {
  const s = setup();
  await s.call('POST', '/api/auth/request', { email: 'boss@example.com' });
  const code = s.lastCode('boss@example.com');
  const r = await s.call('POST', '/api/auth/verify', { email: 'Boss@Example.com', code });
  assert.equal(r.status, 200);
  assert.match(r.headers['Set-Cookie'], /HttpOnly; SameSite=Strict; Max-Age=10800; Secure/);
  assert.equal((await s.call('POST', '/api/auth/verify', { email: 'boss@example.com', code })).status, 400);
});

test('a code expires after 10 minutes', async () => {
  const s = setup();
  await s.auth.requestCode('boss@example.com', '1');
  s.clock.add(10 * 60_000 + 1);
  assert.equal((await s.auth.verifyCode('boss@example.com', s.lastCode('boss@example.com'))).ok, false);
});

test('five wrong attempts use the code up', async () => {
  const s = setup();
  await s.auth.requestCode('boss@example.com', '1');
  const good = s.lastCode('boss@example.com'), bad = good === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await s.auth.verifyCode('boss@example.com', bad)).ok, false);
  assert.equal((await s.auth.verifyCode('boss@example.com', good)).ok, false);
});

test('codes in the wrong shape are rejected without touching the stored code', async () => {
  const s = setup();
  await s.auth.requestCode('boss@example.com', '1');
  for (const c of ['', '12345', '1234567', 'abcdef', null]) assert.equal((await s.auth.verifyCode('boss@example.com', c)).ok, false);
  assert.equal((await s.store.get('codes', 'code', 'boss@example.com')).data.tries, 0);
});

// ---------- sessions ----------
test('a session opens the app; without one the app redirects to sign-in', async () => {
  const s = setup();
  assert.equal((await s.call('GET', '/api/app')).status, 302);
  const ck = await s.signIn('boss@example.com');
  const r = await s.call('GET', '/api/app', null, { cookie: ck });
  assert.equal(r.status, 200);
  assert.match(String(r.body), /ENGAGE/);
  assert.equal(r.headers['X-Frame-Options'], 'SAMEORIGIN');
});

test('a tampered or expired session is refused', async () => {
  const s = setup();
  const ck = await s.signIn('boss@example.com');
  const [name, val] = ck.split('=');
  const [body, sig] = val.split('.');
  const forged = Buffer.from(JSON.stringify({ e: 'boss@example.com', iat: 0, exp: 9e15, n: 'x' })).toString('base64url');
  assert.equal((await s.call('GET', '/api/auth/me', null, { cookie: `${name}=${forged}.${sig}` })).status, 401);
  assert.equal((await s.call('GET', '/api/auth/me', null, { cookie: `${name}=${body}.AAAA` })).status, 401);
  s.clock.add(3 * 3_600_000 + 1);
  assert.equal((await s.call('GET', '/api/auth/me', null, { cookie: ck })).status, 401);
});

test('removing an approval ends that person\'s session at once', async () => {
  const s = setup();
  await s.auth.addApproved('boss@example.com', 'user@example.com');
  const ck = await s.signIn('user@example.com');
  assert.equal((await s.call('GET', '/api/app', null, { cookie: ck })).status, 200);
  await s.auth.removeApproved('boss@example.com', 'user@example.com');
  assert.equal((await s.call('GET', '/api/app', null, { cookie: ck })).status, 302);
});

test('removing an approval also cancels a code already sent', async () => {
  const s = setup();
  await s.auth.addApproved('boss@example.com', 'user@example.com');
  await s.auth.requestCode('user@example.com', '1');
  await s.auth.removeApproved('boss@example.com', 'user@example.com');
  assert.equal(await s.store.get('codes', 'code', 'user@example.com'), null);
  assert.equal((await s.auth.verifyCode('user@example.com', s.lastCode('user@example.com'))).ok, false);
});

test('a code requested while the approval is being removed does not survive', async () => {
  const s = setup();
  await s.auth.addApproved('boss@example.com', 'user@example.com');
  // remove the approval in the moment between writing the code and the re-check
  const orig = s.store.create.bind(s.store);
  s.store.create = async (...a) => { const r = await orig(...a); if (a[0] === 'codes') await s.store.remove('approved', 'user', 'user@example.com'); return r; };
  assert.equal((await s.auth.requestCode('user@example.com', '1')).outcome, 'removed-during-request');
  assert.equal(await s.store.get('codes', 'code', 'user@example.com'), null);
});

test('sign out clears the cookie', async () => {
  const s = setup();
  const r = await s.call('POST', '/api/auth/signout');
  assert.match(r.headers['Set-Cookie'], /engage_session=; .*Max-Age=0/);
});

// ---------- administration ----------
test('only administrators can see or change the approved list', async () => {
  const s = setup();
  await s.auth.addApproved('boss@example.com', 'user@example.com');
  const user = await s.signIn('user@example.com');
  assert.equal((await s.call('GET', '/api/manage/users')).status, 401);
  assert.equal((await s.call('GET', '/api/manage/users', null, { cookie: user })).status, 403);
  assert.equal((await s.call('POST', '/api/manage/users', { email: 'x@example.com' }, { cookie: user })).status, 403);
  const boss = await s.signIn('boss@example.com');
  const add = await s.call('POST', '/api/manage/users', { email: 'New@Example.com' }, { cookie: boss });
  assert.equal(add.status, 200);
  const list = await s.call('GET', '/api/manage/users', null, { cookie: boss });
  assert.deepEqual(list.json.users.map(u => u.email).sort(), ['new@example.com', 'user@example.com']);
  assert.equal(list.json.users.find(u => u.email === 'new@example.com').addedBy, 'boss@example.com');
});

test('the allowed-domain rule applies to approvals and administrators', async () => {
  const s = setup({ AUTH_ALLOWED_DOMAINS: 'example.com' });
  assert.equal((await s.auth.addApproved('boss@example.com', 'x@other.org')).ok, false);
  assert.equal((await s.auth.addApproved('boss@example.com', 'x@example.com')).ok, true);
  assert.equal((await s.auth.addAdmin('boss@example.com', 'y@other.org')).ok, false);
});

test('the approved list has a cap', async () => {
  const s = setup();
  s.cfg.maxApproved = 3;
  for (let i = 0; i < 3; i++) assert.equal((await s.auth.addApproved('boss@example.com', `u${i}@example.com`)).ok, true);
  assert.equal((await s.auth.addApproved('boss@example.com', 'u9@example.com')).ok, false);
});

test('only the permanent administrator can add or remove administrators', async () => {
  const s = setup();
  assert.equal((await s.auth.addAdmin('boss@example.com', 'helper@example.com')).ok, true);
  const helper = await s.signIn('helper@example.com');
  // an added administrator can manage the approved list ...
  assert.equal((await s.call('POST', '/api/manage/users', { email: 'u@example.com' }, { cookie: helper })).status, 200);
  // ... but cannot create or remove administrators
  assert.equal((await s.call('POST', '/api/manage/admins', { email: 'x@example.com' }, { cookie: helper })).status, 403);
  assert.equal((await s.call('DELETE', '/api/manage/admins', { email: 'helper@example.com' }, { cookie: helper })).status, 403);
  const boss = await s.signIn('boss@example.com');
  const admins = await s.call('GET', '/api/manage/admins', null, { cookie: boss });
  assert.deepEqual(admins.json.admins.map(a => [a.email, a.permanent]), [['boss@example.com', true], ['helper@example.com', false]]);
  assert.equal((await s.call('DELETE', '/api/manage/admins', { email: 'boss@example.com' }, { cookie: boss })).status, 400, 'permanent admins are config-only');
  assert.equal((await s.call('DELETE', '/api/manage/admins', { email: 'helper@example.com' }, { cookie: boss })).status, 200);
  assert.equal((await s.call('GET', '/api/manage/users', null, { cookie: helper })).status, 401, 'removed admin is signed out');
});

test('every administrative change is recorded with who made it, before and after', async () => {
  const s = setup();
  await s.auth.addApproved('boss@example.com', 'a@example.com');
  await s.auth.removeApproved('boss@example.com', 'a@example.com');
  await s.auth.addAdmin('boss@example.com', 'h@example.com');
  const log = (await s.auth.listAudit()).reverse().map(x => [x.by, x.action, x.target, x.outcome]);
  assert.deepEqual(log, [
    ['boss@example.com', 'approve', 'a@example.com', 'requested'], ['boss@example.com', 'approve', 'a@example.com', 'done'],
    ['boss@example.com', 'remove approval', 'a@example.com', 'requested'], ['boss@example.com', 'remove approval', 'a@example.com', 'done'],
    ['boss@example.com', 'add administrator', 'h@example.com', 'requested'], ['boss@example.com', 'add administrator', 'h@example.com', 'done'],
  ]);
});

test('a failed change is recorded as failed, not as done', async () => {
  const s = setup();
  s.store.failNext = op => op === 'create' && false;
  const orig = s.store.create.bind(s.store);
  s.store.create = async (t, ...a) => { if (t === 'approved') throw new Error('down'); return orig(t, ...a); };
  await assert.rejects(s.auth.addApproved('boss@example.com', 'a@example.com'));
  const outcomes = (await s.auth.listAudit()).map(x => x.outcome);
  assert.deepEqual(outcomes.sort(), ['failed', 'requested']);
});

test('unknown routes answer 404 and bad JSON answers 400', async () => {
  const s = setup();
  assert.equal((await s.call('GET', '/api/nothing')).status, 404);
  const r = await makeHandler({ auth: s.auth, cfg: s.cfg, appHtmlPath: '/nope' })({ method: 'POST', path: '/api/auth/verify', headers: { origin: ORIGIN }, body: '{bad' });
  assert.equal(r.status, 400);
});
