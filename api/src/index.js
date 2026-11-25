'use strict';
// Azure Functions entry point (Node.js programming model v4). Azure Static Web Apps runs
// this folder as the site's built-in API, so every route below is served under /api/.
const { app } = require('@azure/functions');
const config = require('./lib/config');
const { MemoryStore, TableStore } = require('./lib/store');
const { makeMailer } = require('./lib/mail');
const { AuthService } = require('./lib/auth');
const { makeHandler, defaultAppPath } = require('./lib/http');

let handler = null, startupError = null;
function getHandler() {
  if (handler || startupError) return handler;
  try {
    const cfg = config.load();
    const store = cfg.devStore ? new MemoryStore() : new TableStore(cfg.tablesConnection);
    const auth = new AuthService({ cfg, store, mailer: makeMailer(cfg) });
    handler = makeHandler({ auth, cfg, appHtmlPath: defaultAppPath });
  } catch (e) {
    startupError = e;
    console.error('ENGAGE sign-in service is not configured:', e.message);
  }
  return handler;
}

async function run(request, context) {
  const h = getHandler();
  if (!h) return { status: 503, jsonBody: { ok: false, error: 'The sign-in service is not configured yet.' } };
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? '' : await request.text();
  const r = await h({ method, path: url.pathname, headers, body });
  return { status: r.status, headers: r.headers, body: r.body };
}

const routes = [
  ['auth-request', 'auth/request', ['POST']],
  ['auth-verify', 'auth/verify', ['POST']],
  ['auth-signout', 'auth/signout', ['POST']],
  ['auth-me', 'auth/me', ['GET']],
  ['app', 'app', ['GET']],
  ['manage', 'manage/{what}', ['GET', 'POST', 'DELETE']],
];
for (const [name, route, methods] of routes) app.http(name, { route, methods, authLevel: 'anonymous', handler: run });
