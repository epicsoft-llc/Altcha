# AGENTS.md — ALTCHA service

Guidance for coding agents working in this repository. User documentation lives in [`README.md`](README.md).

A Docker image: a Node.js service that issues and verifies ALTCHA challenges for many sites, serves the widget,
mails verified form submissions, passes newsletter sign-ups on to Notifuse, and has an admin web UI on a second port.

## Coordinates

| | |
|---|---|
| **Repository** | developed on `gitlab.com/epicsoft-networks/altcha` (branch `develop` → `main`), mirrored to `github.com/epicsoft-llc/altcha` |
| **Images** | `registry.gitlab.com/epicsoft-networks/altcha`, Docker Hub `epicsoft/altcha` |
| **Version** | `version` in `package.json` — the release tag has to match it |
| **Runtime** | Node.js 24 (`node:24-alpine`), ES modules; locally pinned in `.vfox.toml` |
| **Dependencies** | `altcha` (widget file, served as is) and `altcha-lib` (challenge and verification) — nothing else |

## Rules

- **Public repository, MIT.** No internals in any file: no internal hosts, domains, mail addresses, server names,
  vault paths or names of projects that use the service. Examples use `example.com` / `example.org`. Before
  finishing a change, search every published file (`git ls-files` plus new files) for such terms.
- **Everything in English** — code, comments, README, CHANGELOG, log lines, error messages, commit messages.
- **Do not name the AI tool** in files, commit messages or trailers, or merge request texts. The only exception is
  `.gitignore`, which keeps tool-specific local files out of the repository.
- **Never commit, push, merge, rebase or tag** — changes stay in the working tree. Proposed commit messages follow
  Conventional Commits (`feat:`, `fix:`, `ci:`, `docs:`, `refactor:`, `revert:`).
- **Only a human suppresses warnings.** No `eslint-disable`, `// @ts-ignore` or similar — fix the cause or report it.
- **No new dependency without a reason that outweighs it.** The image is scanned; every package is a finding waiting
  to happen. Node's standard library covers HTTP, TLS, SMTP, crypto and SQLite here.
- **Keep this file current** after every architectural change, new variable, CI change or new rule.

## Commands

```bash
npm ci
npm test                    # node --test "test/*.test.js" - in-process, no Docker, a few seconds
npm start                   # needs HMAC_SECRET (>= 32 chars) and a writable DATA_DIR
docker build -t altcha:dev .
```

## Architecture

```
src/
├── server.js       entry point: config, two HTTP servers, shutdown; start() is what the tests call
├── config.js       environment variables, <NAME>_FILE secrets, validation - fails the start with a clear message
├── public.js       public port: /widget.js, /widget.i18n.js, /challenge, /verify, /submit, /subscribe
├── admin.js        admin port: UI, /api/*, /metrics, /healthz, CSRF header
├── auth.js         sign-in on the admin port: proxy header, Basic auth, API token, lockout after failures
├── altcha.js       issue and check challenges (altcha-lib, deterministic mode)
├── store.js        ALL database access (node:sqlite) - sites, origins, spent challenges, hourly statistics, migrations
├── sites.js        validation of a site from the API
├── smtp.js         SMTP client (STARTTLS / TLS / plain, AUTH PLAIN / LOGIN)
├── mail.js         builds the message; withoutAddresses() for error texts on their way to the log
├── ratelimit.js    sliding window in memory
├── stats.js        every event goes here: Prometheus registry + buffered hourly totals in the database, history for the UI
├── metrics.js      counter, gauge, histogram and the text exposition format - no client library
├── http.js         body reading, field parsing, client address, origin
└── healthcheck.js  container HEALTHCHECK
ui/                 admin UI: index.html (icon sprite), app.js, chart.js (SVG line chart), app.css - no framework, no build step
test/               node:test; helpers.js starts the service, an SMTP sink and a newsletter sink in-process
docs/               reference too long for the README: api.md (endpoints, refusal reasons), metrics.md
examples/           prometheus-alerts.yml
```

### Invariants — keep them when changing code

- **A browser request is mapped to a site by `Origin`** (fallback `Referer` origin). Unknown or disabled → refused.
  Only `POST /verify` may come without an origin — from a backend.
- **The site name is inside the signed challenge parameters** (`data.site`). A solution is only accepted for the site
  it was issued for (`altcha_site`).
- **Order in `checkPayload`: verify, then site, then mark as spent.** A failed verification never writes to the store,
  so garbage cannot fill it or burn someone else's challenge. `markChallengeUsed` is one `INSERT OR IGNORE` — atomic
  for two racing submissions.
- **Deterministic mode with a key signature**: verification is two HMACs, whatever `ALTCHA_COST` is. Do not drop the
  key signature secret — verification would fall back to re-deriving the key, which turns `/verify` and `/submit`
  into a CPU sink.
- **The mail recipient comes from the site, never from the request.** No visitor input in a mail header except
  `Reply-To` after `MAIL_ADDRESS` matched; subject and body are base64.
- **The newsletter list comes from the site, never from the request.** `/subscribe` sends Notifuse only `email`, `name`
  and `language`, to the site's workspace and lists - the form's `language` only picks among the site's lists.
  `/submit` and `/subscribe` share `withinLimits` and `fromHuman` (solution, then honeypot) - a new form endpoint goes
  through both.
- **Error texts from outside pass `withoutAddresses()` before the log** - the mail server and Notifuse may repeat an
  address, maybe the visitor's, and the README promises that none reaches the log.
- **Redirect targets (`successUrl`, `errorUrl`) must be on one of the site's origins** — otherwise `/submit` is an
  open redirect.
- **Changing admin requests need `X-Altcha-Admin: 1`** - the CSRF protection for Basic auth and proxy cookies; the admin
  port never answers CORS preflights. Only API-token requests are exempt: a browser never sends a bearer token itself.
- **`/healthz` stays unauthenticated**, everything else on the admin port goes through `auth.js` when a sign-in is
  configured.
- **The proxy header is believed only from `ADMIN_TRUSTED_PROXIES`.** Never read it from any other address, and never
  make the trusted list optional when the header is set - the config refuses to start without it.
- **The lockout is checked before the credentials.** During a lockout nothing is compared, so a correct guess looks
  exactly like a wrong one. Failures count per `rateKey` (IPv6 per /64); behind a trusted proxy per forwarded client.
- **Every rate limit key goes through `rateKey()`** - a raw IPv6 address would let a client rotate through its /64.
- **The admin UI puts API values into the page with `textContent` only.** The CSP is `script-src 'self'` and
  `style-src 'self'`: no inline scripts or handlers, and **no `style` attribute** - dynamic styles go through CSSOM
  (`node.style.setProperty`, `node.style.width = …`), which the CSP allows. `setAttribute('style', …)` is silently
  blocked.
- **Every file in `ui/` is served** under its name (types by extension in `server.js`); a new module needs nothing else.
- **Database access only in `store.js`.** A schema change is a new entry at the end of `MIGRATIONS`, never an edit of
  an existing one. A database newer than the code refuses to start. Numbers bound to SQL arrive as `REAL` - `CAST` where
  integer arithmetic matters (see `statBuckets`).
- **Statistics go through `stats.js`**, never straight to the store: events are buffered and flushed every 30 seconds
  in one transaction, `history()` and `activity()` flush first. Site ids come from `AUTOINCREMENT`, so a new site never
  inherits the numbers of a deleted one; id `0` is "no site".
- **Metric labels are bounded**: routes come from a fixed list (`other` for the rest), reasons are fixed strings, sites
  are configured names. Never put a path, an address or a value from the request into a label.
- **A new refusal reason** goes into the README table and into `REASONS` in `ui/app.js`, or the UI shows the raw code.

## Adding or changing an environment variable

Three places, or it is silently wrong:

1. `Dockerfile` — `ENV` with the default. **Not for a secret itself** (`HMAC_SECRET`, `*_PASSWORD`): only its
   `_FILE` variant is declared, a secret does not belong into an image layer
2. `src/config.js` — parsing and validation (a `_FILE` variant for anything secret)
3. `README.md` — the list of variables; CI publishes the README as the Docker Hub description, which takes at most
   25,000 characters (`uploadReadme` fails above that). Long examples go to `examples/` and are linked

## CI/CD

Pipeline: `.gitlab-ci.yml`

| Job | Trigger | Action |
|---|---|---|
| `test` | every pipeline | `npm ci`, `npm test` in `node:24-alpine` |
| `develop` | branch `develop` | image `:develop` to the GitLab registry |
| `latest` | branch `main` | image `:latest` to GitLab and Docker Hub |
| `release` | tag `X.Y.Z` | fails unless the tag equals `package.json` `version`; images `X.Y.Z`, `X.Y`, `X`, `latest` to both registries |
| `uploadReadme` | branch `main` | README as Docker Hub description |
| `github-release` | tag `X.Y.Z`, after `release` | waits for the tag on GitHub, creates the release from the `CHANGELOG.md` entry |

Images are built for `linux/amd64` and `linux/arm64`. CI variables: `DOCKER_HUB_USER`, `DOCKER_HUB_TOKEN`,
`GITHUB_TOKEN` (masked, protected — so the tags must be protected (`*.*.*`) or the job sees no token).

**GitHub mirror:** a push mirror in the GitLab project settings (Repository → Mirroring repositories) with its own
token — not part of the pipeline. `GITHUB_TOKEN` is only for `github-release`, which waits until the mirror has
pushed the tag.

## Release checklist

- `package.json`: set `version`
- `README.md`: version in the compose example and the tag table
- `CHANGELOG.md`: `## [X.Y.Z] - <date>` — `github-release` takes the notes from exactly that heading
- Tag **without `v`**: `X.Y.Z`
