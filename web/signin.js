(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const fEmail = $('fEmail'), fCode = $('fCode'), msg = $('msg');
  let email = '';
  const call = async (m, p, b) => {
    const r = await fetch(p, { method: m, credentials: 'same-origin', headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
    let d = {}; try { d = await r.json(); } catch (e) { /* empty */ }
    return { status: r.status, ok: r.ok, data: d };
  };
  const say = (t, k) => { msg.textContent = t || ''; msg.className = 'msg' + (k ? ' ' + k : ''); };

  async function me() {
    const r = await call('GET', '/api/auth/me');
    if (r.ok) { $('who').textContent = r.data.email; $('adminLink').hidden = !r.data.admin; $('signedIn').hidden = false; }
    return r.ok ? r.data : null;
  }

  fEmail.addEventListener('submit', async e => {
    e.preventDefault();
    email = $('email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('Enter your email address.', 'bad'); return; }
    $('bSend').disabled = true; say('Sending…');
    try {
      const r = await call('POST', '/api/auth/request', { email });
      say(r.data.message || 'If this address is approved, a code is on its way.', 'ok');
      fEmail.hidden = true; fCode.hidden = false; $('code').value = ''; $('code').focus();
    } catch (err) { say('Could not reach ENGAGE. Check your connection and try again.', 'bad'); }
    finally { $('bSend').disabled = false; }
  });

  fCode.addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('code').value.trim();
    if (!/^\d{6}$/.test(code)) { say('Enter the 6-digit code from the email.', 'bad'); return; }
    $('bVerify').disabled = true; say('Checking…');
    try {
      const r = await call('POST', '/api/auth/verify', { email, code });
      if (r.ok) { say('Signed in. Opening ENGAGE…', 'ok'); location.assign('/app'); return; }
      say(r.data.error || 'That code did not work.', 'bad');
    } catch (err) { say('Could not reach ENGAGE. Try again.', 'bad'); }
    finally { $('bVerify').disabled = false; }
  });

  $('bBack').addEventListener('click', () => { fCode.hidden = true; fEmail.hidden = false; say(''); $('email').focus(); });
  $('signOut').addEventListener('click', async e => { e.preventDefault(); await call('POST', '/api/auth/signout'); location.reload(); });
  me();
})();
