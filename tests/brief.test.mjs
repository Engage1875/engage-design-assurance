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
