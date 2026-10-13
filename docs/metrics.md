# Metrics

Part of the [ALTCHA service](../README.md).

`GET /metrics` on the admin port, Prometheus text format, behind Basic auth when that is configured. All counters start at zero with the process.

| Metric | Type | Labels | What it answers |
|---|---|---|---|
| `altcha_challenges_total` | counter | `site` | how many forms were opened |
| `altcha_verified_total` | counter | `site`, `endpoint` (`verify`, `submit`, `subscribe`) | how many solutions were accepted |
| `altcha_mails_sent_total` | counter | `site` | how many submissions were delivered |
| `altcha_smtp_errors_total` | counter | `site` | how many the mail server did not accept |
| `altcha_subscriptions_total` | counter | `site` | how many sign-ups Notifuse accepted |
| `altcha_subscription_errors_total` | counter | `site` | how many it refused or did not answer |
| `altcha_rejected_total` | counter | `site`, `reason` | what was refused and why — `site` is `-` when the request matched no site |
| `altcha_last_mail_sent_timestamp_seconds` | gauge | `site` | when a site last delivered — for "no mail for days" alerts |
| `altcha_http_requests_total` | counter | `port`, `route`, `method`, `status` | traffic and error rates per endpoint; unknown paths are counted as `other` |
| `altcha_http_request_duration_seconds` | histogram | `port`, `route` | latency per endpoint |
| `altcha_challenge_issue_seconds` | histogram | | server time per challenge — what `ALTCHA_COST` costs this machine |
| `altcha_solve_seconds` | histogram | | time the browser needed, as the widget reports it — what `ALTCHA_COST` costs a visitor |
| `altcha_challenge_age_seconds` | histogram | | time from challenge to submission — whether `ALTCHA_EXPIRES` is too short |
| `altcha_smtp_seconds` | histogram | `outcome` (`sent`, `failed`) | mail server latency |
| `altcha_sites` | gauge | `state` (`enabled`, `disabled`) | |
| `altcha_spent_challenges` | gauge | | spent challenges kept until they expire |
| `altcha_database_size_bytes` | gauge | | database plus write-ahead log |
| `altcha_rate_limiter_keys` | gauge | | addresses and sites the rate limits currently track |
| `altcha_smtp_configured`, `altcha_admin_auth_enabled` | gauge | | configuration at a glance |
| `altcha_internal_errors_total` | counter | `area` | unexpected errors — should stay at zero |
| `altcha_admin_auth_refused_total` | counter | `reason` | refused sign-ins on the admin port - `invalid_credentials`, `invalid_token` and `too_many_failures` are worth an alert |
| `altcha_build_info` | gauge | `version`, `widget`, `node` | |
| `process_start_time_seconds`, `process_resident_memory_bytes`, `process_cpu_seconds_total`, `nodejs_heap_used_bytes` | gauge | | the process |
| `nodejs_eventloop_lag_seconds` | gauge | `quantile` (`0.5`, `0.99`, `1`) | event loop delay since the last scrape |

Alerting rules to start from - failing mail or newsletter, a site gone quiet, many refusals, slow solving, failed sign-ins, internal errors: [`examples/prometheus-alerts.yml`](../examples/prometheus-alerts.yml).
