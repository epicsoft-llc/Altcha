// Validation of a site as it comes from the admin API. Everything that later ends up
// in a mail header, a redirect or a CORS header passes through here first - the
// public handler trusts what the database holds.

import { LANGUAGE_TAG, MAIL_ADDRESS } from './config.js';

const NAME = /^[a-z0-9][a-z0-9.-]{0,62}$/;
// workspace and list ids as Notifuse takes them: letters and digits, at most 32
const ID = /^[A-Za-z0-9]{1,32}$/;
const MAX_LANGUAGES = 30;
const CONTROL = /[\u0000-\u001f\u007f]/;

export class ValidationError extends Error {
  constructor(fields) {
    super('validation');
    this.fields = fields;
  }
}

export function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  }
  catch (e) {
    return null;
  }
  const plain = url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !plain) {
    return null;
  }
  return url.origin;
}

function optionalText(errors, field, value, max) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (text.length > max) {
    errors[field] = `at most ${max} characters`;
  }
  else if (CONTROL.test(text)) {
    errors[field] = 'must not contain line breaks or control characters';
  }
  return text;
}

// A redirect target has to point back to the site itself, otherwise /submit is an
// open redirect anyone can put behind a link.
function redirectUrl(errors, field, value, origins) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (text === '') {
    return null;
  }
  let url;
  try {
    url = new URL(text);
  }
  catch (e) {
    errors[field] = 'not a valid URL';
    return null;
  }
  if (!origins.includes(url.origin)) {
    errors[field] = 'has to be on one of the origins of this site';
    return null;
  }
  return url.href;
}

// list ids as an array or as one string separated by commas or spaces
function listIdsOf(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  return [...new Set(raw.map((id) => String(id).trim()).filter((id) => id !== ''))];
}

function validLists(listIds) {
  return listIds.length > 0 && listIds.length <= 10 && listIds.every((id) => ID.test(id));
}

// The newsletter list behind /subscribe: the visitor's address goes to the public subscribe
// endpoint of a Notifuse instance. Address, workspace and lists come from the site, never
// from the request - the service cannot be used to put anyone on another list. The form
// only picks among the site's lists by its language.
function subscription(errors, value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const urlText = String(source.url ?? '').trim();
  const workspaceId = String(source.workspaceId ?? '').trim();
  const listIds = listIdsOf(source.listIds);
  const rawLanguages = source.languageLists ?? {};
  const languageLists = {};
  let languagesValid = typeof rawLanguages === 'object' && !Array.isArray(rawLanguages) && Object.keys(rawLanguages).length <= MAX_LANGUAGES;
  for (const [key, lists] of languagesValid ? Object.entries(rawLanguages) : []) {
    const language = key.trim().toLowerCase();
    const ids = listIdsOf(lists);
    if (LANGUAGE_TAG.test(language) && validLists(ids)) {
      languageLists[language] = ids;
    }
    else {
      languagesValid = false;
    }
  }
  if (urlText === '' && workspaceId === '' && listIds.length === 0 && languagesValid && Object.keys(languageLists).length === 0) {
    return null;
  }
  let url = null;
  try {
    url = new URL(urlText);
  }
  catch (e) {
    url = null;
  }
  const plain = url !== null && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
  if (!plain || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    errors.subscriptionUrl = 'base address of the Notifuse instance, like https://newsletter.example.com';
  }
  if (!ID.test(workspaceId)) {
    errors.subscriptionWorkspace = 'letters and digits, at most 32 characters';
  }
  if (!validLists(listIds)) {
    errors.subscriptionLists = 'one to ten list ids - letters and digits, at most 32 characters each';
  }
  if (!languagesValid) {
    errors.subscriptionLanguageLists = `per language tag like de, de-at or es-419 one to ten list ids, at most ${MAX_LANGUAGES} languages`;
  }
  return { url: plain ? `${url.origin}${url.pathname}`.replace(/\/+$/, '') : '', workspaceId, listIds, languageLists };
}

export function validateSite(input) {
  const errors = {};
  const source = input !== null && typeof input === 'object' ? input : {};

  const name = String(source.name ?? '').trim().toLowerCase();
  if (!NAME.test(name)) {
    errors.name = 'lowercase letters, digits, dot and dash, starting with a letter or digit, at most 63 characters';
  }

  const origins = [];
  const rawOrigins = Array.isArray(source.origins) ? source.origins : [];
  for (const raw of rawOrigins) {
    const origin = normalizeOrigin(raw);
    if (origin === null) {
      errors.origins = `'${String(raw).slice(0, 80)}' is not an origin - scheme and host only, like https://example.com`;
      break;
    }
    if (!origins.includes(origin)) {
      origins.push(origin);
    }
  }
  if (!errors.origins && origins.length === 0) {
    errors.origins = 'at least one origin';
  }

  const recipientText = String(source.recipient ?? '').trim();
  if (recipientText !== '' && !MAIL_ADDRESS.test(recipientText)) {
    errors.recipient = 'not a plain mail address';
  }

  const submitPerHour = Number(source.submitPerHour ?? 200);
  if (!Number.isInteger(submitPerHour) || submitPerHour < 1 || submitPerHour > 100000) {
    errors.submitPerHour = 'a whole number between 1 and 100000';
  }

  const site = {
    name,
    origins,
    recipient: recipientText === '' ? null : recipientText,
    subscription: subscription(errors, source.subscription),
    subjectPrefix: optionalText(errors, 'subjectPrefix', source.subjectPrefix, 100),
    successUrl: redirectUrl(errors, 'successUrl', source.successUrl, origins),
    errorUrl: redirectUrl(errors, 'errorUrl', source.errorUrl, origins),
    submitPerHour,
    enabled: source.enabled === undefined ? true : source.enabled === true,
    note: optionalText(errors, 'note', source.note, 500),
  };

  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors);
  }
  return site;
}
