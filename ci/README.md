# CI workflow

`github-actions-ci.yml` is the CI pipeline: typecheck, lint, and the test
suite against ephemeral Postgres + Neon-wsproxy service containers.

It lives here rather than in `.github/workflows/` because the token used to
push this branch lacks GitHub's `workflow` scope, which is required to create
or modify workflow files. To activate it:

```bash
mkdir -p .github/workflows
cp ci/github-actions-ci.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml && git commit -m "ci: add test pipeline"
git push
```

That push needs a token with `workflow` scope — `gh auth refresh -s workflow`
if you use the GitHub CLI.

No database secret is needed. The test-database guard rejects any URL that is
not a disposable test target, so a leaked credential would not help an
attacker and a real one would simply fail the run.
