// The public port: widget, challenge, verify, submit and subscribe. A browser request is mapped
// to a site by its Origin (or Referer); CORS only lets the browser read the answer,
// the protection is the check on this side.

import { BodyError, clientIp, mediaType, parseFields, rateKey, readBody, requestOrigin, sendJson } from './http.js';
import { LANGUAGE_TAG, MAIL_ADDRESS } from './config.js';
import { buildMessage, withoutAddresses } from './mail.js';

const SUBSCRIBE_TIMEOUT_MS = 10000;
const CONTROL = /[\u0000-\u001f\u007f]/g;

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

// A plain HTML form post wants a page, not JSON: send it back to the site when the
// site has a page for that outcome.
function wantsRedirect(req) {
  return mediaType(req) === 'application/x-www-form-urlencoded' && String(req.headers.accept ?? '').includes('text/html');
}

function redirectTo(target, reason) {
  const url = new URL(target);
  if (reason !== null) {
    url.searchParams.set('error', reason);
  }
  return url.href;
}

export function createPublicHandler({ config, store, altcha, limiter, stats, mailer, widgets, log }) {
  // the key the rate limits count under - an IPv6 client by its /64
  function client(req) {
    return rateKey(clientIp(req, config.trustProxy));
  }

  function reject(req, res, status, reason, site) {
    stats.rejected(site, reason);
    // scanners probing for random paths would fill the log; the metric still counts them
    if (reason !== 'route_unknown') {
      log.info(`rejected reason=${reason} site=${site?.name ?? '-'}`);
    }
    if (site?.errorUrl && wantsRedirect(req)) {
      res.writeHead(303, { Location: redirectTo(site.errorUrl, reason), 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    sendJson(res, status, { ok: false, error: reason });
  }

  function succeed(req, res, site, body) {
    if (site?.successUrl && wantsRedirect(req)) {
      res.writeHead(303, { Location: redirectTo(site.successUrl, null), 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    sendJson(res, 200, body);
  }

  function serveWidget(req, res, widget) {
    const headers = {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      ETag: widget.etag,
      // the widget is an ES module, which a browser fetches with CORS
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    };
    if (req.headers['if-none-match'] === widget.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : widget.body);
  }

  // Verified, issued for an enabled site - the expected one, if the caller knows it -
  // and not spent before. Returns { reason } or { reason: null, site, result }.
  async function checkPayload(fields, expected) {
    const result = await altcha.check(fields.altcha);
    if (!result.ok) {
      return { reason: result.reason };
    }
    const site = expected ?? store.getSiteByName(result.site);
    if (site === null || !site.enabled) {
      return { reason: 'site_unknown' };
    }
    if (result.site !== site.name) {
      return { reason: 'altcha_site' };
    }
    if (!store.markChallengeUsed(result.nonce, result.expiresAt)) {
      return { reason: 'altcha_replay' };
    }
    return { reason: null, site, result };
  }

  async function readFields(req) {
    const raw = await readBody(req, config.maxBodyBytes);
    return parseFields(raw, mediaType(req));
  }

  async function challenge(req, res, site) {
    if (!limiter.allow('c:' + client(req), config.rate.challengePerIp)) {
      reject(req, res, 429, 'rate_challenge', site);
      return;
    }
    const started = performance.now();
    const issued = await altcha.issue(site.name);
    stats.challenge(site, (performance.now() - started) / 1000);
    sendJson(res, 200, issued);
  }

  // Without an Origin this is a backend asking on behalf of its own form. It can send
  // `site` to make sure the solution was issued for that site and not another one.
  // A backend speaks for all its visitors from one address, hence its own, higher limit.
  async function verify(req, res, site) {
    const allowed = site !== null
      ? limiter.allow('s:' + client(req), config.rate.submitPerIp)
      : limiter.allow('v:' + client(req), config.rate.verifyPerIp);
    if (!allowed) {
      reject(req, res, 429, 'rate_ip', site);
      return;
    }
    const fields = await readFields(req);
    let expected = site;
    if (expected === null && (fields.site ?? '') !== '') {
      expected = store.getSiteByName(fields.site);
      if (expected === null || !expected.enabled) {
        reject(req, res, 403, 'site_unknown', null);
        return;
      }
    }
    const checked = await checkPayload(fields, expected);
    if (checked.reason !== null) {
      reject(req, res, 403, checked.reason, expected);
      return;
    }
    stats.verified(checked.site, 'verify', checked.result);
    sendJson(res, 200, { ok: true, verified: true, site: checked.site.name });
  }

  // The limits per address and per site count /submit and /subscribe together.
  function withinLimits(req, res, site) {
    if (!limiter.allow('s:' + client(req), config.rate.submitPerIp)) {
      reject(req, res, 429, 'rate_ip', site);
      return false;
    }
    if (!limiter.allow('d:' + site.name, site.submitPerHour)) {
      reject(req, res, 429, 'rate_site', site);
      return false;
    }
    return true;
  }

  // A valid unspent solution and an empty honeypot; both fields leave `fields` here.
  // False once the answer is sent - a bot that filled the honeypot gets the same
  // answer as everybody else.
  async function fromHuman(req, res, site, endpoint, fields) {
    const checked = await checkPayload(fields, site);
    if (checked.reason !== null) {
      reject(req, res, 403, checked.reason, site);
      return false;
    }
    stats.verified(site, endpoint, checked.result);
    const honeypot = fields[config.honeypotField] ?? '';
    delete fields.altcha;
    delete fields[config.honeypotField];
    if (honeypot !== '') {
      stats.rejected(site, 'honeypot');
      succeed(req, res, site, { ok: true });
      return false;
    }
    return true;
  }

  async function submit(req, res, site) {
    if (site.recipient === null || mailer === null) {
      reject(req, res, 404, 'submit_disabled', site);
      return;
    }
    if (!withinLimits(req, res, site)) {
      return;
    }
    const fields = await readFields(req);
    if (!(await fromHuman(req, res, site, 'submit', fields))) {
      return;
    }
    const message = buildMessage({ smtp: config.smtp, site, origin: requestOrigin(req), fields });
    const started = performance.now();
    try {
      await mailer.send({ from: config.smtp.from, to: site.recipient, message });
    }
    catch (e) {
      stats.smtpError(site, (performance.now() - started) / 1000);
      log.error(`mail for site=${site.name} not delivered: ${withoutAddresses(e.message)}`);
      reject(req, res, 502, 'delivery_failed', site);
      return;
    }
    stats.sent(site, (performance.now() - started) / 1000);
    succeed(req, res, site, { ok: true });
  }

  // Only the address and, when sent, name and language leave the service.
  function contactOf(fields) {
    const contact = { email: String(fields.email ?? '').trim() };
    const name = String(fields.name ?? '').replace(CONTROL, ' ').trim().slice(0, 120);
    if (name !== '') {
      contact.full_name = name;
    }
    const language = String(fields.language ?? '').trim().toLowerCase();
    if (LANGUAGE_TAG.test(language)) {
      contact.language = language;
    }
    return contact;
  }

  // The lists for the language the form sends - the whole tag, then each shorter one
  // (zh-hant-tw, zh-hant, zh) - else the site's lists. The form chooses among the site's
  // lists, never a list of its own.
  function listsFor(subscription, language) {
    const parts = language === undefined ? [] : language.split('-');
    const keys = parts.map((_, i) => parts.slice(0, parts.length - i).join('-'));
    const match = keys.find((key) => Object.hasOwn(subscription.languageLists, key));
    return match === undefined ? subscription.listIds : subscription.languageLists[match];
  }

  // Workspace and lists come from the site, never from the request. Notifuse mails the
  // confirmation link itself when the list asks for double opt-in.
  async function subscribe(req, res, site) {
    if (site.subscription === null) {
      reject(req, res, 404, 'subscribe_disabled', site);
      return;
    }
    if (!withinLimits(req, res, site)) {
      return;
    }
    const fields = await readFields(req);
    const contact = contactOf(fields);
    // checked before the solution is spent, so a typo costs no new challenge
    if (!MAIL_ADDRESS.test(contact.email)) {
      reject(req, res, 400, 'email_invalid', site);
      return;
    }
    if (!(await fromHuman(req, res, site, 'subscribe', fields))) {
      return;
    }
    const { url, workspaceId } = site.subscription;
    const listIds = listsFor(site.subscription, contact.language);
    let accepted = false;
    try {
      const answer = await fetch(`${url}/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, contact, list_ids: listIds }),
        redirect: 'error',
        signal: AbortSignal.timeout(SUBSCRIBE_TIMEOUT_MS),
      });
      const body = await answer.json().catch(() => null);
      accepted = answer.ok && body?.success === true;
      if (!accepted) {
        const detail = typeof body?.error === 'string' ? `: ${withoutAddresses(body.error).slice(0, 200)}` : '';
        log.error(`subscription for site=${site.name} refused with status ${answer.status}${detail}`);
      }
    }
    catch (e) {
      log.error(`subscription for site=${site.name} failed: ${withoutAddresses(e.message)}`);
    }
    if (!accepted) {
      stats.subscribeError(site);
      reject(req, res, 502, 'delivery_failed', site);
      return;
    }
    stats.subscribed(site);
    succeed(req, res, site, { ok: true });
  }

  return async function handle(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;

    if ((req.method === 'GET' || req.method === 'HEAD') && widgets.has(path)) {
      serveWidget(req, res, widgets.get(path));
      return;
    }

    const origin = requestOrigin(req);
    const site = origin === '' ? null : store.getSiteByOrigin(origin);
    const known = site !== null && site.enabled;
    if (known) {
      cors(res, origin);
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(known ? 204 : 403, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const route = `${req.method} ${path}`;
    if (route !== 'GET /challenge' && route !== 'POST /verify' && route !== 'POST /submit' && route !== 'POST /subscribe') {
      reject(req, res, 404, 'route_unknown', known ? site : null);
      return;
    }

    // Only /verify may come without an Origin - from a backend. An Origin that is
    // there but unknown is a browser on a foreign page and is refused everywhere.
    // A disabled site keeps its refusals, so its statistics show what still arrives.
    if (site !== null && !site.enabled) {
      reject(req, res, 403, 'site_disabled', site);
      return;
    }
    if (!known && !(route === 'POST /verify' && origin === '')) {
      reject(req, res, 403, 'origin_unknown', null);
      return;
    }

    try {
      if (route === 'GET /challenge') {
        await challenge(req, res, site);
      }
      else if (route === 'POST /verify') {
        await verify(req, res, known ? site : null);
      }
      else if (route === 'POST /submit') {
        await submit(req, res, site);
      }
      else {
        await subscribe(req, res, site);
      }
    }
    catch (e) {
      if (!(e instanceof BodyError)) {
        throw e;
      }
      reject(req, res, e.status, e.reason, known ? site : null);
    }
  };
}
