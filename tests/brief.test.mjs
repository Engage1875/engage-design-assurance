// Project brief tests: frozen-brief change records, response import preview, issued records, PDF.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openApp, goPage, closeBrowser } from './helpers.mjs';
after(closeBrowser);

/** Open the app on the Project brief page and return the brief frame. */
export async function openBrief() {
  const app = await openApp();
  await goPage(app.page, 'brief');
  await app.page.waitForFunction(() => { const f = document.getElementById('briefFrame'); return f && f.contentWindow && f.contentWindow.EngageBrief; });
  const frame = app.page.frames().find(f => f !== app.page.mainFrame());
  return { ...app, frame };
}

/** Give the first asset a template, confirm its first requirement and freeze the brief. */
async function frozenAsset(frame) {
  return frame.evaluate(() => {
    const a = ASSETS[0]; a.tpl = a.tpl || 'Residential'; S.rec[a.id] = S.rec[a.id] || {};
    const R = rows(a); const id = R[0].id, id2 = R[1].id;
    Object.assign(S.rec[a.id][id], { st: 'cf', ans: 'Original answer' });
    S.frozen[a.id] = 'Rev 01'; S.plot = a.plot; S.asset = a.id; S.tab = 'req'; render();
    return { aid: a.id, id, id2 };
  });
}
async function answerDlg(frame, values, ok = true) {
  await frame.waitForSelector('#dlg.on', { state: 'attached' });
  await frame.evaluate(([values, ok]) => {
    const f = [...document.querySelectorAll('#dlg [data-i]')];
    values.forEach((v, i) => { f[i].value = v; });
    document.getElementById(ok ? 'do' : 'dc').click();
  }, [values, ok]);
  await frame.waitForTimeout(200);
}
const fire = (frame, sel, value) => frame.evaluate(([sel, value]) => {
  const e = document.querySelector(sel); if (!e) return false;
  if (typeof value === 'boolean') e.checked = value; else e.value = value;
  e.dispatchEvent(new Event('change', { bubbles: true })); return true;
}, [sel, value]);

test('changing reviewed content of a frozen brief needs a reason and authoriser and is listed on Change flags', async () => {
  const app = await openBrief();
  const { frame, page } = app;
  const { aid, id } = await frozenAsset(frame);
  assert.ok(await fire(frame, `[data-rfld="ans"][data-id="${id}"]`, 'Changed answer'), 'answer field found');
  await answerDlg(frame, ['Client instruction 12', 'A. Person']);
  const st = await frame.evaluate(([aid, id]) => ({ ans: S.rec[aid][id].ans, changes: S.changes }), [aid, id]);
  assert.equal(st.ans, 'Changed answer');
  assert.equal(st.changes.length, 1);
  assert.equal(st.changes[0].reason, 'Client instruction 12');
  assert.equal(st.changes[0].by, 'A. Person');
  assert.deepEqual(st.changes[0].items[0], { id, what: 'Response', from: 'Original answer', to: 'Changed answer' });
  // cancelling leaves content unchanged and records nothing
  await fire(frame, `[data-rfld="ans"][data-id="${id}"]`, 'Second change');
  await answerDlg(frame, [], false);
  assert.equal(await frame.evaluate(([aid, id]) => S.rec[aid][id].ans, [aid, id]), 'Changed answer');
  assert.equal(await frame.evaluate(() => S.changes.length), 1);
  // the main app lists the record on the Change flags page
  await page.waitForTimeout(200);
  await goPage(page, 'flags');
  const txt = await page.textContent('#briefChanges');
  assert.match(txt, /BCR-001/);
  assert.match(txt, /Client instruction 12/);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('status, applicability and template changes on a frozen brief are all recorded', async () => {
  const app = await openBrief();
  const { frame } = app;
  const { aid, id, id2 } = await frozenAsset(frame);
  await frame.evaluate(([aid, id2]) => { S.rec[aid][id2].st = 'as'; render(); }, [aid, id2]);
  const p1 = frame.evaluate(([aid, id]) => setStatus(A_(aid), [id], 'rc'), [aid, id]);
  await answerDlg(frame, ['Reopened', 'B']);
  assert.equal(await p1, true);
  assert.equal(await frame.evaluate(([aid, id]) => S.rec[aid][id].st, [aid, id]), 'rc');
  // applicability toggle on the assumed item
  assert.ok(await fire(frame, `[data-app="${id2}"]`, false), 'applicability box found');
  await answerDlg(frame, ['Scope change', 'C']);
  // template change through the brief profile
  const p3 = frame.evaluate(([aid]) => { const b = document.createElement('button'); b.dataset.a = 'prof'; b.dataset.id = aid; document.body.appendChild(b); b.click(); }, [aid]);
  await p3;
  await frame.waitForSelector('#dlg.on', { state: 'attached' });
  await frame.evaluate(() => { document.querySelector('#dlg select[data-i="0"]').value = 'Office'; document.getElementById('do').click(); });
  await frame.waitForTimeout(200);
  await answerDlg(frame, ['Use changed', 'D']);
  const routes = await frame.evaluate(() => S.changes.map(c => c.route));
  assert.deepEqual(routes, ['Status change', 'Applicability', 'Brief template']);
  // an open (not reviewed) item can still change without a record
  await frame.evaluate(([aid]) => { const r = rows(A_(aid)).find(r => r.rec.st === 'nr'); return setStatus(A_(aid), [r.id], 'rc'); }, [aid]);
  assert.equal(await frame.evaluate(() => S.changes.length), 3);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('response import previews every row, brings ticked rows in as Received and keeps the text exactly', async () => {
  const app = await openBrief();
  const { frame } = app;
  const { aid, id, id2 } = await frozenAsset(frame);
  const id3 = await frame.evaluate(([aid]) => rows(A_(aid))[2].id, [aid]);
  await frame.evaluate(([aid, id, id2, id3]) => {
    delete S.frozen[aid];
    S.rec[aid][id2].st = 'rq';
    S.packs.push({ id: 'RP-009', to: 'Client', assets: [aid], items: [aid + '|' + id, aid + '|' + id2, aid + '|' + id3], n: 3, issued: TODAY, due: TODAY, status: 'Open', issuedBy: 'X', note: '' });
    render();
  }, [aid, id, id2, id3]);
  const q = s => '"' + s.replace(/"/g, '""') + '"';
  const H = ['Request Pack', 'Asset ID', 'Asset', 'Brief ID', 'Section', 'Brief item', 'What must be defined', 'Typical input', 'Provided by', 'Complete by', 'Response status', 'Response / requirement', 'Source / reference'];
  const row = (bid, st, ans) => ['RP-009', aid, 'A', bid, '', '', '', '', '', '', st, ans, ''].map(q).join(',');
  const csv = '﻿' + [H.map(q).join(','), row(id, 'Confirmed', 'Replacing a confirmed item'), row(id2, 'Confirmed', "  Two spaces, \"quotes\"\nand a new line  "), row(id3, '', "'=1+1")].join('\r\n');
  const p = frame.evaluate(async ([csv]) => { const k = S.packs.find(x => x.id === 'RP-009'); await importPackCsv(k, new File([csv], 'r.csv')); }, [csv]);
  await frame.waitForSelector('#dlg.on', { state: 'attached' });
  const preview = await frame.evaluate(() => [...document.querySelectorAll('#db [data-imp]')].map(c => c.checked));
  assert.deepEqual(preview, [false, true, true], 'the reviewed (confirmed) row is not ticked by default');
  await frame.evaluate(() => document.getElementById('do').click());
  await p;
  const r = await frame.evaluate(([aid, id, id2, id3]) => [S.rec[aid][id], S.rec[aid][id2], S.rec[aid][id3]].map(o => ({ st: o.st, ans: o.ans })), [aid, id, id2, id3]);
  assert.deepEqual(r[0], { st: 'cf', ans: 'Original answer' }, 'unticked reviewed item unchanged');
  assert.deepEqual(r[1], { st: 'rc', ans: "  Two spaces, \"quotes\"\nand a new line  " }, 'arrives as Received, text exact');
  assert.deepEqual(r[2], { st: 'rc', ans: '=1+1' }, 'the CSV formula guard is reversed on import');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('Brief PDF prints every requirement across as many pages as needed', async () => {
  const app = await openBrief();
  const { frame } = app;
  const { aid } = await frozenAsset(frame);
  const n = await frame.evaluate(([aid]) => {
    delete S.frozen[aid];
    const R = rows(A_(aid)); R.forEach((r, i) => { S.rec[aid][r.id].st = i < 20 ? 'cf' : 'nr'; S.rec[aid][r.id].ans = 'Answer ' + i + ' ' + 'detail '.repeat(i % 7 * 6); });
    window.print = () => { window.__printed = (window.__printed || 0) + 1; };
    S.iss.scope = 'asset'; S.iss.inc = { cov: 1, sum: 1, req: 1, as: 1, open: 1, na: 0 };
    printPages(docPages([aid], 'P01'));
    return { cf: R.filter(r => S.rec[aid][r.id].st === 'cf').length, open: R.filter(r => S.rec[aid][r.id].st === 'nr').length };
  }, [aid]);
  await frame.waitForFunction(() => window.__printed === 1);
  const r = await frame.evaluate(() => {
    const pa = document.getElementById('printArea');
    const tables = [...pa.querySelectorAll('.page')].map(p => ({ h: p.querySelector('h3') ? p.querySelector('h3').textContent : '', rows: p.querySelectorAll('table.split tr').length - (p.querySelector('table.split') ? 1 : 0), over: p.scrollHeight > p.clientHeight + 1 && !p.classList.contains('bp-overflow') }));
    const sum = re => tables.filter(t => re.test(t.h)).reduce((s, t) => s + t.rows, 0);
    return { pages: tables.length, cf: sum(/confirmed requirements/), open: sum(/open items/), cont: tables.filter(t => /continued/.test(t.h)).length, overflow: tables.filter(t => t.over).length };
  });
  assert.equal(r.cf, n.cf, 'every confirmed requirement printed');
  assert.equal(r.open, n.open, 'every open item printed (v132 stopped at 45)');
  assert.ok(r.cont > 0, 'long tables continue on further pages');
  assert.equal(r.overflow, 0, 'no page overflows its A4 height');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('an issued brief and an issued request pack print from the copy kept at issue', async () => {
  const app = await openBrief();
  const { frame } = app;
  const { aid, id } = await frozenAsset(frame);
  const r = await frame.evaluate(([aid, id]) => {
    delete S.frozen[aid];
    window.print = () => {};
    // brief issue with its stored copy
    S.issues.push({ rev: '01', assets: [aid], status: 'Issued – brief freeze', at: TODAY, by: 'X', must: 0, snap: briefModel([aid], '01', 'Issued – brief freeze', { cov: 1, sum: 0, req: 1, as: 0, open: 0, na: 0 }) });
    // request pack with its stored copy
    const k = { id: 'RP-050', to: 'Client', assets: [aid], items: [aid + '|' + id], n: 1, issued: TODAY, due: TODAY, status: 'Open', issuedBy: 'X', note: '' };
    S.packs.push(k); packSnapshot(k);
    // the live brief changes after issue
    S.rec[aid][id].ans = 'Changed later'; A_(aid).name = 'Renamed asset';
    printPages(docPagesFrom(S.issues[S.issues.length - 1].snap));
    const brief = document.getElementById('printArea').textContent;
    printPages(packPages(k));
    const pack = document.getElementById('printArea').textContent;
    const legacy = { ...k, snap: null, id: 'RP-051' }; S.packs.push(legacy);
    printPages(packPages(legacy));
    const old = document.getElementById('printArea').textContent;
    return { brief, pack, old };
  }, [aid, id]);
  assert.match(r.brief, /Original answer/);
  assert.ok(!/Changed later|Renamed asset/.test(r.brief), 'brief issue prints what was issued');
  assert.ok(!/Renamed asset/.test(r.pack), 'pack prints the asset name as issued');
  assert.match(r.old, /Legacy record/);
  assert.deepEqual(app.errors, []);
  await app.close();
});
