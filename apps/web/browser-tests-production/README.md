# Production browser acceptance

Run this test only after the Official matrix is published. Supply the exact production origin and
the identity from the accepted result package and verifier attestation:

```sh
AIQ_PRODUCTION_ORIGIN='https://aiq.wiki' \
AIQ_PRODUCTION_EXPECTED_BENCHMARK_VERSION='<benchmark-version>' \
AIQ_PRODUCTION_EXPECTED_SCORING_VERSION='<scoring-version>' \
AIQ_PRODUCTION_EXPECTED_MATRIX_BATCH_ID='<run_sha256-id>' \
AIQ_PRODUCTION_EXPECTED_RUNNER_COMMIT='<git-commit>' \
AIQ_PRODUCTION_EXPECTED_CORPUS_RELEASE_ID='<corpus-release-id>' \
AIQ_PRODUCTION_EXPECTED_CORPUS_COMMITMENT='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_CATALOG_DIGEST='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_TASK_SET_DIGEST='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_PROMPT_SET_DIGEST='<sha256-digest>' \
AIQ_PRODUCTION_EXPECTED_ESTIMATED_COST_RESULT_COUNT='<count>' \
AIQ_PRODUCTION_EXPECTED_UNAVAILABLE_CONTEXT_BAND_RESULT_COUNT='<count>' \
AIQ_PRODUCTION_EXPECTED_UNAVAILABLE_MISSING_USAGE_RESULT_COUNT='<count>' \
AIQ_PRODUCTION_EXPECTED_PRICED_COST_SUBTOTAL_USD_NANOS='<integer-nanodollars>' \
npm run test:browser:production --workspace @aiq/web
```

The command does not start a local server and does not use secrets. The browser blocks non-read
requests. The test fails unless the public site contains exactly 17 Official configurations, 17
configuration runs, and 1,224 task results. It also checks the public method, trend, radar,
duration, token, API-equivalent cost, signed matrix-batch, shared run-provenance evidence, and the
exact expected publication identity, matrix-batch ID, runner commit, cost-status distribution,
and priced nanodollar subtotal. This is a launch
acceptance gate for one matrix. The gate also checks production readiness,
unauthenticated write rejection, mobile layout, and selected Axe accessibility rules. It fails if
later runs exist until the release contract is deliberately revised. Prompt-set and task-set
digests are separate launch commitments.

Use the local published-data mock to validate the acceptance contract without a production read:

```sh
npm run test:browser:production-contract --workspace @aiq/web
```
