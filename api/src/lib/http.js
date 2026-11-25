'use strict';
// HTTP routes of the sign-in service, independent of Azure Functions so the same code runs
// in Azure, in the local dev server and in tests.
//
//   POST   /api/auth/request    {email}        always the same answer, after a fixed time
//   POST   /api/auth/verify     {email, code}  sets the session cookie
//   POST   /api/auth/signout
//   GET    /api/auth/me
//   GET    /api/app                            the ENGAGE app, only with a valid session
//   GET    /api/manage/users | POST {email} | DELETE {email}     administrators
//   GET    /api/manage/admins | POST {email} | DELETE {email}    permanent administrators change it
//   GET    /api/manage/audit
//
// Every POST and DELETE must come from the site itself (Origin header equal to the
// configured address). Requests without an Origin header are refused.

const fs = require('node:fs');
const path = require('node:path');

const COOKIE = 'engage_session';
const PUBLIC_ANSWER = { ok: true, message: 'If this address is approved, a sign-in code is on its way. It expires in 10 minutes.' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function cookies(h) {
  const out = {};
  String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}

/** The visitor's address. Azure's front end records it in x-azure-clientip; x-forwarded-for
 *  lists the visitor first and Azure's own front end after it (v133 used the wrong one). */
function visitorIp(headers, fallback) {
  const a = headers['x-azure-clientip'] || String(headers['x-forwarded-for'] || '').split(',')[0] || fallback || '';
  const s = String(a).trim();
  if (s.startsWith('[')) return s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined); // [IPv6]:port
  if ((s.match(/:/g) || []).length === 1) return s.split(':')[0];                           // IPv4:port
  return s;                                                                                  // IPv4 or IPv6
}

const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

function makeHandler({ auth, cfg, appHtmlPath, now = () => Date.now() }) {
  let appHtml = null;
  const loadApp = () => {
    if (appHtml === null) appHtml = fs.existsSync(appHtmlPath) ? fs.readFileSync(appHtmlPath) : Buffer.from('');
    return appHtml;
  };
  const json = (status, obj, extra) => ({ status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...(extra || {}) }, body: JSON.stringify(obj) });
  const cookie = (value, maxAgeS) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${cfg.secureCookie ? '; Secure' : ''}`;

  const originOk = h => {
    const o = h.origin;
    if (!o) return false;
    if (cfg.origin) return o === cfg.origin;
    return !cfg.azure && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o); // development only
  };

  return async function handle(req) {
    const h = req.headers || {}, method = (req.method || 'GET').toUpperCase(), p = (req.path || '/').replace(/\/+$/, '') || '/';
    const ip = visitorIp(h, req.remoteAddress);
    const changing = method !== 'GET' && method !== 'HEAD';
    if (changing && !originOk(h)) return json(403, { ok: false, error: 'Request refused.' });
    let body = {};
    if (changing && req.body) { try { body = JSON.parse(req.body); } catch { return json(400, { ok: false, error: 'Bad request.' }); } }
    if (!body || typeof body !== 'object') body = {};
    const user = await auth.readSession(cookies(h.cookie)[COOKIE]).catch(() => null);

    try {
      if (p === '/api/auth/request' && method === 'POST') {
        // One answer, after one fixed time, whatever happened: the approved list cannot be inferred.
        const start = now();
        const r = await auth.requestCode(body.email, ip);
        if (req.onOutcome) req.onOutcome(r);
        await sleep(cfg.requestFloorMs - (now() - start));
        return json(200, PUBLIC_ANSWER);
      }
      if (p === '/api/auth/verify' && method === 'POST') {
        const r = await auth.verifyCode(body.email, body.code);
        if (!r.ok) return json(400, { ok: false, error: 'That code is not valid or has expired. Ask for a new one if needed.' });
        const role = await auth.role(r.email);
        return json(200, { ok: true, ...role }, { 'Set-Cookie': cookie(auth.makeSession(r.email), Math.floor(cfg.sessionMs / 1000)) });
      }
      if (p === '/api/auth/signout' && method === 'POST') return json(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
      if (p === '/api/auth/me' && method === 'GET') return user ? json(200, { ok: true, ...user }) : json(401, { ok: false });

      if (p === '/api/app' && method === 'GET') {
        if (!user) return { status: 302, headers: { ...SECURITY_HEADERS, Location: '/' }, body: '' };
        const html = loadApp();
        if (!html.length) return json(503, { ok: false, error: 'The app has not been built into this deployment.' });
        // X-Frame-Options SAMEORIGIN: the app embeds its own Project brief frame.
        return { status: 200, headers: { ...SECURITY_HEADERS, 'X-Frame-Options': 'SAMEORIGIN', 'Content-Type': 'text/html; charset=utf-8' }, body: html };
      }

      if (p.startsWith('/api/manage/')) {
        if (!user) return json(401, { ok: false, error: 'Sign in first.' });
        if (!user.admin) return json(403, { ok: false, error: 'Administrators only.' });
        const what = p.slice('/api/manage/'.length);
        if (what === 'users') {
          if (method === 'GET') return json(200, { ok: true, users: await auth.listApproved(), me: user, domains: cfg.domains, max: cfg.maxApproved });
          if (method === 'POST') { const r = await auth.addApproved(user.email, body.email); return json(r.ok ? 200 : (r.status || 400), r); }
          if (method === 'DELETE') { const r = await auth.removeApproved(user.email, body.email); return json(r.ok ? 200 : (r.status || 400), r); }
        }
        if (what === 'admins') {
          if (method === 'GET') return json(200, { ok: true, admins: await auth.listAdmins(), me: user });
          if (method === 'POST') { const r = await auth.addAdmin(user.email, body.email); return json(r.ok ? 200 : (r.status || 400), r); }
          if (method === 'DELETE') { const r = await auth.removeAdmin(user.email, body.email); return json(r.ok ? 200 : (r.status || 400), r); }
        }
        if (what === 'audit' && method === 'GET') return json(200, { ok: true, audit: await auth.listAudit() });
      }
      return json(404, { ok: false, error: 'Not found.' });
    } catch (e) {
      console.error('ENGAGE api error', e && e.message);
      return json(500, { ok: false, error: 'Something went wrong. Try again.' });
    }
  };
}

module.exports = { makeHandler, visitorIp, cookies, COOKIE, PUBLIC_ANSWER, SECURITY_HEADERS, defaultAppPath: path.join(__dirname, '..', '..', 'app', 'Engage.html') };
