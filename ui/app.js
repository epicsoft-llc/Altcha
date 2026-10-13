// Admin UI. No framework and no build step. Every value from the API reaches the page
// as text (textContent), styles are set through CSSOM only - the CSP allows neither
// inline scripts nor style attributes.

import { LineChart, sparkline } from './chart.js';

const CHANGE = { 'Content-Type': 'application/json', 'X-Altcha-Admin': '1' };
const REFRESH_MS = 30000;

const SERIES = [
  { key: 'challenges', label: 'Challenges', short: 'challenges', color: '--s-challenges' },
  { key: 'verified', label: 'Verified', short: 'verified', color: '--s-verified' },
  { key: 'sent', label: 'Mails sent', short: 'sent', color: '--s-sent' },
  { key: 'subscribed', label: 'Subscriptions', short: 'subscribed', color: '--s-subscribed' },
  { key: 'rejected', label: 'Refused', short: 'refused', color: '--s-rejected' },
];

// `up` says whether a rise is good news - it decides the colour of the delta
const KPIS = [
  { key: 'challenges', label: 'Challenges', color: '--s-challenges', up: 'neutral' },
  { key: 'verified', label: 'Verified', color: '--s-verified', up: 'good' },
  { key: 'sent', label: 'Mails sent', color: '--s-sent', up: 'good' },
  { key: 'subscribed', label: 'Subscriptions', color: '--s-subscribed', up: 'good' },
  { key: 'rejected', label: 'Refused', color: '--s-rejected', up: 'bad' },
  { key: 'deliveryErrors', label: 'Delivery errors', color: null, up: 'bad' },
];

const RANGES = {
  '24h': { label: 'last 24 hours', previous: 'previous 24 h' },
  '7d': { label: 'last 7 days', previous: 'previous 7 days' },
  '30d': { label: 'last 30 days', previous: 'previous 30 days' },
  '90d': { label: 'last 90 days', previous: 'previous 90 days' },
};

const REASONS = {
  origin_unknown: 'Page not listed for any site',
  route_unknown: 'Unknown endpoint',
  site_unknown: 'Unknown or disabled site',
  site_disabled: 'Site is disabled',
  submit_disabled: 'Mail delivery is off for the site',
  subscribe_disabled: 'Newsletter list is off for the site',
  email_invalid: 'No valid mail address',
  altcha_missing: 'No solution sent',
  altcha_malformed: 'Unreadable solution',
  altcha_algorithm: 'Other algorithm',
  altcha_signature: 'Forged or altered challenge',
  altcha_expired: 'Challenge expired',
  altcha_solution: 'Wrong solution',
  altcha_site: 'Solution for another site',
  altcha_replay: 'Solution used twice',
  rate_challenge: 'Challenge limit per address',
  rate_ip: 'Submission limit per address',
  rate_site: 'Submission limit of the site',
  body_too_large: 'Request too large',
  body_malformed: 'Malformed request',
  body_incomplete: 'Request aborted by the client',
  too_many_fields: 'Too many fields',
  unsupported_media_type: 'Unsupported format',
  delivery_failed: 'Mail server or newsletter refused it',
  honeypot: 'Honeypot filled in - a bot',
};

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en');
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
// numeric: domain2 before domain10
const natural = new Intl.Collator('en', { numeric: true });

// One language on the page: English words, 24-hour clock, day before month.
const LOCALE = 'en-GB';

const state = {
  status: null,
  sites: [],
  history: null,
  range: preference('range', '24h'),
  scope: '',
  search: '',
  stateFilter: 'all',
  sort: preference('sort', 'name'),
  expanded: new Set(),
  editing: null,
  deleting: null,
  embedSite: null,
  loadedAt: null,
  loadFailed: false,
  showTable: false,
};

let chart = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = (selector) => document.querySelector(selector);

function preference(key, fallback) {
  try {
    return localStorage.getItem('altcha.' + key) ?? fallback;
  }
  catch (e) {
    return fallback;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem('altcha.' + key, value);
  }
  catch (e) {
    // private window or blocked storage - the setting just does not survive a reload
  }
}

function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('class', 'icon');
  node.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  node.append(use);
  return node;
}

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key === 'class') {
      node.className = value;
    }
    else if (key.startsWith('on')) {
      node.addEventListener(key.slice(2), value);
    }
    else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

function toast(message, kind = 'info') {
  const node = el('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'alert' : 'check'), el('span', {}, message));
  $('#toasts').append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 7000 : 3500);
}

async function request(path, options = {}) {
  try {
    const response = await fetch(path, { cache: 'no-store', ...options });
    let body = null;
    try {
      body = await response.json();
    }
    catch (e) {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  }
  catch (e) {
    return { ok: false, status: 0, body: { error: 'network' } };
  }
}

// The statistics know the hour, not the minute: count from the end of that hour.
function ago(hourStart) {
  if (hourStart === null) {
    return '—';
  }
  const diff = hourStart + 3600 - Date.now() / 1000;
  if (diff > 0) {
    return 'this hour';
  }
  if (diff > -86400) {
    return relative.format(Math.min(-1, Math.round(diff / 3600)), 'hour');
  }
  return relative.format(Math.round(diff / 86400), 'day');
}

function publicBase() {
  return state.status?.publicUrl || 'https://altcha.example.com';
}

function siteById(id) {
  return state.sites.find((s) => String(s.id) === String(id)) ?? null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadHistory() {
  const params = new URLSearchParams({ range: state.range });
  if (state.scope !== '') {
    params.set('site', state.scope);
  }
  const result = await request('api/stats?' + params);
  if (result.ok) {
    // mail and newsletter failures share one tile and one column
    for (const totals of [result.body.totals, result.body.previousTotals, ...result.body.points]) {
      totals.deliveryErrors = totals.smtpErrors + totals.subscribeErrors;
    }
    state.history = result.body;
  }
  return result;
}

async function load({ quiet = false } = {}) {
  for (const node of [$('#kpis'), $('.panels')]) {
    node.classList.add('is-loading');
  }
  const [status, sites, history] = await Promise.all([request('api/status'), request('api/sites'), loadHistory()]);
  for (const node of [$('#kpis'), $('.panels')]) {
    node.classList.remove('is-loading');
  }
  if (!status.ok || !sites.ok || !history.ok) {
    state.loadFailed = true;
    renderUpdated();
    if (!quiet) {
      toast(`Loading failed (${status.status || sites.status || history.status || 'no connection'})`, 'error');
    }
    return;
  }
  state.loadFailed = false;
  state.status = status.body;
  state.sites = sites.body;
  state.loadedAt = Date.now();
  if (state.scope !== '' && state.scope !== '0' && siteById(state.scope) === null) {
    state.scope = '';
    await loadHistory();
  }
  renderAll({ background: quiet });
}

async function reloadHistory() {
  $('.panels').classList.add('is-loading');
  $('#kpis').classList.add('is-loading');
  const result = await loadHistory();
  $('.panels').classList.remove('is-loading');
  $('#kpis').classList.remove('is-loading');
  if (!result.ok) {
    toast(`Loading the statistics failed (${result.status})`, 'error');
    return;
  }
  renderKpis();
  renderActivity();
  renderReasons();
}

// ---------------------------------------------------------------------------
// Header, notices, settings
// ---------------------------------------------------------------------------

function renderHeader() {
  const s = state.status;
  // the build tag only where it says more than the version: develop, latest, local
  const build = s.buildTag === s.version ? '' : ` · ${s.buildTag}`;
  $('#version').textContent = `v${s.version}${build} · widget ${s.widget}`;
  const smtp = s.smtp === null
    ? el('span', { class: 'pill warn', title: 'SMTP is not configured - /submit is off' }, icon('mail'), 'SMTP off')
    : el('span', { class: 'pill good', title: `${s.smtp.host}:${s.smtp.port} (${s.smtp.security})` }, icon('mail'), 'SMTP on');
  const via = { proxy: 'through the proxy', basic: 'with Basic auth', token: 'with the API token' };
  const auth = s.auth.enabled
    ? el('span', { class: 'pill good', title: `Signed in ${via[s.auth.method] ?? ''} - allowed here: ${s.auth.methods.join(', ')}` }, icon('lock'), s.auth.user ?? 'signed in')
    : el('span', { class: 'pill warn', title: 'The admin port has no authentication' }, icon('unlock'), 'No auth');
  $('#status-pills').replaceChildren(smtp, auth);
}

function renderUpdated() {
  const node = $('#updated');
  if (state.loadFailed) {
    node.textContent = 'Update failed - retrying';
    return;
  }
  if (state.loadedAt === null) {
    node.textContent = '';
    return;
  }
  const seconds = Math.round((Date.now() - state.loadedAt) / 1000);
  node.textContent = seconds < 10 ? 'Updated just now' : `Updated ${seconds < 60 ? seconds + ' s' : Math.round(seconds / 60) + ' min'} ago`;
}

function renderNotices() {
  const s = state.status;
  const notices = [];
  if (!s.auth.enabled) {
    notices.push('The admin port runs without authentication. Keep it off the internet, and sign in through a proxy (ADMIN_PROXY_USER_HEADER) or with Basic auth (ADMIN_USERNAME, ADMIN_PASSWORD).');
  }
  if (s.smtp === null) {
    notices.push('SMTP is not configured - /submit is off; challenge, verify and /subscribe still work.');
  }
  if (!s.publicUrl) {
    notices.push('PUBLIC_URL is not set - the embed snippets show a placeholder address.');
  }
  $('#notices').replaceChildren(...notices.map((text) => el('li', {}, icon('alert'), el('span', {}, text))));
}

function renderSettings() {
  const s = state.status;
  const rows = [
    ['Public URL', s.publicUrl || '(not set)'],
    ['Algorithm', `${s.altcha.algorithm}, cost ${integer.format(s.altcha.cost)}, counter ${integer.format(s.altcha.counterMin)}–${integer.format(s.altcha.counterMax)}`],
    ['Challenge valid for', `${integer.format(s.altcha.expiresSeconds)} s`],
    ['Limits per address and hour', `${s.rate.challengePerIp || 'unlimited'} challenges, ${s.rate.submitPerIp || 'unlimited'} submissions, ${s.rate.verifyPerIp || 'unlimited'} backend verifications (IPv6 per /64)`],
    ['Proxies on the public port', String(s.trustProxy)],
    ['Sign-in on this port', s.auth.enabled
      ? `${s.auth.methods.join(', ')}; locked for ${s.auth.failureWindowSeconds / 60} min after ${s.auth.failureLimit} failures`
      : '(none)'],
    ['Trusted proxies here', s.auth.trustedProxies.length === 0 ? '(none)' : s.auth.trustedProxies.join(', ')],
    ['Allowed users', s.auth.allowedUsers === null ? (s.auth.methods.includes('proxy') ? 'everybody the proxy lets in' : '—') : s.auth.allowedUsers.join(', ')],
    ['Honeypot field', s.honeypotField],
    ['Statistics kept', `${s.statsRetentionDays} days`],
    ['SMTP', s.smtp === null ? '(not configured)' : `${s.smtp.host}:${s.smtp.port} ${s.smtp.security}${s.smtp.authenticated ? ', with login' : ''}, from ${s.smtp.from}`],
    ['Running since', new Date(s.startedAt).toLocaleString(LOCALE)],
  ];
  $('#settings').replaceChildren(...rows.flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, value)]));
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function renderScope() {
  const select = $('#scope-site');
  const options = [el('option', { value: '' }, 'All sites')];
  for (const site of [...state.sites].sort((a, b) => a.name.localeCompare(b.name))) {
    options.push(el('option', { value: String(site.id) }, site.enabled ? site.name : `${site.name} (disabled)`));
  }
  options.push(el('option', { value: '0' }, 'Requests without a site'));
  select.replaceChildren(...options);
  select.value = state.scope;
}

function scopeName() {
  if (state.scope === '') {
    return 'all sites';
  }
  if (state.scope === '0') {
    return 'requests without a site';
  }
  return siteById(state.scope)?.name ?? 'site';
}

function delta(kpi, current, previous) {
  const period = RANGES[state.range].previous;
  if (current === 0 && previous === 0) {
    return el('div', { class: 'kpi-delta' }, `no activity, as in the ${period}`);
  }
  if (previous === 0) {
    return el('div', { class: 'kpi-delta' }, `new - none in the ${period}`);
  }
  const change = (current - previous) / previous;
  const rounded = Math.round(change * 100);
  if (rounded === 0) {
    return el('div', { class: 'kpi-delta' }, `same as the ${period}`);
  }
  const rising = change > 0;
  const tone = kpi.up === 'neutral' ? '' : (rising === (kpi.up === 'good') ? 'good' : 'bad');
  return el('div', { class: `kpi-delta ${tone}` }, icon(rising ? 'up' : 'down'),
    `${rising ? '+' : ''}${rounded} % vs ${period}`);
}

function renderKpis() {
  const h = state.history;
  const tiles = KPIS.map((kpi) => {
    const value = h.totals[kpi.key];
    const label = el('div', { class: 'kpi-label' });
    if (kpi.color !== null) {
      const key = el('span', { class: 'kpi-key' });
      key.style.background = `var(${kpi.color})`;
      label.append(key);
    }
    label.append(kpi.label);
    // the trend ends with the last complete period, like the chart
    const complete = h.partial ? h.points.slice(0, -1) : h.points;
    const spark = sparkline(complete.map((p) => p[kpi.key]), kpi.color ?? '--bad');
    return el('div', { class: 'card kpi' },
      label,
      el('div', { class: 'kpi-value', title: integer.format(value) }, compact.format(value)),
      spark,
      delta(kpi, value, h.previousTotals[kpi.key]));
  });
  $('#kpis').replaceChildren(...tiles);
}

function tickFormatter() {
  if (state.range === '24h') {
    const f = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
    return (t) => f.format(t * 1000);
  }
  if (state.range === '7d') {
    const f = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return (t) => f.format(t * 1000);
  }
  const f = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric' });
  return (t) => f.format(t * 1000);
}

function rangeFormatter() {
  const f = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (from, to) => `${f.format(from * 1000)} – ${f.format(to * 1000)}`;
}

function describeChart(data) {
  const t = data.totals;
  return `Activity, ${RANGES[state.range].label}, ${scopeName()}: ${integer.format(t.challenges)} challenges, `
    + `${integer.format(t.verified)} verified, ${integer.format(t.sent)} mails sent, ${integer.format(t.subscribed)} subscriptions, `
    + `${integer.format(t.rejected)} refused. `
    + 'Use the arrow keys to read single periods, or switch to the table.';
}

function renderLegend() {
  const totals = state.history.totals;
  $('#legend').replaceChildren(...SERIES.map((s) => {
    const key = el('span', { class: 'line-key' });
    key.style.background = `var(${s.color})`;
    return el('button', {
      type: 'button',
      'aria-pressed': chart.hidden.has(s.key) ? 'false' : 'true',
      title: `Show or hide ${s.label.toLowerCase()}`,
      onclick: () => {
        chart.toggle(s.key);
        renderLegend();
      },
    }, key, s.label, el('span', { class: 'muted' }, compact.format(totals[s.key])));
  }));
}

function renderActivityTable() {
  const h = state.history;
  const format = rangeFormatter();
  const head = el('tr', {}, el('th', { scope: 'col' }, 'Period'), ...SERIES.map((s) => el('th', { scope: 'col' }, s.label)), el('th', { scope: 'col' }, 'Delivery errors'));
  const rows = [...h.points].reverse().map((p) => el('tr', {},
    el('th', { scope: 'row' }, format(p.t, p.t + h.bucketSeconds)),
    ...SERIES.map((s) => el('td', {}, integer.format(p[s.key]))),
    el('td', {}, integer.format(p.deliveryErrors))));
  $('#activity-table').replaceChildren(el('table', { class: 'data-table' }, el('thead', {}, head), el('tbody', {}, rows)));
}

function renderActivity() {
  const h = state.history;
  $('#activity-caption').textContent = `${RANGES[state.range].label[0].toUpperCase()}${RANGES[state.range].label.slice(1)} · ${scopeName()}`;
  chart.formatTick = tickFormatter();
  chart.formatRange = rangeFormatter();
  chart.update(h);
  renderLegend();
  $('#activity-chart').hidden = state.showTable;
  $('#activity-table').hidden = !state.showTable;
  if (state.showTable) {
    renderActivityTable();
  }
}

function renderReasons() {
  const entries = Object.entries(state.history.reasons).sort((a, b) => b[1] - a[1]);
  const list = $('#reasons');
  if (entries.length === 0) {
    list.replaceChildren(el('li', { class: 'empty-note' }, icon('check'), 'Nothing refused in this period.'));
    return;
  }
  const max = entries[0][1];
  list.replaceChildren(...entries.map(([reason, count]) => {
    const fill = el('span', { class: 'reason-fill' });
    fill.style.width = `calc((100% - 56px) * ${count / max})`;
    return el('li', {},
      el('div', { class: 'reason-top' },
        el('span', {}, REASONS[reason] ?? reason),
        el('code', { class: 'reason-code' }, reason)),
      el('div', { class: 'reason-bar' }, fill, el('span', { class: 'reason-value' }, integer.format(count))));
  }));
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

function activityTotal(site) {
  const a = site.activity;
  return a.challenges + a.verified + a.sent + a.subscribed + a.rejected;
}

function visibleSites() {
  const query = state.search.trim().toLowerCase();
  const sites = state.sites.filter((site) => {
    if (state.stateFilter === 'enabled' && !site.enabled) {
      return false;
    }
    if (state.stateFilter === 'disabled' && site.enabled) {
      return false;
    }
    if (query === '') {
      return true;
    }
    const lists = [...(site.subscription?.listIds ?? []), ...Object.values(site.subscription?.languageLists ?? {}).flat()];
    return [site.name, site.note, site.recipient ?? '', ...lists, ...site.origins].some((text) => text.toLowerCase().includes(query));
  });
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (state.sort === 'activity') {
    sites.sort((a, b) => activityTotal(b) - activityTotal(a) || byName(a, b));
  }
  else if (state.sort === 'recent') {
    sites.sort((a, b) => (b.lastActivity ?? -1) - (a.lastActivity ?? -1) || byName(a, b));
  }
  else {
    sites.sort(byName);
  }
  return sites;
}

function testMailBlocker(site) {
  if (state.status.smtp === null) {
    return 'SMTP is not configured';
  }
  if (site.recipient === null) {
    return 'The site has no "Mail to" address';
  }
  return null;
}

function originsCell(site) {
  const expanded = state.expanded.has(site.id);
  const origins = [...site.origins].sort(natural.compare);
  const shown = origins.slice(0, 2);
  const rest = origins.length - shown.length;
  const row = el('div', { class: 'origins' },
    ...shown.map((o) => el('span', { class: 'origin', title: o }, icon('globe'), o.replace(/^https?:\/\//, ''))));
  if (rest > 0) {
    row.append(el('button', {
      type: 'button',
      class: 'more',
      'aria-expanded': expanded ? 'true' : 'false',
      onclick: () => {
        if (state.expanded.has(site.id)) {
          state.expanded.delete(site.id);
        }
        else {
          state.expanded.add(site.id);
        }
        renderSites();
      },
    }, expanded ? 'show less' : `+${rest} more`));
  }
  const parts = [row];
  if (expanded) {
    parts.push(el('ul', { class: 'origin-list' }, ...origins.map((o) => el('li', {}, o))));
  }
  return parts;
}

function activityCell(site) {
  const a = site.activity;
  const value = (n) => el('strong', { class: n === 0 ? 'zero' : null }, compact.format(n));
  return el('div', { class: 'activity', title: `${a.challenges} challenges, ${a.verified} verified, ${a.sent} mails sent, ${a.subscribed} subscriptions, ${a.rejected} refused` },
    el('span', {}, 'verified'), el('span', {}, 'delivered'), el('span', {}, 'refused'),
    value(a.verified), value(a.sent + a.subscribed), value(a.rejected));
}

function deliveryCell(site) {
  const parts = [];
  if (site.recipient !== null) {
    parts.push(el('span', { class: 'recipient' }, site.recipient));
  }
  if (site.subscription !== null) {
    const { url, workspaceId, listIds, languageLists } = site.subscription;
    const languages = Object.keys(languageLists);
    const perLanguage = Object.entries(languageLists).map(([language, ids]) => `; ${language}: ${ids.join(', ')}`).join('');
    parts.push(el('span', { class: 'chip', title: `/subscribe passes addresses to ${url}, workspace ${workspaceId}${perLanguage}` },
      `list ${listIds.join(', ')}${languages.length > 0 ? ` · ${languages.join(', ')}` : ''}`));
  }
  if (parts.length === 0) {
    parts.push(el('span', { class: 'chip', title: '/submit and /subscribe are off for this site' }, 'verify only'));
  }
  return el('div', { class: 'delivery' }, ...parts);
}

function actionButton(name, label, onclick, extra = {}) {
  return el('button', { type: 'button', class: `icon-button ${extra.class ?? ''}`, 'aria-label': label, title: extra.title ?? label, 'aria-disabled': extra.disabled ? 'true' : null, onclick }, icon(name));
}

function siteRow(site) {
  const blocker = testMailBlocker(site);
  const toggle = el('button', {
    type: 'button',
    role: 'switch',
    class: 'switch',
    'aria-checked': site.enabled ? 'true' : 'false',
    'aria-label': `${site.name} enabled`,
    title: site.enabled ? 'Enabled - click to disable' : 'Disabled - click to enable',
    onclick: (event) => toggleSite(site, event.currentTarget),
  }, el('span'));
  return el('tr', { class: site.enabled ? null : 'is-disabled' },
    el('td', { class: 'cell-switch' }, toggle),
    el('td', { class: 'cell-site' },
      el('div', { class: 'site-name' }, site.name),
      site.note ? el('div', { class: 'site-note site-sub' }, site.note) : null,
      ...originsCell(site)),
    el('td', { class: 'cell-mail', 'data-label': 'Delivers to' }, deliveryCell(site)),
    el('td', { class: 'cell-activity num', 'data-label': 'Last 24 h' }, activityCell(site)),
    el('td', { class: 'cell-last muted', 'data-label': 'Last activity' }, ago(site.lastActivity)),
    el('td', { class: 'cell-actions' }, el('div', { class: 'actions' },
      actionButton('chart', `Statistics of ${site.name}`, () => showSiteStats(site)),
      actionButton('code', `Embed code for ${site.name}`, () => openEmbed(site)),
      actionButton('mail', `Send a test mail for ${site.name}`, () => sendTestMail(site), { disabled: blocker !== null, title: blocker ?? `Send a test mail to ${site.recipient}` }),
      actionButton('edit', `Edit ${site.name}`, () => openEditor(site)),
      actionButton('trash', `Delete ${site.name}`, () => openDelete(site), { class: 'danger-hover' }))));
}

function renderSites() {
  const sites = visibleSites();
  const total = state.sites.length;
  $('#sites-count').textContent = sites.length === total ? String(total) : `${sites.length} of ${total}`;
  $('#sites tbody').replaceChildren(...sites.map(siteRow));
  $('.sites-wrap').hidden = sites.length === 0;

  const empty = $('#sites-empty');
  empty.hidden = sites.length > 0;
  if (total === 0) {
    empty.replaceChildren(icon('inbox'), el('strong', {}, 'No sites yet'),
      el('span', {}, 'Create a site for every page - or group of pages - that shows a form.'),
      el('button', { type: 'button', class: 'primary', onclick: () => openEditor(null) }, icon('plus'), 'Create the first site'));
  }
  else if (sites.length === 0) {
    empty.replaceChildren(icon('search'), el('strong', {}, 'No site matches'),
      el('button', { type: 'button', class: 'ghost', onclick: clearFilters }, 'Clear search and filter'));
  }
}

function clearFilters() {
  state.search = '';
  state.stateFilter = 'all';
  $('#search').value = '';
  setRadio($('#state-filter'), 'state', 'all');
  renderSites();
}

async function toggleSite(site, button) {
  button.setAttribute('aria-busy', 'true');
  const payload = { ...site, enabled: !site.enabled };
  const result = await request(`api/sites/${site.id}`, { method: 'PUT', headers: CHANGE, body: JSON.stringify(payload) });
  button.removeAttribute('aria-busy');
  if (!result.ok) {
    toast(`Changing ${site.name} failed: ${result.body?.error ?? result.status}`, 'error');
    return;
  }
  Object.assign(site, result.body);
  toast(`${site.name} ${site.enabled ? 'enabled' : 'disabled'}`, 'success');
  renderSites();
  renderScope();
}

function showSiteStats(site) {
  state.scope = String(site.id);
  $('#scope-site').value = state.scope;
  reloadHistory();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function sendTestMail(site) {
  const blocker = testMailBlocker(site);
  if (blocker !== null) {
    toast(`No test mail possible: ${blocker}.`, 'error');
    return;
  }
  toast(`Sending a test mail to ${site.recipient} …`);
  const result = await request(`api/sites/${site.id}/test-mail`, { method: 'POST', headers: CHANGE });
  if (result.ok) {
    toast(`Test mail sent to ${site.recipient}`, 'success');
  }
  else {
    toast(`Test mail failed: ${result.body?.detail ?? result.body?.error ?? result.status}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Site editor
// ---------------------------------------------------------------------------

function originTokens(text) {
  return text.split(/[\s,;]+/).map((t) => t.trim()).filter((t) => t !== '');
}

// "fr: newsletterfr, updatesfr" per line; language and ids are checked by the service
function languageLines(text) {
  const lists = {};
  for (const line of text.split('\n').filter((l) => l.trim() !== '')) {
    const at = line.indexOf(':');
    lists[(at < 0 ? line : line.slice(0, at)).trim()] = at < 0 ? '' : line.slice(at + 1);
  }
  return lists;
}

function languageText(languageLists) {
  return Object.entries(languageLists ?? {}).map(([language, ids]) => `${language}: ${ids.join(', ')}`).join('\n');
}

function updateOriginCount() {
  const tokens = originTokens($('#f-origins').value);
  const unique = new Set(tokens.map((t) => t.toLowerCase().replace(/\/+$/, '')));
  const duplicates = tokens.length - unique.size;
  $('#origins-count').textContent = tokens.length === 0
    ? ''
    : `${unique.size} origin${unique.size === 1 ? '' : 's'}${duplicates > 0 ? ` · ${duplicates} duplicate${duplicates === 1 ? '' : 's'} dropped on save` : ''}`;
}

// For every origin without www, add the www one - parked and sale domains are
// usually reached both ways.
function addWwwVariants() {
  const field = $('#f-origins');
  const tokens = originTokens(field.value);
  const present = new Set(tokens.map((t) => t.toLowerCase().replace(/\/+$/, '')));
  const added = [];
  for (const token of tokens) {
    let url;
    try {
      url = new URL(token);
    }
    catch (e) {
      continue;
    }
    const host = url.hostname;
    if (host.startsWith('www.') || host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) {
      continue;
    }
    const variant = `${url.protocol}//www.${url.host}`;
    if (!present.has(variant)) {
      present.add(variant);
      added.push(variant);
    }
  }
  if (added.length === 0) {
    toast('Every origin already has its www variant');
    return;
  }
  field.value = [...tokens, ...added].join('\n');
  updateOriginCount();
  toast(`${added.length} www variant${added.length === 1 ? '' : 's'} added`, 'success');
}

function clearErrors() {
  for (const node of document.querySelectorAll('#site-form .error')) {
    node.textContent = '';
  }
  for (const node of document.querySelectorAll('#site-form [aria-invalid]')) {
    node.removeAttribute('aria-invalid');
  }
}

function openEditor(site) {
  state.editing = site;
  const form = $('#site-form');
  form.reset();
  clearErrors();
  $('#site-dialog-title').textContent = site === null ? 'New site' : `Edit ${site.name}`;
  form.elements.name.value = site?.name ?? '';
  form.elements.origins.value = [...(site?.origins ?? [])].sort(natural.compare).join('\n');
  form.elements.recipient.value = site?.recipient ?? '';
  form.elements.subjectPrefix.value = site?.subjectPrefix ?? '';
  form.elements.subscriptionUrl.value = site?.subscription?.url ?? '';
  form.elements.subscriptionWorkspace.value = site?.subscription?.workspaceId ?? '';
  form.elements.subscriptionLists.value = site?.subscription?.listIds.join(', ') ?? '';
  form.elements.subscriptionLanguageLists.value = languageText(site?.subscription?.languageLists);
  form.elements.submitPerHour.value = site?.submitPerHour ?? 200;
  form.elements.successUrl.value = site?.successUrl ?? '';
  form.elements.errorUrl.value = site?.errorUrl ?? '';
  form.elements.note.value = site?.note ?? '';
  $('#f-enabled').setAttribute('aria-checked', String(site?.enabled ?? true));
  $('#save-site').textContent = site === null ? 'Create site' : 'Save changes';
  updateOriginCount();
  $('#site-dialog').showModal();
  form.elements.name.focus();
}

async function saveSite(event) {
  event.preventDefault();
  clearErrors();
  const form = event.target;
  const button = $('#save-site');
  const payload = {
    name: form.elements.name.value,
    origins: originTokens(form.elements.origins.value),
    recipient: form.elements.recipient.value,
    subjectPrefix: form.elements.subjectPrefix.value,
    // all empty: no list; the service splits the list ids itself
    subscription: {
      url: form.elements.subscriptionUrl.value,
      workspaceId: form.elements.subscriptionWorkspace.value,
      listIds: form.elements.subscriptionLists.value,
      languageLists: languageLines(form.elements.subscriptionLanguageLists.value),
    },
    submitPerHour: Number(form.elements.submitPerHour.value),
    successUrl: form.elements.successUrl.value,
    errorUrl: form.elements.errorUrl.value,
    note: form.elements.note.value,
    enabled: $('#f-enabled').getAttribute('aria-checked') === 'true',
  };
  const editing = state.editing;
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Saving …';
  const result = await request(editing === null ? 'api/sites' : `api/sites/${editing.id}`, {
    method: editing === null ? 'POST' : 'PUT',
    headers: CHANGE,
    body: JSON.stringify(payload),
  });
  button.disabled = false;
  button.textContent = label;
  if (result.ok) {
    $('#site-dialog').close();
    toast(editing === null ? `Site ${result.body.name} created` : `Site ${result.body.name} saved`, 'success');
    await load({ quiet: true });
    return;
  }
  if (result.body?.error === 'validation') {
    let first = null;
    for (const [field, message] of Object.entries(result.body.fields)) {
      const node = form.querySelector(`.error[data-for="${field}"]`);
      if (node !== null) {
        node.textContent = message;
      }
      const input = form.elements[field];
      if (input !== undefined) {
        input.setAttribute('aria-invalid', 'true');
        first = first ?? input;
      }
    }
    first?.focus();
    return;
  }
  $('#form-error').textContent = `Saving failed: ${result.body?.error ?? result.status}`;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

function openDelete(site) {
  state.deleting = site;
  const origins = site.origins.length === 1 ? site.origins[0] : `${site.origins.length} origins`;
  $('#confirm-text').textContent = `Delete ${site.name}? Forms on ${origins} stop working at once. Its past numbers stay in the totals of "All sites".`;
  $('#confirm-dialog').showModal();
}

async function confirmDelete() {
  const site = state.deleting;
  const result = await request(`api/sites/${site.id}`, { method: 'DELETE', headers: CHANGE });
  $('#confirm-dialog').close();
  if (result.ok) {
    toast(`Site ${site.name} deleted`, 'success');
  }
  else {
    toast(`Deleting failed: ${result.body?.error ?? result.status}`, 'error');
  }
  await load({ quiet: true });
}

// ---------------------------------------------------------------------------
// Embed
// ---------------------------------------------------------------------------

function renderLanguageOptions() {
  const select = $('#embed-language');
  const names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;
  const languageName = (code) => {
    try {
      return names?.of(code) ?? code;
    }
    catch (e) {
      return code;
    }
  };
  const options = [
    el('option', { value: 'auto' }, 'Visitor\'s browser language'),
    el('option', { value: 'en-only' }, 'English only (smaller file)'),
    ...state.status.widgetLanguages.map((code) => el('option', { value: code }, `${languageName(code)} (${code})`)),
  ];
  select.replaceChildren(...options);
  select.value = preference('language', 'auto');
  if (select.value === '') {
    select.value = 'auto';
  }
}

function renderEmbed() {
  const site = state.embedSite;
  const base = publicBase();
  const language = $('#embed-language').value;
  const script = language === 'en-only' ? 'widget.js' : 'widget.i18n.js';
  const languageAttribute = language === 'auto' || language === 'en-only' ? '' : ` language="${language}"`;
  const widgetTag = `<altcha-widget challenge="${base}/challenge"${languageAttribute}></altcha-widget>`;
  const scriptTag = `<script type="module" src="${base}/${script}"></script>`;
  const honeypot = `  <input name="${state.status.honeypotField}" tabindex="-1" autocomplete="off" aria-hidden="true" class="hp">`;
  const honeypotStyle = [
    '',
    '<style>',
    '  /* the honeypot: people never see it, bots fill it in - with a strict CSP move this rule into your stylesheet */',
    '  .hp { position: absolute; left: -10000px; }',
    '</style>',
  ];

  $('#embed-hint').textContent = state.status.publicUrl
    ? `${site.name} · works on ${site.origins.length === 1 ? site.origins[0] : `${site.origins.length} origins`}`
    : 'PUBLIC_URL is not set - replace the placeholder with the public address of this service.';

  if (site.recipient === null) {
    $('#form-note').textContent = 'This site has no "Mail to" address, so /submit is off for it. Add one in the site settings, or use your own backend.';
    $('#code-form').textContent = '';
    $('#code-form').closest('.code').hidden = true;
  }
  else {
    $('#form-note').textContent = site.successUrl
      ? `Mailed to ${site.recipient}. After sending, the visitor lands on ${site.successUrl}.`
      : `Mailed to ${site.recipient}. Without a "Page after sending" a plain form shows the JSON answer - set one in the site settings, or send the form with fetch.`;
    $('#code-form').closest('.code').hidden = false;
    $('#code-form').textContent = [
      scriptTag,
      '',
      `<form action="${base}/submit" method="post">`,
      '  <input name="name" required>',
      '  <input name="email" type="email" required>',
      '  <input name="subject">',
      '  <textarea name="message" required></textarea>',
      honeypot,
      `  ${widgetTag}`,
      '  <button type="submit">Send</button>',
      '</form>',
      ...honeypotStyle,
    ].join('\n');
  }

  const subscription = site.subscription;
  $('#subscribe-note').hidden = subscription === null;
  $('#code-subscribe').closest('.code').hidden = subscription === null;
  if (subscription === null) {
    $('#code-subscribe').textContent = '';
  }
  else {
    const languages = Object.keys(subscription.languageLists);
    $('#subscribe-note').textContent = `Newsletter form: the address goes to the list ${subscription.listIds.join(', ')} in the workspace `
      + `${subscription.workspaceId}${languages.length > 0 ? `, with the language ${languages.join(', ')} to the lists set for it` : ''}; `
      + 'name and language are optional. With double opt-in, Notifuse mails the confirmation link.';
    $('#code-subscribe').textContent = [
      scriptTag,
      '',
      `<form action="${base}/subscribe" method="post">`,
      '  <input name="email" type="email" required>',
      '  <input name="name">',
      '  <input name="language" type="hidden" value="en">',
      honeypot,
      `  ${widgetTag}`,
      '  <button type="submit">Subscribe</button>',
      '</form>',
      ...honeypotStyle,
    ].join('\n');
  }

  $('#code-widget').textContent = [
    scriptTag,
    '',
    '<form action="/your-endpoint" method="post">',
    '  <!-- your fields -->',
    `  ${widgetTag}`,
    '  <button type="submit">Send</button>',
    '</form>',
  ].join('\n');

  $('#code-verify').textContent = [
    `curl -X POST ${base}/verify \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -d '{"altcha": "<value of the altcha field>", "site": "${site.name}"}'`,
    '',
    `# 200 {"ok":true,"verified":true,"site":"${site.name}"}`,
    '# 403 {"ok":false,"error":"<reason>"}   - refuse the form',
  ].join('\n');

  const origin = new URL(base).origin;
  $('#code-csp').textContent = [
    `script-src  'self' ${origin}`,
    `connect-src 'self' ${origin}`,
    "worker-src  'self' blob:",
    ...(site.recipient === null && site.subscription === null ? [] : [`form-action 'self' ${origin}`]),
  ].join('\n');
}

function selectTab(tab) {
  for (const other of document.querySelectorAll('#embed-dialog [role="tab"]')) {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    other.tabIndex = selected ? 0 : -1;
    $('#' + other.getAttribute('aria-controls')).hidden = !selected;
  }
}

function openEmbed(site) {
  state.embedSite = site;
  renderEmbed();
  selectTab($('#tab-form'));
  $('#embed-dialog').showModal();
}

async function copy(targetId) {
  try {
    await navigator.clipboard.writeText($('#' + targetId).textContent);
    toast('Copied to the clipboard', 'success');
  }
  catch (e) {
    toast('Copying is not allowed here - select the text instead', 'error');
  }
}

// ---------------------------------------------------------------------------
// Theme, radios, wiring
// ---------------------------------------------------------------------------

const THEMES = ['system', 'light', 'dark'];
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };

function applyTheme(theme) {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
  }
  else {
    document.documentElement.dataset.theme = theme;
  }
  const button = $('#theme');
  button.replaceChildren(icon(THEME_ICON[theme]));
  button.setAttribute('aria-label', `Theme: ${theme}`);
  button.title = `Theme: ${theme} - click to change`;
}

function setRadio(group, attribute, value) {
  for (const button of group.querySelectorAll('[role="radio"]')) {
    button.setAttribute('aria-checked', String(button.dataset[attribute] === value));
  }
}

function wireRadios(group, attribute, onChange) {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('[role="radio"]');
    if (button !== null) {
      setRadio(group, attribute, button.dataset[attribute]);
      onChange(button.dataset[attribute]);
    }
  });
  group.addEventListener('keydown', (event) => {
    const buttons = [...group.querySelectorAll('[role="radio"]')];
    const current = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      const next = buttons[(current + step + buttons.length) % buttons.length];
      next.focus();
      next.click();
    }
  });
}

// A background refresh leaves the site list alone while the focus is in it - a
// re-render would pull the focus away from the button the user is on.
function renderAll({ background = false } = {}) {
  renderHeader();
  renderUpdated();
  renderNotices();
  renderScope();
  renderKpis();
  renderActivity();
  renderReasons();
  if (!(background && $('#sites').contains(document.activeElement))) {
    renderSites();
  }
  renderSettings();
  if ($('#embed-language').options.length === 0) {
    renderLanguageOptions();
  }
}

function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  let theme = preference('theme', 'system');
  applyTheme(THEMES.includes(theme) ? theme : 'system');
  $('#theme').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    remember('theme', theme);
    applyTheme(theme);
  });

  chart = new LineChart($('#activity-chart'), {
    series: SERIES,
    formatTick: tickFormatter(),
    formatRange: rangeFormatter(),
    describe: describeChart,
  });

  setRadio($('#range'), 'range', state.range);
  wireRadios($('#range'), 'range', (range) => {
    state.range = range;
    remember('range', range);
    reloadHistory();
  });
  $('#scope-site').addEventListener('change', (event) => {
    state.scope = event.target.value;
    reloadHistory();
  });
  $('#table-toggle').addEventListener('click', (event) => {
    state.showTable = !state.showTable;
    event.currentTarget.setAttribute('aria-pressed', String(state.showTable));
    event.currentTarget.querySelector('span').textContent = state.showTable ? 'Chart' : 'Table';
    renderActivity();
  });

  $('#search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderSites();
  });
  wireRadios($('#state-filter'), 'state', (value) => {
    state.stateFilter = value;
    renderSites();
  });
  $('#sort').value = state.sort;
  $('#sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    remember('sort', state.sort);
    renderSites();
  });

  $('#new-site').addEventListener('click', () => openEditor(null));
  $('#refresh').addEventListener('click', () => load());
  $('#site-form').addEventListener('submit', saveSite);
  $('#f-origins').addEventListener('input', updateOriginCount);
  $('#add-www').addEventListener('click', addWwwVariants);
  $('#f-enabled').addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true'));
  });
  $('#confirm-ok').addEventListener('click', confirmDelete);
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', () => copy(button.dataset.copy));
  }
  closeOnBackdrop($('#embed-dialog'));
  closeOnBackdrop($('#confirm-dialog'));

  const tabs = [...document.querySelectorAll('#embed-dialog [role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (step !== undefined) {
        const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
        selectTab(next);
        next.focus();
      }
    });
  }
  $('#embed-language').addEventListener('change', (event) => {
    remember('language', event.target.value);
    renderEmbed();
  });

  // "/" jumps to the search, unless the user is typing somewhere
  document.addEventListener('keydown', (event) => {
    const typing = event.target.closest('input, textarea, select, [contenteditable]');
    if (event.key === '/' && !typing && document.querySelector('dialog[open]') === null) {
      event.preventDefault();
      $('#search').focus();
    }
  });

  // background refresh, paused while the tab is hidden or a dialog is open
  setInterval(() => {
    if (!document.hidden && document.querySelector('dialog[open]') === null) {
      load({ quiet: true });
    }
  }, REFRESH_MS);
  setInterval(renderUpdated, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.loadedAt !== null && Date.now() - state.loadedAt > REFRESH_MS) {
      load({ quiet: true });
    }
  });

  load();
});
