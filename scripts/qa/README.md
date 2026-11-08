# TP browser acceptance

Uses the installed TP Playwright runtime, with no new application dependency.
Run only against an isolated local Eagleye instance with synthetic data.

```bash
node scripts/qa/seed.cjs "$PWD/.gstack/qa-reports/my-run/acceptance.db"
DOTENV_CONFIG_PATH=/dev/null EAGLEYE_DB_PATH="$PWD/.gstack/qa-reports/my-run/acceptance.db" EAGLEYE_HOST=127.0.0.1 RESEND_API_KEY='' node server.js 18766
# In a second terminal:
tp-browser-test run --config scripts/qa/playwright.config.cjs
```

The seeder refuses existing databases and paths outside `.gstack/qa-reports`.
It creates two disposable users, eight articles, summaries and signal scores.
The synthetic password in the suite is not a production credential.
No collection, model generation or outbound email is triggered. The application
uses its real routes, authentication, database and frontend. The failure test
intercepts only its own browser's search request to return HTTP 503.

The suite covers desktop and mobile routes, login/logout, bookmarks and JSON
export, search and literal HTML input, network failure recovery, admin denial,
private-file routing, registration service failure and preference persistence.
The local report is `.gstack/qa-reports/tp-20261108/report/index.html`.
Set `TP_QA_REPORT_DIR` to a new absolute directory to preserve previous reports.
Without it, repeating a run overwrites the default report directory.
Set `TP_BASE_URL` for a different isolated port and `TP_BROWSER_ROOT` for a
different installation directory. Close the local server after testing.
