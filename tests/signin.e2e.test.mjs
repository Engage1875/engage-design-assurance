// End-to-end: the sign-in page, the admin page and the app behind sign-in, in a real browser
// against tools/dev_server.js (codes are read from the dev server instead of email).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getBrowser, closeBrowser, ROOT } from './helpers.mjs';

const PORT = 18788, BASE = `http://localhost:${PORT}`;
let server;
before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'tools', 'dev_server.js'), String(PORT)], { env: { ...process.env, ADMIN_EMAILS: 'admin@example.com', ENGAGE_REQUEST_FLOOR_MS: '50' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('dev server did not start');
});
after(async () => { server && server.kill(); await closeBrowser(); });

async function signIn(page, email) {
  await page.goto(BASE + '/');
  await page.fill('#email', email);
  await page.click('#bSend');
  await page.waitForSelector('#fCode:not([hidden])');
  const codes = await (await fetch(BASE + '/__dev/codes')).json();
  const code = [...codes].reverse().find(c => c.to === email)?.code;
  await page.fill('#code', code || '000000');
  await page.click('#bVerify');
}

test('the app is not reachable without signing in', async () => {
  const r = await fetch(BASE + '/app', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  const s = await fetch(BASE + '/api/app', { redirect: 'manual' });
  assert.equal(s.status, 302);
});

test('sign-in page has a strict Content-Security-Policy', async () => {
  const r = await fetch(BASE + '/');
  assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/);
});

test('an administrator signs in with an emailed code, opens ENGAGE and approves a colleague', async () => {
  const b = await getBrowser();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await signIn(page, 'admin@example.com');
  await page.waitForURL(BASE + '/app');
  await page.waitForFunction(() => typeof window.renderAll === 'function');
  assert.match(await page.title(), /ENGAGE/);
  // administrators see the Admin button in the toolbar, next to Reset; it opens the admin page
  assert.equal(await page.isVisible('#btnAdmin'), true);
  assert.equal(await page.evaluate(() => document.getElementById('btnReset').nextElementSibling.id), 'btnAdmin');
  await page.click('#btnAdmin');
  await page.waitForURL(BASE + '/admin.html');
  await page.waitForSelector('#usersCard:not([hidden])');
  await page.fill('#newUser', 'colleague@example.com');
  await page.click('#fAddUser button');
  await page.waitForFunction(() => document.getElementById('users').textContent.includes('colleague@example.com'));
  assert.match(await page.textContent('#audit'), /approve/);
  assert.deepEqual(errors, []);

  // the colleague can sign in but cannot open the admin page
  const ctx2 = await b.newContext();
  const p2 = await ctx2.newPage();
  await signIn(p2, 'colleague@example.com');
  await p2.waitForURL(BASE + '/app');
  await p2.waitForFunction(() => typeof window.renderAll === 'function');
  assert.equal(await p2.isVisible('#btnAdmin'), false);
  await p2.goto(BASE + '/admin.html');
  await p2.waitForFunction(() => /not an administrator/.test(document.getElementById('whoLine').textContent));
  await ctx.close(); await ctx2.close();
});

test('an unapproved address sees the same message and no code is sent', async () => {
  const b = await getBrowser();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  const before = (await (await fetch(BASE + '/__dev/codes')).json()).length;
  await page.goto(BASE + '/');
  await page.fill('#email', 'stranger@example.com');
  await page.click('#bSend');
  await page.waitForSelector('#fCode:not([hidden])');
  assert.match(await page.textContent('#msg'), /If this address is approved/);
  assert.equal((await (await fetch(BASE + '/__dev/codes')).json()).length, before);
  await ctx.close();
});
