# CI workflow

`github-actions-ci.yml` is a mirror of `.github/workflows/ci.yml` — typecheck,
lint, and the test suite against the dedicated Neon `test` branch (project
`KLH Canteen`, database `klh_canteen_test`), kept in sync in this directory as
a backup copy. If they ever diverge, `.github/workflows/ci.yml` is the one
GitHub Actions actually runs.

The `TEST_DATABASE_URL` repository secret holds that branch's connection
string. A leaked or misconfigured secret still can't point CI at production:
`tests/setup/databaseGuard.ts` independently rejects any URL whose database
name doesn't contain "test", whose identity matches `.env`/`.env.production`,
or that lacks the physical marker table the suite itself creates.
