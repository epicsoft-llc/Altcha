// The admin port: web UI, site API, metrics and health check. It is meant to stay off
// the internet; the sign-in (auth.js) is the second layer, not the only one.

import { createAuth, FAILURE_LIMIT, FAILURE_WINDOW_SECONDS } from './auth.js';
import { BodyError, mediaType, readBody, sendJson, sendText } from './http.js';
import { buildMessage, withoutAddresses } from './mail.js';
import { ValidationError, validateSite } from './sites.js';
import { emptyTotals, RANGES } from './stats.js';

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

// Browsers send Basic credentials and proxy session cookies along with every request,
// so a page elsewhere could fire requests at the API. A custom header cannot be set
// cross-origin without a CORS preflight, which this port never answers. A bearer
// token is never sent by a browser on its own, so token requests need no header.
const CSRF_HEADER = 'x-altcha-admin';

const MAX_ADMIN_BODY = 1048576;

const REFUSALS = {
  too_many_failures: `too many failed sign-ins from this address - try again in ${FAILURE_WINDOW_SECONDS / 60} minutes`,
  invalid_token: 'invalid API token',
  invalid_credentials: 'wrong user name or password',
  user_not_allowed: 'signed in, but not in ADMIN_ALLOWED_USERS',
  authentication_required: 'authentication required',
};

export function createAdminHandler({ config, store, stats, mailer, assets, log }) {
  const { authenticate } = createAuth(config.admin);

  function methods() {
    const admin = config.admin;
    return [admin.proxy !== null ? 'proxy' : null, admin.basic !== null ? 'basic' : null, admin.token !== null ? 'token' : null].filter((m) => m !== null);
  }

  function refuse(res, auth) {
    stats.authFailure(auth.reason);
    if (auth.reason === 'too_many_failures' || auth.reason === 'invalid_credentials' || auth.reason === 'invalid_token' || auth.reason === 'user_not_allowed') {
      log.info(`admin sign-in refused reason=${auth.reason}${auth.user ? ` user=${auth.user}` : ''}`);
    }
    const headers = {};
    if (auth.status === 401 && config.admin.basic !== null) {
      headers['WWW-Authenticate'] = 'Basic realm="altcha admin", charset="UTF-8"';
    }
    if (auth.status === 429) {
      headers['Retry-After'] = String(FAILURE_WINDOW_SECONDS);
    }
    let message = REFUSALS[auth.reason];
    if (auth.reason === 'authentication_required' && config.admin.basic === null && config.admin.proxy !== null) {
      message = 'sign in through the proxy in front of this port';
    }
    sendText(res, auth.status, message + '\n', headers);
  }
  function siteView(site, activity) {
    const lastHour = activity.last.get(site.id);
    return {
      ...site,
      activity: activity.bySite.get(site.id) ?? emptyTotals(),
      lastActivity: lastHour === undefined ? null : lastHour * 3600,
    };
  }

  function history(res, url) {
    const range = url.searchParams.get('range') ?? '24h';
    const siteParam = url.searchParams.get('site') ?? '';
    if (!(range in RANGES) || !/^(\d{1,12})?$/.test(siteParam)) {
      sendJson(res, 400, { ok: false, error: 'bad_parameter', detail: `range is one of ${Object.keys(RANGES).join(', ')}, site a site id` }, SECURITY_HEADERS);
      return;
    }
    sendJson(res, 200, stats.history(range, siteParam === '' ? null : Number(siteParam)), SECURITY_HEADERS);
  }

  function status(auth) {
    const sites = store.listSites();
    return {
      auth: {
        enabled: config.admin.enabled,
        methods: methods(),
        user: auth.user,
        method: auth.method,
        trustedProxies: config.admin.trustedProxiesText,
        allowedUsers: config.admin.proxy?.users ? [...config.admin.proxy.users] : null,
        failureLimit: FAILURE_LIMIT,
        failureWindowSeconds: FAILURE_WINDOW_SECONDS,
      },
      version: assets.version,
      buildTag: config.buildTag,
      widget: assets.widgetVersion,
      widgetLanguages: assets.widgetLanguages,
      startedAt: stats.startedAt.toISOString(),
      publicUrl: config.publicUrl,
      honeypotField: config.honeypotField,
      trustProxy: config.trustProxy,
      rate: config.rate,
      altcha: config.altcha,
      smtp: config.smtp === null ? null : {
        host: config.smtp.host,
        port: config.smtp.port,
        security: config.smtp.security,
        from: config.smtp.from,
        authenticated: config.smtp.username !== '',
      },
      sites: { enabled: sites.filter((s) => s.enabled).length, disabled: sites.filter((s) => !s.enabled).length },
      statsRetentionDays: config.statsRetentionDays,
    };
  }

  async function readJson(req) {
    if (mediaType(req) !== 'application/json') {
      throw new BodyError(415, 'unsupported_media_type');
    }
    const raw = await readBody(req, MAX_ADMIN_BODY);
    try {
      return JSON.parse(raw);
    }
    catch (e) {
      throw new BodyError(400, 'body_malformed');
    }
  }

  function serveAsset(res, asset) {
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(asset.body);
  }

  async function testMail(res, site, user) {
    if (mailer === null) {
      sendJson(res, 409, { ok: false, error: 'smtp_not_configured' }, SECURITY_HEADERS);
      return;
    }
    if (site.recipient === null) {
      sendJson(res, 409, { ok: false, error: 'no_recipient' }, SECURITY_HEADERS);
      return;
    }
    const fields = { subject: 'Test message', message: `Sent from the admin UI${user ? ' by ' + user : ''} to check the mail settings.` };
    const message = buildMessage({ smtp: config.smtp, site, origin: '(admin UI)', fields });
    try {
      await mailer.send({ from: config.smtp.from, to: site.recipient, message });
    }
    catch (e) {
      // the answer keeps the full text - the admin set the recipient, the log does not need it
      log.error(`test mail for site=${site.name} failed: ${withoutAddresses(e.message)}`);
      sendJson(res, 502, { ok: false, error: 'delivery_failed', detail: e.message }, SECURITY_HEADERS);
      return;
    }
    log.info(`test mail for site=${site.name} sent`);
    sendJson(res, 200, { ok: true }, SECURITY_HEADERS);
  }

  async function api(req, res, url, auth) {
    const path = url.pathname;
    const user = auth.user;
    const mutating = req.method !== 'GET';
    if (mutating && auth.method !== 'token' && req.headers[CSRF_HEADER] !== '1') {
      sendJson(res, 403, { ok: false, error: 'missing_header', detail: `send '${CSRF_HEADER}: 1' with every change` }, SECURITY_HEADERS);
      return;
    }

    if (path === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, status(auth), SECURITY_HEADERS);
      return;
    }
    if (path === '/api/stats' && req.method === 'GET') {
      history(res, url);
      return;
    }
    if (path === '/api/sites' && req.method === 'GET') {
      const activity = stats.activity();
      sendJson(res, 200, store.listSites().map((site) => siteView(site, activity)), SECURITY_HEADERS);
      return;
    }
    if (path === '/api/sites' && req.method === 'POST') {
      const site = store.createSite(validateSite(await readJson(req)));
      log.info(`site created name=${site.name} by=${user ?? '-'}`);
      sendJson(res, 201, siteView(site, stats.activity()), SECURITY_HEADERS);
      return;
    }

    const match = /^\/api\/sites\/(\d{1,12})(\/test-mail)?$/.exec(path);
    const site = match === null ? null : store.getSite(Number(match[1]));
    if (site === null) {
      sendJson(res, 404, { ok: false, error: 'not_found' }, SECURITY_HEADERS);
      return;
    }
    if (match[2] !== undefined) {
      if (req.method === 'POST') {
        await testMail(res, site, user);
        return;
      }
    }
    else if (req.method === 'GET') {
      sendJson(res, 200, siteView(site, stats.activity()), SECURITY_HEADERS);
      return;
    }
    else if (req.method === 'PUT') {
      const updated = store.updateSite(site.id, validateSite(await readJson(req)));
      if (updated === null) {
        sendJson(res, 404, { ok: false, error: 'not_found' }, SECURITY_HEADERS);
        return;
      }
      log.info(`site updated name=${updated.name} by=${user ?? '-'}`);
      sendJson(res, 200, siteView(updated, stats.activity()), SECURITY_HEADERS);
      return;
    }
    else if (req.method === 'DELETE') {
      store.deleteSite(site.id);
      log.info(`site deleted name=${site.name} by=${user ?? '-'}`);
      sendJson(res, 200, { ok: true }, SECURITY_HEADERS);
      return;
    }
    sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, SECURITY_HEADERS);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // unauthenticated on purpose: the container health check has no credentials
    if (path === '/healthz') {
      let healthy = false;
      try {
        healthy = store.ping();
      }
      catch (e) {
        log.error(`health check: ${e.message}`);
      }
      sendText(res, healthy ? 200 : 503, healthy ? 'ok\n' : 'database unavailable\n');
      return;
    }

    const auth = authenticate(req);
    if (!auth.ok) {
      refuse(res, auth);
      return;
    }

    try {
      if (path.startsWith('/api/')) {
        await api(req, res, url, auth);
      }
      else if (path === '/metrics' && req.method === 'GET') {
        sendText(res, 200, stats.prometheus(), { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      }
      else if (req.method === 'GET' && assets.ui.has(path)) {
        serveAsset(res, assets.ui.get(path));
      }
      else {
        sendText(res, 404, 'not found\n', SECURITY_HEADERS);
      }
    }
    catch (e) {
      if (e instanceof ValidationError) {
        sendJson(res, 400, { ok: false, error: 'validation', fields: e.fields }, SECURITY_HEADERS);
      }
      else if (e instanceof BodyError) {
        sendJson(res, e.status, { ok: false, error: e.reason }, SECURITY_HEADERS);
      }
      else {
        throw e;
      }
    }
  };
}
