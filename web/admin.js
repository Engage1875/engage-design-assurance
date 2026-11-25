(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const msg = $('msg');
  const say = (t, k) => { msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); };
  const call = async (m, p, b) => {
    const r = await fetch(p, { method: m, credentials: 'same-origin', headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    let d = {}; try { d = await r.json(); } catch (e) { /* empty */ }
    return { status: r.status, ok: r.ok, data: d };
  };
  // Build table rows with textContent only, so no address can be read as markup.
  function row(cells, action) {
    const tr = document.createElement('tr');
    cells.forEach(c => { const td = document.createElement('td'); td.textContent = c == null ? '' : String(c); tr.appendChild(td); });
    const td = document.createElement('td');
    if (action) { const b = document.createElement('button'); b.type = 'button'; b.className = 'sec sm'; b.textContent = action.label; b.onclick = action.run; td.appendChild(b); }
    tr.appendChild(td);
    return tr;
  }
  const when = s => (s ? String(s).slice(0, 16).replace('T', ' ') : '');
  let me = null;

  async function load() {
    const u = await call('GET', '/api/manage/users');
    if (u.status === 401) { $('whoLine').textContent = 'You are not signed in.'; say('Sign in on the sign-in page first.', 'bad'); return; }
    if (u.status === 403) { $('whoLine').textContent = 'Your address is not an administrator.'; return; }
    if (!u.ok) { say(u.data.error || 'Could not load the approved list.', 'bad'); return; }
    me = u.data.me;
    $('whoLine').textContent = 'Signed in as ' + me.email + (me.permanentAdmin ? ' (permanent administrator)' : ' (administrator)');
    $('usersCard').hidden = false; $('adminsCard').hidden = false; $('auditCard').hidden = false;
    $('userCount').textContent = u.data.users.length + ' of ' + u.data.max;
    if (u.data.domains && u.data.domains.length) { $('domainNote').hidden = false; $('domainNote').textContent = 'Only addresses at ' + u.data.domains.join(', ') + ' can be approved.'; }
    $('users').replaceChildren(...u.data.users.map(x => row([x.email, x.addedBy, when(x.addedAt)], { label: 'Remove', run: () => change('DELETE', '/api/manage/users', x.email, 'Remove ' + x.email + ' from the approved list?') })));
    const a = await call('GET', '/api/manage/admins');
    if (a.ok) {
      $('fAddAdmin').hidden = !me.permanentAdmin;
      $('admins').replaceChildren(...a.data.admins.map(x => row([x.email, x.permanent ? 'Permanent' : 'Added', x.addedBy || 'App configuration'],
        !x.permanent && me.permanentAdmin ? { label: 'Remove', run: () => change('DELETE', '/api/manage/admins', x.email, 'Remove ' + x.email + ' as an administrator?') } : null)));
    }
    const l = await call('GET', '/api/manage/audit');
    if (l.ok) $('audit').replaceChildren(...l.data.audit.slice(0, 50).map(x => { const r = row([when(x.at), x.by, x.action, x.target, x.outcome]); r.lastChild.remove(); return r; }));
  }

  async function change(method, path, email, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    say('Saving…');
    const r = await call(method, path, { email });
    if (r.ok) say(r.data.already ? 'Already on the list.' : 'Saved.', 'ok'); else say(r.data.error || 'That did not work.', 'bad');
    await load();
  }

  $('fAddUser').addEventListener('submit', e => { e.preventDefault(); const v = $('newUser').value.trim(); if (v) change('POST', '/api/manage/users', v).then(() => { $('newUser').value = ''; }); });
  $('fAddAdmin').addEventListener('submit', e => { e.preventDefault(); const v = $('newAdmin').value.trim(); if (v) change('POST', '/api/manage/admins', v).then(() => { $('newAdmin').value = ''; }); });
  load();
})();
