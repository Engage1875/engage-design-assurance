// ENGAGE app regression tests. Run: npm test (after python3 tools/build.py).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openApp, pages, goPage, closeBrowser, ROOT } from './helpers.mjs';

after(closeBrowser);
const KEY = 'aptInterfaceTool.v1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engage-test-'));
const writeTmp = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p; };

async function demoProject(page) { return page.evaluate(() => JSON.parse(JSON.stringify(S))); }
async function chooseFile(page, file) {
  await page.setInputFiles('#fileIn', file);
  await page.waitForTimeout(300);
}

test('every page draws without errors', async () => {
  const app = await openApp();
  const ps = await pages(app.page);
  assert.equal(ps.length, 11);
  for (const p of ps) await goPage(app.page, p);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('version comes from the single build constant', async () => {
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').split('\n')[0].trim();
  const app = await openApp();
  const v = await app.page.evaluate(() => ({ b: ENGAGE_BUILD.ver, s: SRCB.ver, footer: document.getElementById('ifVer').textContent }));
  assert.deepEqual(v, { b: version, s: version, footer: version });
  const html = fs.readFileSync(path.join(ROOT, 'dist', 'Engage.html'), 'utf8');
  assert.ok(!/["']v13[12]["']/.test(html), 'no hard-coded v131/v132 version strings');
  await app.close();
});

test('a stored project that cannot be read is set aside, not overwritten', async () => {
  const broken = '{"assets":[ this is not json';
  const app = await openApp({ storage: { [KEY]: broken } });
  const r = await app.page.evaluate(k => ({ aside: localStorage.getItem(k + '.setAside'), notice: !!document.querySelector('[data-notice="setaside"]'), assets: S.assets.length }), KEY);
  assert.equal(r.aside, broken);
  assert.ok(r.notice, 'notice shown');
  assert.ok(r.assets > 0, 'app started with the sample project');
  const dl = app.page.waitForEvent('download');
  await app.page.click('[data-notice="setaside"] button:has-text("Download set-aside copy")');
  const d = await dl;
  assert.equal(fs.readFileSync(await d.path(), 'utf8'), broken);
  await app.close();
});

test('a stored project that breaks migration is set aside and the tool still starts', async () => {
  const bad = JSON.stringify({ assets: [null, 5] });
  const app = await openApp({ storage: { [KEY]: bad } });
  const r = await app.page.evaluate(k => ({ aside: localStorage.getItem(k + '.setAside'), ok: typeof renderAll === 'function', tabs: document.querySelectorAll('.ptab[data-p]').length }), KEY);
  assert.equal(r.aside, bad);
  assert.ok(r.tabs > 0);
  await app.close();
});

test('Open shows a preview, opens the project, and Restore previous brings the old one back', async () => {
  const app = await openApp();
  const p = app.page;
  const proj = await demoProject(p);
  const before = proj.project;
  proj.project = 'Opened Project';
  proj.assets = proj.assets.slice(0, 1);
  await chooseFile(p, writeTmp('open.json', JSON.stringify(proj)));
  assert.ok(await p.isVisible('#v116ClearProject.on'), 'preview dialog shown');
  assert.match(await p.textContent('#v116Body'), /Opened Project/);
  assert.equal(await p.evaluate(() => S.project), before, 'nothing changes before confirming');
  await p.click('[data-v116="open-confirm"]');
  await p.waitForTimeout(400);
  assert.equal(await p.evaluate(() => S.project), 'Opened Project');
  assert.equal(await p.evaluate(k => JSON.parse(localStorage.getItem(k)).project, KEY), 'Opened Project');
  assert.ok(await p.isVisible('#btnRestoreProject'));
  await p.click('#btnRestoreProject');
  await p.click('[data-v116="restore"]');
  await p.waitForTimeout(400);
  assert.equal(await p.evaluate(() => S.project), before);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('Open of a file that is not a project leaves everything unchanged', async () => {
  const app = await openApp();
  const p = app.page;
  const before = await p.evaluate(k => localStorage.getItem(k), KEY);
  for (const [name, text] of [['bad.json', 'not json'], ['noassets.json', '{"project":"x"}'], ['badid.json', JSON.stringify({ assets: [{ id: '"><img src=x>', name: 'A', zones: [] }] })]]) {
    await chooseFile(p, writeTmp(name, text));
    assert.ok(!(await p.isVisible('#v116ClearProject.on')), name + ': no dialog');
    assert.match(await p.textContent('#v116Toast'), /Open did not run/, name);
    assert.equal(await p.evaluate(k => localStorage.getItem(k), KEY), before, name + ': storage unchanged');
  }
  await app.close();
});

test('Open that fails while drawing rolls back to the previous project', async () => {
  const app = await openApp();
  const p = app.page;
  const before = await p.evaluate(k => localStorage.getItem(k), KEY);
  const proj = await demoProject(p);
  proj.project = 'Will fail';
  await p.evaluate(() => { const r = window.renderAll; window.renderAll = function () { if (S.project === 'Will fail') throw new Error('draw failed'); return r.apply(this, arguments); }; });
  await chooseFile(p, writeTmp('fail.json', JSON.stringify(proj)));
  await p.click('[data-v116="open-confirm"]');
  await p.waitForTimeout(300);
  assert.match(await p.textContent('#v116Error'), /put back unchanged/);
  assert.equal(await p.evaluate(k => localStorage.getItem(k), KEY), before);
  assert.notEqual(await p.evaluate(() => S.project), 'Will fail');
  await app.close();
});

test('a notice appears when the browser refuses to store the project', async () => {
  const app = await openApp();
  const p = app.page;
  await p.evaluate(() => { Storage.prototype._set = Storage.prototype.setItem; Storage.prototype.setItem = function () { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; }; save(); });
  assert.ok(await p.isVisible('[data-notice="quota"]'));
  await p.evaluate(() => { Storage.prototype.setItem = Storage.prototype._set; save(); });
  assert.ok(!(await p.isVisible('[data-notice="quota"]')), 'notice clears once storing works again');
  await app.close();
});

test('a notice appears when another tab changes the project', async () => {
  const app = await openApp();
  const p2 = await app.context.newPage();
  await p2.goto(app.page.url());
  await p2.waitForFunction(() => typeof window.renderAll === 'function');
  await p2.evaluate(() => { S.project = 'Changed elsewhere'; save(); });
  await app.page.waitForTimeout(300);
  assert.ok(await app.page.isVisible('[data-notice="othertab"]'));
  await app.close();
});

test('CSV rule neutralises formula-like text and leaves numbers alone', async () => {
  const app = await openApp();
  const r = await app.page.evaluate(() => ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '-5', '+3.5', '12%', '-', 'plain', 5, null].map(csvGuard));
  assert.deepEqual(r, ["'=1+1", "'+SUM(A1)", "'-2+3", "'@cmd", "'\tx", '-5', '+3.5', '12%', '-', 'plain', '5', '']);
  await app.close();
});

test('every CSV export from the main app applies the rule', async () => {
  const app = await openApp();
  const p = app.page;
  await p.evaluate(() => { S.project = '=HYPERLINK("http://x","p")'; S.assets[0].name = '=cmd|calc'; save(); renderAll(); });
  for (const btn of ['#btnCsv', '#btnLog']) {
    const dl = p.waitForEvent('download');
    await p.click(btn);
    const text = fs.readFileSync(await (await dl).path(), 'utf8');
    assert.ok(!/(^|,)"=/m.test(text), btn + ': no cell starts with =');
  }
  await app.close();
});

test('Content-Security-Policy lets the app run but blocks injected script', async () => {
  const app = await openApp();
  const p = app.page;
  await goPage(p, 'brief');
  await p.waitForFunction(() => { const f = document.getElementById('briefFrame'); return f && f.contentWindow && f.contentWindow.EngageBrief; });
  const r = await p.evaluate(async () => {
    document.body.insertAdjacentHTML('beforeend', '<img src="x" onerror="window.__xss=1"><a id="jsl" href="javascript:window.__xss=2">x</a>');
    document.getElementById('jsl').click();
    const f = document.getElementById('briefFrame').contentDocument;
    f.body.insertAdjacentHTML('beforeend', '<img src="x" onerror="parent.__xss=3">');
    await new Promise(r => setTimeout(r, 300));
    return { xss: window.__xss, csp: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]') };
  });
  assert.deepEqual(r, { xss: undefined, csp: true });
  app.errors.length = 0; // the blocked attempts are reported as console errors, as intended
  await app.close();
});

test('links from project files are followed only when plain http(s)', async () => {
  const app = await openApp();
  const r = await app.page.evaluate(() => ['https://a.b/c', 'http://x', 'javascript:alert(1)', ' JAVASCRIPT:x', 'data:text/html,x', 'https://a b', 'ftp://x'].map(webUrl));
  assert.deepEqual(r, ['https://a.b/c', 'http://x', '', '', '', '', '']);
  await app.close();
});

test('the Admin button is hidden when the app is opened as a file', async () => {
  const app = await openApp();
  assert.equal(await app.page.locator('#btnAdmin').count(), 1);
  assert.equal(await app.page.isVisible('#btnAdmin'), false);
  assert.equal(await app.page.isVisible('#btnReset'), true);
  assert.deepEqual(app.errors, []);
  await app.close();
});
