#!/usr/bin/env node
'use strict';
// Run the whole site locally: the sign-in page, the admin page, the sign-in API and the app.
// Codes are printed in this window instead of being emailed, and nothing is stored on disk.
//
//   python3 tools/build.py          (builds dist/Engage.html)
//   node tools/dev_server.js 8788   then open http://localhost:8788
//
// The first administrator is ADMIN_EMAILS (default: admin@example.com).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const port = Number(process.argv[2] || process.env.PORT || 8788);
process.env.ENGAGE_DEV_MEMORY_STORE = '1';
process.env.ENGAGE_DEV_PRINT_CODES = '1';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || require('node:crypto').randomBytes(32).toString('hex');
process.env.ADMIN_EMAILS = process.env.ADMIN_EMAILS || 'admin@example.com';
process.env.ENGAGE_ALLOWED_ORIGIN = `http://localhost:${port}`;
process.env.ENGAGE_REQUEST_FLOOR_MS = process.env.ENGAGE_REQUEST_FLOOR_MS || '800';

const config = require(path.join(ROOT, 'api/src/lib/config'));
const { MemoryStore } = require(path.join(ROOT, 'api/src/lib/store'));
const { makeMailer } = require(path.join(ROOT, 'api/src/lib/mail'));
const { AuthService } = require(path.join(ROOT, 'api/src/lib/auth'));
const { makeHandler } = require(path.join(ROOT, 'api/src/lib/http'));

const cfg = config.load();
const mailer = makeMailer(cfg, console);
const auth = new AuthService({ cfg, store: new MemoryStore(), mailer });
const handle = makeHandler({ auth, cfg, appHtmlPath: path.join(ROOT, 'dist', 'Engage.html') });
const swa = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'staticwebapp.config.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

function routeHeaders(p) {
  const r = swa.routes.find(x => x.route === p && x.headers);
  return { ...(swa.globalHeaders || {}), ...(r ? r.headers : {}) };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let p = url.pathname;
  if (p === '/__dev/codes') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(mailer.sent)); return; } // local only
  if (p === '/app' || p.startsWith('/app/')) p = '/api/app';
  if (p.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v]));
    const r = await handle({ method: req.method, path: p, headers, body: Buffer.concat(chunks).toString(), remoteAddress: req.socket.remoteAddress });
    res.writeHead(r.status, { ...(swa.globalHeaders || {}), ...r.headers });
    res.end(r.body);
    return;
  }
  const file = path.join(ROOT, 'web', p === '/' ? 'index.html' : p);
  if (!file.startsWith(path.join(ROOT, 'web')) || !fs.existsSync(file) || fs.statSync(file).isDirectory() || file.endsWith('staticwebapp.config.json')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...routeHeaders(p === '/' ? '/' : p) });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`ENGAGE dev server on http://localhost:${port}  (administrator: ${process.env.ADMIN_EMAILS})`);
  console.log('Sign-in codes are printed here.');
});
