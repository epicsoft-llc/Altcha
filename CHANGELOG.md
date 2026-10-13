# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
the versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

| Part | Raised when |
|---|---|
| **MAJOR** | an existing setup stops working — a removed or renamed variable, a changed endpoint or answer |
| **MINOR** | something is added without requiring a change to an existing setup. Before `1.0.0` any release may break; the entry says so |
| **PATCH** | a fix or a dependency update without a change in behaviour |

**A release is a git tag `X.Y.Z`** that matches `version` in `package.json`. CI builds `X.Y.Z`, `X.Y`, `X`
from it, moves `latest` and creates the GitHub release from the entry below.

## [0.2.0] - 2026-10-13

### Added

- `POST /subscribe` passes a verified newsletter sign-up on to a list in Notifuse: address, name and language, to the
  workspace and lists set for the site. Notifuse sends the double opt-in mail. An invalid address is refused before the
  solution is spent
- Site setting `subscription` (Notifuse address, workspace id, list ids) in the API and the site editor - a site can
  have a mail recipient, a newsletter list or both. Optional lists per language: a sign-up goes to the lists of the
  language tag the form sends or of a shorter one (`es-419` to `es`), else to the site's lists. Workspace and list ids
  are letters and digits, as Notifuse takes them
- Refusal reasons `subscribe_disabled` and `email_invalid`; `delivery_failed` also stands for a sign-up Notifuse refused
- Metrics `altcha_subscriptions_total` and `altcha_subscription_errors_total`, endpoint `subscribe` in
  `altcha_verified_total`, the example alert `AltchaNewsletterFailing`
- Admin UI: sign-ups in the statistics and the site list, mail and newsletter failures together as "Delivery errors",
  a newsletter form in the embed code

### Changed

- `/api/stats` and the site activity carry `subscribed` and `subscribeErrors`
- The database gets four columns for the newsletter list. An older version refuses to start on it - take a backup
  before upgrading

### Fixed

- Error texts of the mail server reach the log without mail addresses, as the README promises - for form submissions
  and the test mail

## [0.1.1] - 2026-10-09

### Changed

- The epicsoft card in the admin UI: the epicsoft logo on the link to epicsoft.one, "Source code" leads to the GitHub
  mirror, shorter wording.

## [0.1.0] - 2026-10-09

### Added

- The admin UI presents epicsoft LLC: "by epicsoft" in the header and a card at the end of the page, with links to
  epicsoft.one and the source code.

## [0.0.1] - 2026-10-08

First release.

### Added
- `GET /challenge`: ALTCHA challenges in the v3 format (PBKDF2 or SHA), deterministic mode, signed with HMAC, bound
  to the site of the requesting origin
- `POST /verify` for browsers and for backends, `POST /submit` to mail a verified form to the site's recipient
- Each solution is spent once; spent challenges are kept in the database until they expire
- `GET /widget.js` and `GET /widget.i18n.js` serve the ALTCHA widget 3.3.0, in English or with all its languages
- Sign-in on the admin port, in any combination: user name from a signing-in reverse proxy (only from
  `ADMIN_TRUSTED_PROXIES`, optionally limited to `ADMIN_ALLOWED_USERS`), Basic auth, API token for scripts. After
  10 failed attempts an address is locked out for 15 minutes
- Rate limits count IPv6 clients per /64; verifications from a backend have their own limit (`RATE_VERIFY_PER_IP`)
- Database files are created with mode `0600`; the container runs with a read-only root file system
- Admin web UI on a separate port:
  - statistics for 24 hours to 90 days, for all sites or one: totals against the period before, activity chart with
    table view, refused requests by reason
  - sites with any number of origins: search, filter, sort, switch on and off in the list, edit, delete, test mail,
    embed code with a choice of widget language and the matching Content Security Policy
  - light and dark theme, phone layout, refreshes itself every 30 seconds
- Statistics kept as hourly totals per site (`STATS_RETENTION_DAYS`, default 90)
- Prometheus metrics: requests and latency per endpoint, solve time and challenge age, mail delivery, database size,
  process and event loop
- Rate limits per client address and per site, honeypot field, optional redirect pages for plain HTML forms
- SMTP with STARTTLS, implicit TLS or plain, `AUTH PLAIN` and `AUTH LOGIN`
- SQLite database in `/data`, container health check
