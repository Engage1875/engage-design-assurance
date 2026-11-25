'use strict';
// The sign-in rules, kept apart from HTTP so they can be tested directly.
//
// Who can sign in: the permanent administrators (ADMIN_EMAILS), added administrators,
// and addresses on the approved list. If AUTH_ALLOWED_DOMAINS is set, approved and added
// addresses must also be at one of those domains.
//
// A code: 6 digits, emailed, valid for 10 minutes, single use, 5 wrong attempts at most,
// at least 45 seconds between sends and 5 sends an hour per address. Only a keyed hash of
// the code is stored. Approval is read fresh on every request, so a removal takes effect at once.

const crypto = require('node:crypto');
const { ConflictError } = require('./store');

const EMAIL_RE = /^[a-z0-9.!$%&'*+=^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : '';
}

const b64u = b => Buffer.from(b).toString('base64url');
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest();
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

class AuthService {
  constructor({ cfg, store, mailer, now = () => Date.now(), log = console }) {
    Object.assign(this, { cfg, store, mailer, now, log });
  }

  // ---------- who is who ----------
  domainOk(email) { const d = email.split('@')[1]; return !this.cfg.domains.length || this.cfg.domains.includes(d); }
  isPermanentAdmin(email) { return this.cfg.admins.includes(email); }
  async isAdmin(email) {
    if (!email) return false;
    if (this.isPermanentAdmin(email)) return true;
    return this.domainOk(email) && !!(await this.store.get('admins', 'admin', email));
  }
  async isApproved(email) {
    if (!email) return false;
    if (await this.isAdmin(email)) return true;
    return this.domainOk(email) && !!(await this.store.get('approved', 'user', email));
  }
  async role(email) {
    const permanent = this.isPermanentAdmin(email), admin = permanent || await this.isAdmin(email);
    return { email, admin, permanentAdmin: permanent };
  }

  // ---------- codes ----------
  codeHash(email, code) { return b64u(hmac(this.cfg.secret, 'code|' + email + '|' + code)); }
  ipKey(ip) { return b64u(hmac(this.cfg.secret, 'ip|' + String(ip || 'unknown'))).slice(0, 32); }

  /** Count a request from this visitor; false when over the hourly limit. */
  async ipAllowed(ip) {
    const rk = this.ipKey(ip), now = this.now(), hour = 3600000;
    for (let i = 0; i < 4; i++) {
      const cur = await this.store.get('rate', 'ip', rk);
      const d = cur && now - cur.data.start < hour ? { ...cur.data } : { start: now, n: 0 };
      d.n += 1;
      try {
        if (cur) await this.store.replace('rate', 'ip', rk, d, cur.etag); else await this.store.create('rate', 'ip', rk, d);
        return d.n <= this.cfg.maxRequestsPerIpPerHour;
      } catch (e) { if (!(e instanceof ConflictError)) throw e; }
    }
    return false;
  }

  /**
   * Ask for a code. Always resolves to the same public answer; what happened is returned
   * separately (outcome) for logging and tests only, never sent to the visitor.
   */
  async requestCode(rawEmail, ip) {
    const email = normEmail(rawEmail);
    let outcome = 'invalid';
    try {
      if (!(await this.ipAllowed(ip))) outcome = 'ip-limited';
      else if (!email) outcome = 'invalid';
      else if (!(await this.isApproved(email))) outcome = 'not-approved';
      else outcome = await this._issue(email);
    } catch (e) {
      this.log.error && this.log.error('requestCode failed', e && e.message);
      outcome = 'error';
    }
    return { outcome, email };
  }

  async _issue(email) {
    const now = this.now(), cur = await this.store.get('codes', 'code', email);
    const sends = (cur ? cur.data.sends || [] : []).filter(t => now - t < 3600000);
    if (cur && now - cur.data.sentAt < this.cfg.resendGapMs) return 'too-soon';
    if (sends.length >= this.cfg.maxSendsPerHour) return 'address-limited';
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const data = { h: this.codeHash(email, code), sentAt: now, exp: now + this.cfg.codeTtlMs, tries: 0, sends: [...sends, now] };
    let etag;
    try {
      etag = cur ? await this.store.replace('codes', 'code', email, data, cur.etag) : await this.store.create('codes', 'code', email, data);
    } catch (e) {
      if (e instanceof ConflictError) return 'raced'; // a simultaneous request won; its code stands
      throw e;
    }
    // Approval may have been removed while the code was written: check again.
    if (!(await this.isApproved(email))) { await this.store.remove('codes', 'code', email).catch(() => {}); return 'removed-during-request'; }
    // Hand the email over, but never wait past the cap. A timeout is "outcome unknown":
    // the code is kept because the email may still arrive.
    const sent = await Promise.race([
      this.mailer.send(email, code).then(() => 'sent', e => { this.log.error && this.log.error('mail failed', e && e.message); return 'mail-failed'; }),
      new Promise(r => setTimeout(() => r('mail-unknown'), this.cfg.mailTimeoutMs)),
    ]);
    if (sent === 'mail-failed') {
      // Put back the code the user already held (if any), rather than leaving a code nobody received.
      try {
        if (cur) await this.store.replace('codes', 'code', email, { ...cur.data, sends: data.sends }, etag);
        else await this.store.remove('codes', 'code', email, etag);
      } catch (e) { /* a newer request replaced it; leave that one */ }
    }
    return sent;
  }

  /** Check a code. Returns {ok, email} and consumes the code on success. */
  async verifyCode(rawEmail, rawCode) {
    const email = normEmail(rawEmail), code = String(rawCode || '').trim();
    if (!email || !/^\d{6}$/.test(code)) return { ok: false };
    for (let i = 0; i < 4; i++) {
      const cur = await this.store.get('codes', 'code', email);
      if (!cur) return { ok: false };
      const d = cur.data, now = this.now();
      if (now > d.exp || d.tries >= this.cfg.maxAttempts) { await this.store.remove('codes', 'code', email, cur.etag).catch(() => {}); return { ok: false }; }
      if (safeEq(d.h, this.codeHash(email, code))) {
        try { await this.store.remove('codes', 'code', email, cur.etag); }
        catch (e) { if (e instanceof ConflictError) continue; throw e; }
        if (!(await this.isApproved(email))) return { ok: false };
        return { ok: true, email };
      }
      try { await this.store.replace('codes', 'code', email, { ...d, tries: d.tries + 1 }, cur.etag); return { ok: false }; }
      catch (e) { if (!(e instanceof ConflictError)) throw e; }
    }
    return { ok: false };
  }

  // ---------- sessions ----------
  makeSession(email) {
    const now = this.now();
    const body = b64u(JSON.stringify({ e: email, iat: now, exp: now + this.cfg.sessionMs, n: b64u(crypto.randomBytes(9)) }));
    return body + '.' + b64u(hmac(this.cfg.secret, 'session|' + body));
  }
  /** The signed-in, still-approved user for a session token, or null. */
  async readSession(token) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig || !safeEq(sig, b64u(hmac(this.cfg.secret, 'session|' + body)))) return null;
    let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
    if (!p || typeof p.e !== 'string' || !(p.exp > this.now())) return null;
    if (!(await this.isApproved(p.e))) return null;
    return this.role(p.e);
  }

  // ---------- administration ----------
  async audit(by, action, target, outcome, extra) {
    const now = this.now(); this._seq = ((this._seq || 0) + 1) % 1e6;
    // newest first: inverted time, then inverted sequence, then a random tail
    const rk = String(9999999999999 - now).padStart(13, '0') + '-' + String(999999 - this._seq).padStart(6, '0') + '-' + crypto.randomBytes(3).toString('hex');
    try { await this.store.create('audit', 'audit', rk, { at: new Date(now).toISOString(), by, action, target, outcome, ...(extra || {}) }); }
    catch (e) { this.log.error && this.log.error('audit write failed', e && e.message); }
  }
  async listAudit(limit = 200) { return (await this.store.list('audit', 'audit')).slice(0, limit).map(r => r.data); }

  async listApproved() { return (await this.store.list('approved', 'user')).map(r => ({ email: r.rk, ...r.data })); }
  async listAdmins() {
    const added = (await this.store.list('admins', 'admin')).map(r => ({ email: r.rk, permanent: false, ...r.data }));
    return [...this.cfg.admins.map(email => ({ email, permanent: true })), ...added.filter(a => !this.cfg.admins.includes(a.email))];
  }

  async addApproved(by, raw) {
    const email = normEmail(raw);
    if (!email) return { ok: false, error: 'Enter a valid email address.' };
    if (!this.domainOk(email)) return { ok: false, error: 'Only addresses at ' + this.cfg.domains.join(', ') + ' can be approved.' };
    if ((await this.store.list('approved', 'user')).length >= this.cfg.maxApproved) return { ok: false, error: `The approved list is full (${this.cfg.maxApproved}).` };
    await this.audit(by, 'approve', email, 'requested');
    try { await this.store.create('approved', 'user', email, { addedBy: by, addedAt: new Date(this.now()).toISOString() }); }
    catch (e) {
      if (e instanceof ConflictError) { await this.audit(by, 'approve', email, 'already approved'); return { ok: true, already: true }; }
      await this.audit(by, 'approve', email, 'failed'); throw e;
    }
    await this.audit(by, 'approve', email, 'done');
    return { ok: true };
  }

  async removeApproved(by, raw) {
    const email = normEmail(raw);
    if (!email) return { ok: false, error: 'Enter a valid email address.' };
    await this.audit(by, 'remove approval', email, 'requested');
    try {
      await this.store.remove('approved', 'user', email);  // the approval first...
      await this.store.remove('codes', 'code', email);     // ...then any code already sent
    } catch (e) { await this.audit(by, 'remove approval', email, 'failed'); throw e; }
    await this.audit(by, 'remove approval', email, 'done');
    return { ok: true };
  }

  async addAdmin(by, raw) {
    if (!this.isPermanentAdmin(by)) return { ok: false, status: 403, error: 'Only a permanent administrator can add administrators.' };
    const email = normEmail(raw);
    if (!email) return { ok: false, error: 'Enter a valid email address.' };
    if (!this.domainOk(email)) return { ok: false, error: 'Only addresses at ' + this.cfg.domains.join(', ') + ' can be administrators.' };
    if (this.isPermanentAdmin(email)) return { ok: true, already: true };
    await this.audit(by, 'add administrator', email, 'requested');
    try { await this.store.upsert('admins', 'admin', email, { addedBy: by, addedAt: new Date(this.now()).toISOString() }); }
    catch (e) { await this.audit(by, 'add administrator', email, 'failed'); throw e; }
    await this.audit(by, 'add administrator', email, 'done');
    return { ok: true };
  }

  async removeAdmin(by, raw) {
    if (!this.isPermanentAdmin(by)) return { ok: false, status: 403, error: 'Only a permanent administrator can remove administrators.' };
    const email = normEmail(raw);
    if (!email) return { ok: false, error: 'Enter a valid email address.' };
    if (this.isPermanentAdmin(email)) return { ok: false, error: 'Permanent administrators are set in the app configuration (ADMIN_EMAILS).' };
    await this.audit(by, 'remove administrator', email, 'requested');
    try {
      await this.store.remove('admins', 'admin', email);   // the role first...
      if (!(await this.isApproved(email))) await this.store.remove('codes', 'code', email); // ...then a code they can no longer use
    } catch (e) { await this.audit(by, 'remove administrator', email, 'failed'); throw e; }
    await this.audit(by, 'remove administrator', email, 'done');
    return { ok: true };
  }
}

module.exports = { AuthService, normEmail };
