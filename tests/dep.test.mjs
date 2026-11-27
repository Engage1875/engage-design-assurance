// Design earned progress (DEP) pilot tests: the acceptance cases in section 10 of the
// DEP specification v1.0 (13 Nov 2026), plus the page working against real project data.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openApp, goPage, closeBrowser } from './helpers.mjs';

after(closeBrowser);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const rep = (n, s) => Array(n).fill(s);

let shared;
async function app() { if (!shared) shared = await openApp(); return shared; }
const core = async o => (await app()).page.evaluate(o => DEP.core(o), o);

// 20 applicable: 5 submitted, 10 accepted, 5 with no credit
const base = [...rep(5, 'SUB'), ...rep(10, 'APP'), ...rep(5, 'IP')];

test('spec 10.1: 20 applicable, 5 submitted, 10 accepted, D=1, M=1 gives I=70%, DEP=70%', async () => {
  const r = await core({ D: 1, M: 1, statuses: base });
  near(r.I, 0.7, 'I'); near(r.dep, 0.7, 'DEP');
});

test('spec 10.2: same inputs with M=0.9 gives DEP=63%', async () => {
  near((await core({ D: 1, M: 0.9, statuses: base })).dep, 0.63, 'DEP');
});

test('spec 10.3: same inputs with D=0 gives DEP=0%', async () => {
  near((await core({ D: 0, M: 1, statuses: base })).dep, 0, 'DEP');
});

test('spec 10.4: all 20 accepted gives DEP=100%', async () => {
  near((await core({ D: 1, M: 1, statuses: rep(20, 'APP') })).dep, 1, 'DEP');
  near((await core({ D: 1, M: 1, statuses: rep(20, 'CLS') })).dep, 1, 'Closed counts as accepted');
});

test('spec 10.5: zero applicable interfaces is not assessable, never 100% or a division by zero', async () => {
  for (const statuses of [[], rep(4, 'NA')]) {
    const r = await core({ D: 1, M: 1, statuses });
    assert.equal(r.assessable, false); assert.equal(r.dep, null);
  }
});

test('spec 10.6: 5 N/A are excluded, leaving a denominator of 15 and I=93.33%', async () => {
  const r = await core({ D: 1, M: 1, statuses: [...rep(5, 'NA'), ...rep(5, 'SUB'), ...rep(10, 'APP')] });
  assert.equal(r.napp, 15); near(r.I, 14 / 15, 'I');
});

test('status credits follow the specification table', async () => {
  const p = (await app()).page;
  const c = await p.evaluate(() => Object.fromEntries(['', 'IP', 'WC', 'SUB', 'AWC', 'APP', 'CLS', 'NA'].map(s => [s || 'NS', DEP.credit(s, DEP.defaults())])));
  assert.deepEqual(c, { NS: 0, IP: 0, WC: 0, SUB: 0.8, AWC: 0.8, APP: 1, CLS: 1, NA: null });
});

test('coordination ceiling is reported alongside: I=0.8, M=0.5 gives 40% and 50%', async () => {
  const r = await core({ D: 1, M: 0.5, statuses: [...rep(4, 'SUB'), ...rep(1, 'SUB')] });
  near(r.dep, 0.4, 'multiplication'); near(r.ceil, 0.5, 'ceiling');
});

test('spec 10.7: an interface linked to two deliverables counts in both, each weight once', async () => {
  const p = (await app()).page;
  const r = await p.evaluate(() => DEP.rollup([
    { w: 3, r: DEP.core({ D: 1, M: 1, statuses: ['APP', 'IP'] }) },
    { w: 1, r: DEP.core({ D: 1, M: 1, statuses: ['APP'] }) },
    { w: 5, r: DEP.core({ D: 1, M: 1, statuses: [] }) }]));
  near(r.dep, (3 * 0.5 + 1 * 1) / 4, 'weighted DEP'); assert.equal(r.w, 4); assert.equal(r.nx, 1);
});

test('the page works on project data: links, levels, stage rule, N/A and reopening', async () => {
  const a = await openApp(); const p = a.page;
  await goPage(p, 'dep');
  await p.click('[data-dp="samples"]');
  const n = await p.evaluate(() => S.dep.items.length);
  assert.ok(n > 0 && n <= 10, `${n} sample deliverables (at most 10)`);
  const r = await p.evaluate(() => {
    const a = S.assets[0], x = S.dep.items.find(y => y.links.length >= 4);
    x.docNo = 'TEST-001'; x.suit = 'S2'; x.m = { st: 'acc', ref: 'CR-1', note: '' };
    const keys = DEP.calc(x).counted.map(e => e.key);
    keys.forEach((k, i) => { a.status[k] = i % 2 ? 'APP' : 'SUB'; });
    const before = DEP.calc(x);
    a.status[keys[1]] = 'IP';                       // an accepted decision is reopened
    const reopened = DEP.calc(x);
    a.status[keys[0]] = 'NA';                       // N/A with no recorded reason
    const na = DEP.calc(x);
    x.m = { st: 'na', ref: '', note: '' };          // coordination N/A needs a reason
    const mna = DEP.calc(x);
    return { n: keys.length, before, reopened, na: { napp: na.napp, ex: na.ex }, mna: { M: mna.M, ex: mna.ex } };
  });
  const half = Math.ceil(r.n / 2), acc = Math.floor(r.n / 2);
  near(r.before.I, (0.8 * half + acc) / r.n, 'I before');
  assert.ok(r.reopened.dep < r.before.dep, 'reopening lowers current DEP');
  assert.equal(r.na.napp, r.n - 1);
  assert.ok(r.na.ex.some(t => /N\/A entr.*no recorded reason/.test(t)));
  assert.equal(r.mna.M, 0); assert.ok(r.mna.ex.some(t => /without a reason/.test(t)));
  await p.evaluate(() => DEP.render());
  assert.ok(await p.isVisible('#pg-dep .dp-t'));
  assert.deepEqual(a.errors, []);
  await a.close();
});

test('deliverables survive save, reload and an older project without them', async () => {
  const a = await openApp(); const p = a.page;
  await goPage(p, 'dep');
  await p.click('[data-dp="add"]');
  await p.fill('[data-dpf="id"]', 'ZZ-001'); await p.press('[data-dpf="id"]', 'Tab');
  const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('aptInterfaceTool.v1')));
  assert.equal(stored.dep.items[0].id, 'ZZ-001'); assert.equal(stored.version, 57);
  await a.close();
  // a v134 project (no dep section) opens with an empty deliverables list
  const old = JSON.parse(JSON.stringify(stored)); delete old.dep; old.version = 56;
  const b = await openApp({ storage: { 'aptInterfaceTool.v1': JSON.stringify(old) } });
  assert.deepEqual(await b.page.evaluate(() => [S.dep.items.length, S.dep.disc]), [0, ['Architecture', 'Structures', 'MEP']]);
  await goPage(b.page, 'dep');
  assert.deepEqual(b.errors, []);
  await b.close();
});

test('CSV export guards formulas and has one row per deliverable', async () => {
  const a = await openApp(); const p = a.page;
  await goPage(p, 'dep');
  await p.click('[data-dp="samples"]');
  await p.evaluate(() => { S.dep.items[0].title = '=HYPERLINK("x")'; });
  const dl = p.waitForEvent('download');
  await p.click('[data-dp="csv"]');
  const text = fs.readFileSync(await (await dl).path(), 'utf8');
  const lines = text.trim().split(/\r\n/);
  assert.equal(lines.length, 1 + await p.evaluate(() => S.dep.items.length));
  assert.ok(text.includes(`"'=HYPERLINK(""x"")"`));
  await a.close();
});

after(async () => { if (shared) await shared.close(); });
