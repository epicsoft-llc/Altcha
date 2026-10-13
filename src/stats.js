// Everything the service counts, in two places: the Prometheus registry (since the
// process started) and hourly totals per site in the database (history for the
// admin UI). Database writes are buffered and flushed in one transaction.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Counter, Gauge, Histogram, Registry } from './metrics.js';
import { NO_SITE } from './store.js';

const FLUSH_MS = 30000;
const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const RANGES = {
  '24h': { hours: 24, bucketHours: 1 },
  '7d': { hours: 168, bucketHours: 3 },
  '30d': { hours: 720, bucketHours: 24 },
  '90d': { hours: 2160, bucketHours: 24 },
};

function currentHour() {
  return Math.floor(Date.now() / 3600000);
}

export function emptyTotals() {
  return { challenges: 0, verified: 0, sent: 0, rejected: 0, smtpErrors: 0, subscribed: 0, subscribeErrors: 0 };
}

// stored event name -> field of a totals object
function addEvent(totals, event, count) {
  if (event === 'challenge') {
    totals.challenges += count;
  }
  else if (event === 'verified') {
    totals.verified += count;
  }
  else if (event === 'sent') {
    totals.sent += count;
  }
  else if (event === 'smtp_error') {
    totals.smtpErrors += count;
  }
  else if (event === 'subscribed') {
    totals.subscribed += count;
  }
  else if (event === 'subscribe_error') {
    totals.subscribeErrors += count;
  }
  else if (event.startsWith('rejected:')) {
    totals.rejected += count;
  }
}

export class Stats {
  #store;
  #pending = new Map();
  #timer;
  #lag;
  startedAt = new Date();

  constructor({ store, info, collect, log }) {
    this.#store = store;
    this.log = log;
    const registry = new Registry();
    this.registry = registry;
    this.#lag = monitorEventLoopDelay({ resolution: 20 });
    this.#lag.enable();

    registry.register(new Gauge('altcha_build_info', 'Version of the running service and of the bundled widget.', ['version', 'widget', 'node'],
      () => [[{ version: info.version, widget: info.widget, node: process.versions.node }, 1]]));
    registry.register(new Gauge('process_start_time_seconds', 'Start time of the process since unix epoch in seconds.', [],
      () => [[{}, Math.floor(this.startedAt.getTime() / 1000)]]));
    registry.register(new Gauge('process_resident_memory_bytes', 'Resident memory size in bytes.', [],
      () => [[{}, process.memoryUsage().rss]]));
    registry.register(new Gauge('nodejs_heap_used_bytes', 'Heap in use by the JavaScript engine in bytes.', [],
      () => [[{}, process.memoryUsage().heapUsed]]));
    registry.register(new Gauge('process_cpu_seconds_total', 'User and system CPU time spent in seconds.', [], () => {
      const cpu = process.cpuUsage();
      return [[{}, (cpu.user + cpu.system) / 1e6]];
    }));
    registry.register(new Gauge('nodejs_eventloop_lag_seconds', 'Event loop delay since the last scrape, by quantile.', ['quantile'], () => {
      const values = [['0.5', this.#lag.percentile(50)], ['0.99', this.#lag.percentile(99)], ['1', this.#lag.max]]
        .map(([quantile, ns]) => [{ quantile }, Number.isFinite(ns) ? ns / 1e9 : 0]);
      this.#lag.reset();
      return values;
    }));
    registry.register(new Gauge('altcha_sites', 'Configured sites by state.', ['state'], () => {
      const sites = store.listSites();
      return [[{ state: 'enabled' }, sites.filter((s) => s.enabled).length], [{ state: 'disabled' }, sites.filter((s) => !s.enabled).length]];
    }));
    registry.register(new Gauge('altcha_spent_challenges', 'Spent challenges kept until they expire.', [],
      () => [[{}, store.countSpentChallenges()]]));
    registry.register(new Gauge('altcha_database_size_bytes', 'Size of the database including its write-ahead log.', [],
      () => [[{}, store.sizeBytes()]]));
    registry.register(new Gauge('altcha_rate_limiter_keys', 'Client addresses and sites currently tracked by the rate limits.', [],
      () => [[{}, collect.rateLimiterKeys()]]));
    registry.register(new Gauge('altcha_smtp_configured', '1 when SMTP is configured and /submit can deliver.', [],
      () => [[{}, collect.smtpConfigured ? 1 : 0]]));
    registry.register(new Gauge('altcha_admin_auth_enabled', '1 when the admin port requires Basic auth.', [],
      () => [[{}, collect.authEnabled ? 1 : 0]]));

    this.challenges = registry.register(new Counter('altcha_challenges_total', 'Challenges issued.', ['site']));
    this.verifiedCount = registry.register(new Counter('altcha_verified_total', 'Solutions accepted.', ['site', 'endpoint']));
    this.mails = registry.register(new Counter('altcha_mails_sent_total', 'Form submissions delivered by mail.', ['site']));
    this.smtpErrors = registry.register(new Counter('altcha_smtp_errors_total', 'Form submissions the mail server did not accept.', ['site']));
    this.subscriptions = registry.register(new Counter('altcha_subscriptions_total', 'Form submissions passed on to a newsletter list.', ['site']));
    this.subscriptionErrors = registry.register(new Counter('altcha_subscription_errors_total', 'Form submissions the newsletter list did not accept.', ['site']));
    this.rejections = registry.register(new Counter('altcha_rejected_total', 'Requests refused, by reason.', ['site', 'reason']));
    this.lastMail = registry.register(new Gauge('altcha_last_mail_sent_timestamp_seconds', 'Time of the last delivered submission per site.', ['site']));
    this.requests = registry.register(new Counter('altcha_http_requests_total', 'HTTP requests by port, route, method and status.', ['port', 'route', 'method', 'status']));
    this.durations = registry.register(new Histogram('altcha_http_request_duration_seconds', 'Time to answer a request.', ['port', 'route'], SECONDS));
    this.issueTime = registry.register(new Histogram('altcha_challenge_issue_seconds', 'Server time to issue a challenge - one key derivation at ALTCHA_COST.', [], SECONDS));
    this.solveTime = registry.register(new Histogram('altcha_solve_seconds', 'Time the browser needed to solve a challenge, as reported by the widget.', [], [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64]));
    this.challengeAge = registry.register(new Histogram('altcha_challenge_age_seconds', 'Time from issuing a challenge to spending its solution.', [], [5, 15, 30, 60, 120, 300, 600, 1800, 3600]));
    this.smtpTime = registry.register(new Histogram('altcha_smtp_seconds', 'Time of a mail server conversation.', ['outcome'], [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30]));
    this.internalErrors = registry.register(new Counter('altcha_internal_errors_total', 'Unexpected errors, by area.', ['area']));
    this.authFailures = registry.register(new Counter('altcha_admin_auth_refused_total', 'Admin requests refused by the sign-in, by reason.', ['reason']));

    this.#timer = setInterval(() => this.flush(), FLUSH_MS);
    this.#timer.unref();
  }

  #record(site, event) {
    const siteId = site?.id ?? NO_SITE;
    const key = `${currentHour()}|${siteId}|${event}`;
    this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1);
  }

  challenge(site, seconds) {
    this.challenges.inc({ site: site.name });
    this.issueTime.observe({}, seconds);
    this.#record(site, 'challenge');
  }

  verified(site, endpoint, result) {
    this.verifiedCount.inc({ site: site.name, endpoint });
    if (result.solveSeconds !== null) {
      this.solveTime.observe({}, result.solveSeconds);
    }
    this.challengeAge.observe({}, result.ageSeconds);
    this.#record(site, 'verified');
  }

  sent(site, seconds) {
    this.mails.inc({ site: site.name });
    this.lastMail.set({ site: site.name }, Math.floor(Date.now() / 1000));
    this.smtpTime.observe({ outcome: 'sent' }, seconds);
    this.#record(site, 'sent');
  }

  smtpError(site, seconds) {
    this.smtpErrors.inc({ site: site.name });
    this.smtpTime.observe({ outcome: 'failed' }, seconds);
    this.#record(site, 'smtp_error');
  }

  subscribed(site) {
    this.subscriptions.inc({ site: site.name });
    this.#record(site, 'subscribed');
  }

  subscribeError(site) {
    this.subscriptionErrors.inc({ site: site.name });
    this.#record(site, 'subscribe_error');
  }

  rejected(site, reason) {
    this.rejections.inc({ site: site?.name ?? '-', reason });
    this.#record(site, 'rejected:' + reason);
  }

  request(port, route, method, status, seconds) {
    this.requests.inc({ port, route, method, status: String(status) });
    this.durations.observe({ port, route }, seconds);
  }

  error(area) {
    this.internalErrors.inc({ area });
  }

  authFailure(reason) {
    this.authFailures.inc({ reason });
  }

  flush() {
    if (this.#pending.size === 0) {
      return;
    }
    const rows = [...this.#pending].map(([key, count]) => {
      const [hour, siteId, event] = key.split('|');
      return { hour: Number(hour), siteId: Number(siteId), event, count };
    });
    this.#pending.clear();
    try {
      this.#store.addStats(rows);
    }
    catch (e) {
      // put the counts back - the next flush tries again
      for (const row of rows) {
        const key = `${row.hour}|${row.siteId}|${row.event}`;
        this.#pending.set(key, (this.#pending.get(key) ?? 0) + row.count);
      }
      this.error('stats_flush');
      this.log.error(`writing statistics failed: ${e.message}`);
    }
  }

  // History for the admin UI: buckets, totals, the same totals for the period
  // before, and the reasons requests were refused.
  history(rangeName, siteId) {
    this.flush();
    const range = RANGES[rangeName];
    const toHour = currentHour() + 1;
    const fromHour = toHour - range.hours;
    const count = range.hours / range.bucketHours;
    const points = Array.from({ length: count }, (_, i) => ({ t: (fromHour + i * range.bucketHours) * 3600, ...emptyTotals() }));
    const totals = emptyTotals();
    const reasons = {};
    for (const row of this.#store.statBuckets(fromHour, toHour, range.bucketHours, siteId)) {
      addEvent(points[row.bucket], row.event, row.n);
      addEvent(totals, row.event, row.n);
      if (row.event.startsWith('rejected:')) {
        const reason = row.event.slice('rejected:'.length);
        reasons[reason] = (reasons[reason] ?? 0) + row.n;
      }
    }
    const previousTotals = emptyTotals();
    for (const row of this.#store.statBuckets(fromHour - range.hours, fromHour, range.hours, siteId)) {
      addEvent(previousTotals, row.event, row.n);
    }
    // the last bucket ends in the future - it is still filling up
    const partial = Date.now() < toHour * 3600000;
    return { range: rangeName, bucketSeconds: range.bucketHours * 3600, from: fromHour * 3600, to: toHour * 3600, partial, points, totals, previousTotals, reasons };
  }

  // Totals of the last 24 hours and the hour of the last event, per site id.
  activity() {
    this.flush();
    const bySite = new Map();
    for (const row of this.#store.statBySite(currentHour() - 23)) {
      const totals = bySite.get(row.site_id) ?? emptyTotals();
      addEvent(totals, row.event, row.n);
      bySite.set(row.site_id, totals);
    }
    const last = this.#store.lastActivityBySite();
    return { bySite, last };
  }

  purge(retentionDays) {
    return this.#store.purgeStats(currentHour() - retentionDays * 24);
  }

  prometheus() {
    return this.registry.render();
  }

  close() {
    clearInterval(this.#timer);
    this.#lag.disable();
    this.flush();
  }
}
