// Entry point: two HTTP servers on one process - the public port for widgets and
// forms, the admin port for the UI. Nothing on the public port can change a site.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminHandler } from './admin.js';
import { createAltcha } from './altcha.js';
import { ConfigError, loadConfig } from './config.js';
import { sendJson } from './http.js';
import { createPublicHandler } from './public.js';
import { RateLimiter } from './ratelimit.js';
import { createMailer } from './smtp.js';
import { Stats } from './stats.js';
import { Store } from './store.js';

const ROOT = new URL('../', import.meta.url);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const PUBLIC_ROUTES = new Set(['/widget.js', '/widget.i18n.js', '/challenge', '/verify', '/submit', '/subscribe']);
const ADMIN_ROUTES = [
  [/^\/api\/sites\/\d+\/test-mail$/, '/api/sites/:id/test-mail'],
  [/^\/api\/sites\/\d+$/, '/api/sites/:id'],
  [/^\/(api\/(status|stats|sites)|metrics|healthz)$/, null],
];

function readJsonFile(relative) {
  return JSON.parse(fs.readFileSync(new URL(relative, ROOT), 'utf8'));
}

// Every file in ui/ is served under its own name; index.html also as '/'.
function loadAssets() {
  const version = readJsonFile('package.json').version;
  const widgetVersion = readJsonFile('node_modules/altcha/package.json').version;
  const widget = (file) => ({
    body: fs.readFileSync(new URL(`node_modules/altcha/dist/main/${file}`, ROOT)),
    etag: `"altcha-${widgetVersion}-${file}"`,
  });
  const ui = new Map();
  const uiDir = new URL('ui/', ROOT);
  for (const file of fs.readdirSync(uiDir)) {
    const type = TYPES[path.extname(file)];
    if (type !== undefined) {
      const asset = { body: fs.readFileSync(new URL(file, uiDir)), type };
      ui.set('/' + file, asset);
      if (file === 'index.html') {
        ui.set('/', asset);
      }
    }
  }
  // the language bundles of the widget; regional collections like 'europe' are not languages
  const regions = new Set(['all', 'africa', 'americas', 'asia', 'europe']);
  const widgetLanguages = fs.readdirSync(new URL('node_modules/altcha/dist/i18n/', ROOT))
    .filter((file) => file.endsWith('.js') && !file.endsWith('.umd.js'))
    .map((file) => file.slice(0, -3))
    .filter((code) => !regions.has(code))
    .sort();
  return {
    version,
    widgetVersion,
    widgetLanguages,
    widgets: new Map([
      ['/widget.js', widget('altcha.min.js')],
      ['/widget.i18n.js', widget('altcha.i18n.min.js')],
    ]),
    ui,
  };
}

export const consoleLog = {
  info: (message) => console.log(`[altcha] ${message}`),
  error: (message) => console.error(`[altcha] ${message}`),
};

// A fixed set of route labels, so a scanner cannot grow the metrics with made-up paths.
function routeLabel(port, pathname, uiAssets) {
  if (port === 'public') {
    return PUBLIC_ROUTES.has(pathname) ? pathname : 'other';
  }
  if (uiAssets.has(pathname)) {
    return 'ui';
  }
  for (const [pattern, label] of ADMIN_ROUTES) {
    if (pattern.test(pathname)) {
      return label ?? pathname;
    }
  }
  return 'other';
}

function wrap(port, handler, { log, stats, uiAssets }) {
  return (req, res) => {
    const started = performance.now();
    res.on('finish', () => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      stats.request(port, routeLabel(port, pathname, uiAssets), req.method, res.statusCode, (performance.now() - started) / 1000);
    });
    handler(req, res).catch((e) => {
      stats.error(`${port}_handler`);
      log.error(e.stack ?? String(e));
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
      else {
        res.destroy();
      }
    });
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

export async function start(config, log = consoleLog) {
  const store = new Store(config.dataDir);
  const assets = loadAssets();
  const mailer = config.smtp === null ? null : createMailer(config.smtp);
  const altcha = createAltcha(config.altcha, config.hmacSecret);
  const limiter = new RateLimiter();
  const stats = new Stats({
    store,
    log,
    info: { version: assets.version, widget: assets.widgetVersion },
    collect: {
      rateLimiterKeys: () => limiter.size,
      smtpConfigured: config.smtp !== null,
      authEnabled: config.admin.enabled,
    },
  });

  const context = { log, stats, uiAssets: assets.ui };
  const publicServer = http.createServer(wrap('public', createPublicHandler({
    config, store, altcha, limiter, stats, mailer, widgets: assets.widgets, log,
  }), context));
  const adminServer = http.createServer(wrap('admin', createAdminHandler({
    config, store, stats, mailer, assets, log,
  }), context));
  for (const server of [publicServer, adminServer]) {
    server.headersTimeout = 10000;
    server.requestTimeout = 30000;
  }

  // A failure here must not end the process - the next round tries again.
  let rounds = 0;
  const purge = setInterval(() => {
    try {
      store.purgeExpiredChallenges(Math.floor(Date.now() / 1000));
      if (rounds % 60 === 0) {
        stats.purge(config.statsRetentionDays);
      }
      rounds += 1;
    }
    catch (e) {
      stats.error('purge');
      log.error(`cleaning up the database failed: ${e.message}`);
    }
  }, 60000);
  purge.unref();

  const port = await listen(publicServer, config.port);
  const adminPort = await listen(adminServer, config.adminPort);
  log.info(`version ${assets.version} (${config.buildTag}), widget ${assets.widgetVersion}`);
  const signIn = [config.admin.proxy ? `proxy header ${config.admin.proxy.header}` : null, config.admin.basic ? 'Basic auth' : null, config.admin.token ? 'API token' : null]
    .filter((m) => m !== null);
  log.info(`public port ${port}, admin port ${adminPort} ${signIn.length === 0 ? 'without authentication' : 'with ' + signIn.join(', ')}`);
  log.info(config.smtp === null ? 'SMTP not configured - /submit is off' : `SMTP ${config.smtp.host}:${config.smtp.port} (${config.smtp.security})`);

  async function close() {
    clearInterval(purge);
    await Promise.all([publicServer, adminServer].map((server) => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    })));
    stats.close();
    store.close();
  }

  return { port, adminPort, store, close };
}

async function main() {
  // the database holds mail addresses: readable for the service user only
  process.umask(0o077);
  let config;
  try {
    config = loadConfig();
  }
  catch (e) {
    if (e instanceof ConfigError) {
      consoleLog.error(`configuration: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const service = await start(config);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      consoleLog.info(`${signal} received, shutting down`);
      service.close().then(() => process.exit(0));
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    consoleLog.error(e.stack ?? String(e));
    process.exit(1);
  });
}
