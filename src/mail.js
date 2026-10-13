// Builds the mail for a form submission. Subject and body go out base64 encoded: that
// settles line length, dot stuffing and character sets at once, and no visitor input
// ever reaches a header in readable form. Reply-To is the one exception, and only
// after a strict address check.

import crypto from 'node:crypto';
import { MAIL_ADDRESS } from './config.js';

const CONTROL = /[\u0000-\u001f\u007f]/g;
const MAX_SUBJECT = 200;
// what MAIL_ADDRESS allows before the @, on both sides - masks rather too much than too little
const ADDRESS = /[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+/g;

// Error texts of the mail server and of Notifuse go to the log - an address in them, maybe
// the visitor's, does not.
export function withoutAddresses(text) {
  return String(text).replace(ADDRESS, '<address>');
}

// RFC 2047 caps an encoded word at 75 characters; longer text becomes several words
// on folded lines. Splitting by characters keeps multi-byte sequences whole.
export function encodeHeader(value) {
  const words = [];
  let chunk = '';
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk !== '' || words.length === 0) {
    words.push(chunk);
  }
  return words.map((w) => '=?UTF-8?B?' + Buffer.from(w, 'utf8').toString('base64') + '?=').join('\r\n ');
}

function wrap(base64) {
  return base64.replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}

function rfc5322Date(date) {
  return date.toUTCString().replace(/GMT$/, '+0000');
}

export function replyToFrom(fields) {
  const email = String(fields.email ?? '').trim();
  return MAIL_ADDRESS.test(email) ? email : '';
}

export function buildMessage({ smtp, site, origin, fields, now = new Date() }) {
  const subjectText = String(fields.subject ?? '').replace(CONTROL, ' ').trim().slice(0, MAX_SUBJECT) || 'Form submission';
  const lines = [];
  for (const [name, value] of Object.entries(fields)) {
    lines.push(`${name}: ${String(value).replace(/\r\n?/g, '\n')}`);
  }
  lines.push('', '--', `Site: ${site.name}`, `Origin: ${origin}`, `Received: ${now.toISOString()}`);
  const body = lines.join('\n').replace(/\n/g, '\r\n') + '\r\n';

  const domain = smtp.from.split('@')[1];
  const from = smtp.fromName === '' ? smtp.from : `${encodeHeader(smtp.fromName)} <${smtp.from}>`;
  const head = [
    `From: ${from}`,
    `To: ${site.recipient}`,
    `Subject: ${encodeHeader([site.subjectPrefix, subjectText].filter((part) => part !== '').join(' '))}`,
    `Date: ${rfc5322Date(now)}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    `X-Altcha-Site: ${site.name}`,
  ];
  const replyTo = replyToFrom(fields);
  if (replyTo !== '') {
    head.push(`Reply-To: ${replyTo}`);
  }
  return head.join('\r\n') + '\r\n\r\n' + wrap(Buffer.from(body, 'utf8').toString('base64')) + '\r\n';
}
