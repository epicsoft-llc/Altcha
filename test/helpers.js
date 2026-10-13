// Test fixtures: the service in-process on free ports with a temporary data
// directory, an SMTP sink and a newsletter sink that record what they receive.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { loadConfig } from '../src/config.js';
import { start } from '../src/server.js';

// a fixture, not a secret: it exists for the length of one test run
export const TEST_SECRET = 'test-secret-0123456789-0123456789-abcdef';

export const quietLog = { info: () => {}, error: () => {} };

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'altcha-test-'));
}

export function startSmtpSink() {
  const messages = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current = null;
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(current);
            socket.write('250 queued\r\n');
          }
          else {
            current.data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          socket.write('250-sink\r\n250 SIZE 1000000\r\n');
        }
        else if (verb === 'MAIL') {
          current = { from: line, to: [], data: [] };
          socket.write('250 ok\r\n');
        }
        else if (verb === 'RCPT') {
          // a recipient blocked@ is refused with its address in the reply, as mail servers do
          const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (address.startsWith('blocked@')) {
            socket.write(`550 5.1.1 <${address}>: Recipient address rejected\r\n`);
            continue;
          }
          current.to.push(line);
          socket.write('250 ok\r\n');
        }
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        }
        else if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
        }
        else {
          socket.write('502 not implemented\r\n');
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      messages,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

// Stands in for the subscribe endpoint of Notifuse: records every request and refuses
// the list 'closed' the way Notifuse refuses a list that is not public.
export function startNewsletterSink() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ method: req.method, path: req.url, type: req.headers['content-type'], body });
      // 'closed' refuses like a list that is not public, 'echo' repeats the address in its error
      const closed = body.list_ids.includes('closed');
      const echo = body.list_ids.includes('echo');
      res.writeHead(closed || echo ? 400 : 200, { 'Content-Type': 'application/json' });
      const error = closed ? 'list is not public' : `contact ${body.contact.email} is blocked`;
      res.end(JSON.stringify(closed || echo ? { error } : { success: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

export async function startService(env = {}, log = quietLog) {
  const dataDir = tempDir();
  const config = loadConfig({
    HMAC_SECRET: TEST_SECRET,
    PORT: '0',
    ADMIN_PORT: '0',
    DATA_DIR: dataDir,
    // cheap enough to solve in a test, the mechanics are the same
    ALTCHA_COST: '1',
    ALTCHA_COUNTER_MIN: '1',
    ALTCHA_COUNTER_MAX: '20',
    ...env,
  });
  const service = await start(config, log);
  return {
    config,
    base: `http://127.0.0.1:${service.port}`,
    admin: `http://127.0.0.1:${service.adminPort}`,
    store: service.store,
    close: async () => {
      await service.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function solve(challenge) {
  const solution = await solveChallenge({ challenge, deriveKey });
  return Buffer.from(JSON.stringify({ challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution })).toString('base64');
}

export async function createSite(service, site, headers = {}) {
  const response = await fetch(`${service.admin}/api/sites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Altcha-Admin': '1', ...headers },
    body: JSON.stringify(site),
  });
  return { status: response.status, body: await response.json() };
}

export async function fetchChallenge(service, origin) {
  const response = await fetch(`${service.base}/challenge`, { headers: { Origin: origin } });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
