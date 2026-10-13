import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createSite, fetchChallenge, solve, startNewsletterSink, startService, startSmtpSink } from './helpers.js';

const ORIGIN = 'https://forms.example.com';
const FOREIGN = 'https://elsewhere.example.org';

function postForm(service, path, fields, headers = {}) {
  return fetch(`${service.base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

function postJson(service, path, body, headers = {}) {
  return fetch(`${service.base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function freshPayload(service, origin = ORIGIN) {
  return solve((await fetchChallenge(service, origin)).body);
}

describe('public port', () => {
  const BLOCKED_ORIGIN = 'https://blocked.example.com';
  const logged = [];
  let sink;
  let service;
  let blockedId;

  before(async () => {
    sink = await startSmtpSink();
    service = await startService({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(sink.port),
      SMTP_SECURITY: 'none',
      SMTP_FROM: 'form@example.com',
      // every case here comes from the same address
      RATE_SUBMIT_PER_IP: '100',
    }, { info: () => {}, error: (message) => logged.push(message) });
    const created = await createSite(service, {
      name: 'forms',
      origins: [ORIGIN],
      recipient: 'office@example.com',
      subjectPrefix: '[forms] ',
      successUrl: `${ORIGIN}/thanks`,
    });
    assert.equal(created.status, 201);
    assert.equal((await createSite(service, { name: 'verify-only', origins: ['https://app.example.com'] })).status, 201);
    const blocked = await createSite(service, { name: 'blocked', origins: [BLOCKED_ORIGIN], recipient: 'blocked@example.com' });
    assert.equal(blocked.status, 201);
    blockedId = blocked.body.id;
  });

  after(async () => {
    await service.close();
    await sink.close();
  });

  test('serves the widget with CORS for module scripts', async () => {
    const response = await fetch(`${service.base}/widget.js`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(await response.text(), /customElements\.define/);
  });

  test('a challenge only for a known origin', async () => {
    const known = await fetchChallenge(service, ORIGIN);
    assert.equal(known.status, 200);
    assert.equal(known.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(known.body.parameters.data.site, 'forms');
    assert.equal((await fetchChallenge(service, FOREIGN)).status, 403);
    assert.equal((await fetch(`${service.base}/challenge`)).status, 403);
  });

  test('submit delivers the form and redirects a plain form post', async () => {
    const before = sink.messages.length;
    const response = await postForm(service, '/submit', {
      name: 'Visitor', email: 'visitor@example.org', subject: 'Hello', message: 'A question', altcha: await freshPayload(service),
    }, { Accept: 'text/html' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `${ORIGIN}/thanks`);
    assert.equal(sink.messages.length, before + 1);
    const mail = sink.messages.at(-1);
    assert.match(mail.to[0], /office@example\.com/);
    assert.ok(mail.data.includes('Reply-To: visitor@example.org'));
  });

  test('a solution is spent once', async () => {
    const payload = await freshPayload(service);
    assert.equal((await postForm(service, '/submit', { message: 'first', altcha: payload })).status, 200);
    const second = await postForm(service, '/submit', { message: 'second', altcha: payload });
    assert.equal(second.status, 403);
    assert.equal((await second.json()).error, 'altcha_replay');
  });

  test('a tampered challenge is refused', async () => {
    const challenge = (await fetchChallenge(service, ORIGIN)).body;
    const payload = JSON.parse(Buffer.from(await solve(challenge), 'base64').toString());
    payload.challenge.parameters.expiresAt += 3600;
    const response = await postForm(service, '/submit', { altcha: Buffer.from(JSON.stringify(payload)).toString('base64') });
    assert.equal((await response.json()).error, 'altcha_signature');
  });

  test('the honeypot is answered like a success but not mailed', async () => {
    const before = sink.messages.length;
    const response = await postForm(service, '/submit', { message: 'spam', website: 'http://spam.example', altcha: await freshPayload(service) });
    assert.equal(response.status, 200);
    assert.equal(sink.messages.length, before);
  });

  test('a solution for one site is not accepted by another', async () => {
    const payload = await freshPayload(service, 'https://app.example.com');
    const response = await postForm(service, '/submit', { altcha: payload });
    assert.equal((await response.json()).error, 'altcha_site');
  });

  test('a site without recipient cannot submit', async () => {
    const response = await postForm(service, '/submit', { altcha: 'x' }, { Origin: 'https://app.example.com' });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'submit_disabled');
  });

  test('verify from a backend, bound to the site it names', async () => {
    const ok = await postJson(service, '/verify', { altcha: await freshPayload(service, 'https://app.example.com'), site: 'verify-only' });
    assert.deepEqual(await ok.json(), { ok: true, verified: true, site: 'verify-only' });

    const wrong = await postJson(service, '/verify', { altcha: await freshPayload(service), site: 'verify-only' });
    assert.equal((await wrong.json()).error, 'altcha_site');

    const foreign = await postJson(service, '/verify', { altcha: await freshPayload(service) }, { Origin: FOREIGN });
    assert.equal(foreign.status, 403);
  });

  test('a body over the limit is answered with 413, not a reset connection', async () => {
    const response = await postForm(service, '/submit', { message: 'x'.repeat(40000) });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'body_too_large');
  });

  test('multipart bodies are refused', async () => {
    const form = new FormData();
    form.append('altcha', 'x');
    const response = await fetch(`${service.base}/submit`, { method: 'POST', headers: { Origin: ORIGIN }, body: form });
    assert.equal((await response.json()).error, 'unsupported_media_type');
  });

  test('an error text of the mail server reaches the log without the address', async () => {
    const response = await postForm(service, '/submit', { message: 'A question', altcha: await freshPayload(service, BLOCKED_ORIGIN) }, { Origin: BLOCKED_ORIGIN });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, 'delivery_failed');
    let line = logged.at(-1);
    assert.ok(line.startsWith('mail for site=blocked not delivered') && line.includes('<address>'), line);
    assert.ok(!line.includes('blocked@example.com'), line);

    const testMail = await fetch(`${service.admin}/api/sites/${blockedId}/test-mail`, { method: 'POST', headers: { 'X-Altcha-Admin': '1' } });
    assert.equal(testMail.status, 502);
    // the admin set the recipient - the answer keeps it, the log does not
    assert.ok((await testMail.json()).detail.includes('blocked@example.com'));
    line = logged.at(-1);
    assert.ok(line.startsWith('test mail for site=blocked failed') && line.includes('<address>'), line);
    assert.ok(!line.includes('blocked@example.com'), line);
  });
});

describe('newsletter list', () => {
  const LIST_ORIGIN = 'https://news.example.com';
  const MULTI_ORIGIN = 'https://multi.example.com';
  const ECHO_ORIGIN = 'https://echo.example.com';
  const logged = [];
  let sink;
  let service;

  before(async () => {
    sink = await startNewsletterSink();
    // no SMTP: /subscribe does not need it
    service = await startService({ RATE_SUBMIT_PER_IP: '100' }, { info: () => {}, error: (message) => logged.push(message) });
    const created = await createSite(service, {
      name: 'news',
      origins: [LIST_ORIGIN],
      subscription: { url: `${sink.url}/`, workspaceId: 'ws1', listIds: 'weekly, updates weekly' },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.subscription, { url: sink.url, workspaceId: 'ws1', listIds: ['weekly', 'updates'], languageLists: {} });
    const multi = await createSite(service, {
      name: 'multi',
      origins: [MULTI_ORIGIN],
      subscription: {
        url: sink.url, workspaceId: 'ws1', listIds: ['weekly'],
        languageLists: { fr: 'weeklyfr', ' DE ': ['weeklyde', 'updatesde'], es: ['weeklyes'], 'zh-hant': ['weeklyzh'] },
      },
    });
    assert.equal(multi.status, 201);
    assert.deepEqual(multi.body.subscription.languageLists, { fr: ['weeklyfr'], de: ['weeklyde', 'updatesde'], es: ['weeklyes'], 'zh-hant': ['weeklyzh'] });
    const closed = await createSite(service, {
      name: 'closed',
      origins: ['https://closed.example.com'],
      subscription: { url: sink.url, workspaceId: 'ws1', listIds: ['closed'] },
    });
    assert.equal(closed.status, 201);
    const echo = await createSite(service, {
      name: 'echo',
      origins: [ECHO_ORIGIN],
      subscription: { url: sink.url, workspaceId: 'ws1', listIds: ['echo'] },
    });
    assert.equal(echo.status, 201);
  });

  after(async () => {
    await service.close();
    await sink.close();
  });

  function subscribe(fields, origin = LIST_ORIGIN) {
    return postForm(service, '/subscribe', fields, { Origin: origin });
  }

  test('passes address, name and language on, to the workspace and lists of the site', async () => {
    const before = sink.requests.length;
    const response = await subscribe({
      email: 'reader@example.org', name: 'Ada\r\nLovelace', language: 'de', message: 'stays here', workspace_id: 'other', list_ids: 'other',
      altcha: await freshPayload(service, LIST_ORIGIN),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(sink.requests.length, before + 1);
    const forwarded = sink.requests.at(-1);
    assert.equal(forwarded.method, 'POST');
    assert.equal(forwarded.path, '/subscribe');
    assert.equal(forwarded.type, 'application/json');
    assert.deepEqual(forwarded.body, {
      workspace_id: 'ws1',
      contact: { email: 'reader@example.org', full_name: 'Ada  Lovelace', language: 'de' },
      list_ids: ['weekly', 'updates'],
    });
  });

  test('an invalid address is refused before the solution is spent', async () => {
    const payload = await freshPayload(service, LIST_ORIGIN);
    const wrong = await subscribe({ email: 'not-an-address', altcha: payload });
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error, 'email_invalid');
    assert.equal((await subscribe({ email: 'second@example.org', altcha: payload })).status, 200);
  });

  test('the honeypot is answered like a success but not passed on', async () => {
    const before = sink.requests.length;
    const response = await subscribe({ email: 'bot@example.org', website: 'http://spam.example', altcha: await freshPayload(service, LIST_ORIGIN) });
    assert.equal(response.status, 200);
    assert.equal(sink.requests.length, before);
  });

  test('a refusal of the list is a delivery failure, and both outcomes are counted', async () => {
    const closedOrigin = 'https://closed.example.com';
    const response = await subscribe({ email: 'reader@example.org', altcha: await freshPayload(service, closedOrigin) }, closedOrigin);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, 'delivery_failed');

    const metrics = await (await fetch(`${service.admin}/metrics`)).text();
    for (const line of ['altcha_subscriptions_total{site="news"} 2', 'altcha_subscription_errors_total{site="closed"} 1', 'altcha_verified_total{site="news",endpoint="subscribe"}']) {
      assert.ok(metrics.includes(line), line);
    }
    const history = await (await fetch(`${service.admin}/api/stats?range=24h`)).json();
    assert.equal(history.totals.subscribed, 2);
    assert.equal(history.totals.subscribeErrors, 1);
  });

  test('without a list /subscribe is off, without SMTP /submit is off', async () => {
    assert.equal((await createSite(service, { name: 'plain', origins: ['https://plain.example.com'] })).status, 201);
    const response = await subscribe({ email: 'reader@example.org', altcha: 'x' }, 'https://plain.example.com');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'subscribe_disabled');
    const submit = await postForm(service, '/submit', { altcha: 'x' }, { Origin: LIST_ORIGIN });
    assert.equal((await submit.json()).error, 'submit_disabled');
  });

  test('the list settings are validated', async () => {
    const lists = Array.from({ length: 11 }, (_, i) => `list${i}`);
    const broken = await createSite(service, {
      name: 'broken',
      origins: ['https://broken.example.com'],
      subscription: { url: 'ftp://news.example.com', workspaceId: 'ws_1', listIds: lists },
    });
    assert.equal(broken.status, 400);
    assert.deepEqual(Object.keys(broken.body.fields).sort(), ['subscriptionLists', 'subscriptionUrl', 'subscriptionWorkspace']);
    const query = await createSite(service, {
      name: 'broken',
      origins: ['https://broken.example.com'],
      subscription: { url: 'https://news.example.com/?token=1', workspaceId: 'ws1', listIds: ['weekly'] },
    });
    assert.deepEqual(Object.keys(query.body.fields), ['subscriptionUrl']);
    for (const languageLists of [{ french: ['weeklyfr'] }, { fr: [] }, 'fr: weeklyfr', { fr: ['weekly_fr'] }]) {
      const languages = await createSite(service, {
        name: 'broken',
        origins: ['https://broken.example.com'],
        subscription: { url: 'https://news.example.com', workspaceId: 'ws1', listIds: ['weekly'], languageLists },
      });
      assert.deepEqual(Object.keys(languages.body.fields), ['subscriptionLanguageLists'], JSON.stringify(languageLists));
    }
  });

  test('a sign-up goes to the lists of its language tag, then of each shorter tag, else to the site lists', async () => {
    const cases = [
      ['fr', ['weeklyfr']], ['de-AT', ['weeklyde', 'updatesde']], ['DE', ['weeklyde', 'updatesde']], ['es-419', ['weeklyes']],
      ['zh-Hant-TW', ['weeklyzh']], ['fil', ['weekly']], ['', ['weekly']],
    ];
    for (const [language, lists] of cases) {
      const response = await subscribe({ email: 'reader@example.org', language, altcha: await freshPayload(service, MULTI_ORIGIN) }, MULTI_ORIGIN);
      assert.equal(response.status, 200);
      const forwarded = sink.requests.at(-1).body;
      assert.deepEqual(forwarded.list_ids, lists, language);
      assert.equal(forwarded.contact.language, language === '' ? undefined : language.toLowerCase(), language);
    }
  });

  test('an error text of Notifuse reaches the log without the address', async () => {
    const response = await subscribe({ email: "o'brien@example.org", altcha: await freshPayload(service, ECHO_ORIGIN) }, ECHO_ORIGIN);
    assert.equal(response.status, 502);
    const line = logged.at(-1);
    assert.ok(line.includes('contact <address> is blocked'), line);
    assert.ok(!line.includes('brien'), line);
  });
});

describe('admin port', () => {
  let service;

  before(async () => {
    service = await startService({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'correct horse' });
  });

  after(async () => {
    await service.close();
  });

  const auth = { Authorization: 'Basic ' + Buffer.from('admin:correct horse').toString('base64') };

  test('Basic auth is required, except for the health check', async () => {
    assert.equal((await fetch(`${service.admin}/api/sites`)).status, 401);
    const wrong = { Authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') };
    assert.equal((await fetch(`${service.admin}/api/sites`, { headers: wrong })).status, 401);
    assert.equal((await fetch(`${service.admin}/api/sites`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${service.admin}/healthz`)).status, 200);
  });

  test('changes need the admin header', async () => {
    const response = await fetch(`${service.admin}/api/sites`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', origins: ['https://x.example.com'] }),
    });
    assert.equal(response.status, 403);
  });

  test('create, update and delete a site', async () => {
    const created = await createSite(service, { name: 'shop', origins: ['https://shop.example.com'] }, auth);
    assert.equal(created.status, 201);
    const id = created.body.id;

    const duplicate = await createSite(service, { name: 'other', origins: ['https://shop.example.com/'] }, auth);
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.body.fields.origins, /already belongs/);

    const updated = await fetch(`${service.admin}/api/sites/${id}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json', 'X-Altcha-Admin': '1' },
      body: JSON.stringify({ name: 'shop', origins: ['https://shop.example.com', 'https://www.shop.example.com'], enabled: false }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual((await updated.json()).origins, ['https://shop.example.com', 'https://www.shop.example.com']);

    // a disabled site gets no challenges, and the refusal is counted for it
    const refused = await fetchChallenge(service, 'https://shop.example.com');
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'site_disabled');

    const removed = await fetch(`${service.admin}/api/sites/${id}`, { method: 'DELETE', headers: { ...auth, 'X-Altcha-Admin': '1' } });
    assert.equal(removed.status, 200);
    assert.equal((await fetch(`${service.admin}/api/sites/${id}`, { headers: auth })).status, 404);
  });

  test('the UI and its modules are served', async () => {
    const page = await fetch(`${service.admin}/`, { headers: auth });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    for (const asset of ['/app.js', '/chart.js', '/app.css']) {
      assert.equal((await fetch(`${service.admin}${asset}`, { headers: auth })).status, 200, asset);
    }
  });

  test('a site takes any number of origins', async () => {
    const origins = Array.from({ length: 250 }, (_, i) => `https://shop${i}.example.com`);
    const created = await createSite(service, { name: 'many', origins }, auth);
    assert.equal(created.status, 201);
    assert.equal(created.body.origins.length, 250);
  });

  test('statistics: history, activity per site and metrics', async () => {
    const created = await createSite(service, { name: 'counted', origins: ['https://counted.example.com'] }, auth);
    assert.equal((await fetchChallenge(service, 'https://counted.example.com')).status, 200);
    await fetchChallenge(service, 'https://nobody.example.org');

    const history = await (await fetch(`${service.admin}/api/stats?range=24h&site=${created.body.id}`, { headers: auth })).json();
    assert.equal(history.points.length, 24);
    assert.equal(history.totals.challenges, 1);
    assert.equal(history.points.at(-1).challenges, 1);

    const unknown = await (await fetch(`${service.admin}/api/stats?range=7d&site=0`, { headers: auth })).json();
    assert.equal(unknown.points.length, 56);
    assert.ok(unknown.reasons.origin_unknown >= 1);

    const sites = await (await fetch(`${service.admin}/api/sites`, { headers: auth })).json();
    const counted = sites.find((s) => s.name === 'counted');
    assert.equal(counted.activity.challenges, 1);
    assert.ok(counted.lastActivity > 0);

    assert.equal((await fetch(`${service.admin}/api/stats?range=1y`, { headers: auth })).status, 400);

    const metrics = await (await fetch(`${service.admin}/metrics`, { headers: auth })).text();
    for (const name of ['altcha_build_info', 'altcha_challenges_total{site="counted"} 1', 'altcha_rejected_total{site="-",reason="origin_unknown"} 1',
      'altcha_http_requests_total', 'altcha_challenge_issue_seconds_bucket', 'altcha_database_size_bytes', 'nodejs_eventloop_lag_seconds']) {
      assert.ok(metrics.includes(name), name);
    }
  });
});
