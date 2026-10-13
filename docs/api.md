# API reference

Part of the [ALTCHA service](../README.md). Both ports speak JSON.

## Public port

| Route | Purpose |
|---|---|
| `GET /widget.js` | the ALTCHA widget (ES module, English) |
| `GET /widget.i18n.js` | the widget with all translations |
| `GET /challenge` | a new challenge for the site of the `Origin` |
| `POST /verify` | check a solution, from a browser or a backend |
| `POST /submit` | check a solution and mail the form to the site's recipient |
| `POST /subscribe` | check a solution and pass `email`, `name` and `language` on to the site's newsletter list |

Bodies are accepted as `application/x-www-form-urlencoded` or `application/json` (flat, no nested objects), up to `MAX_BODY_BYTES`. `multipart/form-data` — and with it file uploads — is refused.

### Refusals

Reasons a request is refused, as `error` in the answer and as `reason` in the metrics:

| Reason | Meaning |
|---|---|
| `route_unknown` | no such endpoint |
| `origin_unknown` | the page is not listed for any site |
| `site_disabled` | the page belongs to a site that is switched off |
| `site_unknown` | `/verify` named a site that does not exist or is disabled, or the solution belongs to a site that was deleted or disabled since |
| `submit_disabled` | the site has no recipient, or SMTP is not configured |
| `subscribe_disabled` | the site has no newsletter list |
| `email_invalid` | `/subscribe` without a plain address in `email` - checked before the solution is spent |
| `altcha_missing`, `altcha_malformed` | no solution, or not one this service can read |
| `altcha_algorithm` | the challenge uses another algorithm than `ALTCHA_ALGORITHM` |
| `altcha_signature` | the challenge was not issued by this service, or was altered |
| `altcha_expired` | the challenge is older than `ALTCHA_EXPIRES` |
| `altcha_solution` | the solution does not solve the challenge |
| `altcha_site` | the solution was issued for another site |
| `altcha_replay` | the solution was spent before |
| `rate_challenge`, `rate_ip`, `rate_site` | a rate limit was hit |
| `body_too_large`, `body_malformed`, `body_incomplete`, `too_many_fields`, `unsupported_media_type` | the request body |
| `delivery_failed` | the mail server did not accept the mail, or Notifuse the sign-up |
| `honeypot` | metrics only — the client is told it succeeded |

## Admin port

Every request needs a sign-in when one is configured - see *Signing in* in the README.

| Route | |
|---|---|
| `GET /` | the web UI |
| `GET /api/status` | version, settings (without secrets), widget languages |
| `GET /api/stats?range=<range>&site=<id>` | history: totals per period, the same totals for the period before, refused requests by reason. `range` is `24h`, `7d`, `30d` or `90d`; without `site` for all sites, `site=0` for requests that matched no site |
| `GET /api/sites`, `POST /api/sites` | list (with the activity of the last 24 hours), create |
| `GET`, `PUT`, `DELETE /api/sites/<id>` | read, replace, delete |
| `POST /api/sites/<id>/test-mail` | send a test mail to the site's recipient |
| `GET /metrics` | Prometheus metrics |
| `GET /healthz` | `200 ok` when the database answers — **without authentication**, for the container health check |

Every changing request needs the header `X-Altcha-Admin: 1` - except one signed in with the API token. A browser sends Basic credentials and proxy session cookies along with any request to the port, also one triggered by a foreign page; a custom header cannot be set by such a page without a CORS preflight, which the admin port never grants. A bearer token, on the other hand, is never sent by a browser on its own.

A site as the API takes it:

```json
{
  "name": "example",
  "origins": ["https://example.com", "https://www.example.com"],
  "recipient": "office@example.com",
  "subscription": { "url": "http://notifuse:8080", "workspaceId": "example", "listIds": ["newsletter"], "languageLists": { "fr": ["newsletterfr"] } },
  "subjectPrefix": "[example.com]",
  "submitPerHour": 200,
  "successUrl": "https://example.com/thanks",
  "errorUrl": "https://example.com/contact",
  "enabled": true,
  "note": ""
}
```

`recipient` switches `/submit` on, `subscription` switches `/subscribe` on; a site can have both, one or none. `subscription` is `null` or complete: the base address of a Notifuse instance (http or https, no query), the workspace id and one to ten list ids, which may also come as one string separated by commas or spaces. Ids are letters and digits, at most 32 characters - what Notifuse accepts. `languageLists` is optional: per language tag (`de`, `de-at`, `es-419` or `zh-hant`, at most 30) one to ten other list ids. A sign-up whose `language` is listed there goes to those lists instead, a longer tag without lists of its own to those of a shorter one (`zh-hant-tw`, then `zh-hant`, then `zh`); the form chooses among the site's lists, never a list of its own. Errors name the field: `subscriptionUrl`, `subscriptionWorkspace`, `subscriptionLists`, `subscriptionLanguageLists`.

The name is part of every challenge: renaming a site invalidates the challenges already handed out for it, which costs a visitor at most one more click on the widget. There is no limit on the number of origins - a landing page served under a hundred parked domains is one site with two hundred origins; the editor adds the `www.` variants with one click.

```bash
curl -H "Authorization: Bearer $TOKEN" https://admin.altcha.example.com/api/sites
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"example","origins":["https://example.com"],"recipient":"office@example.com"}' \
  https://admin.altcha.example.com/api/sites
```
